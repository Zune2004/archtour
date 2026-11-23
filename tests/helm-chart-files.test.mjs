import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/cli.mjs");
const HELM_OK = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
const SKIP_HELM = HELM_OK ? false : "helm not installed";

function gitInitRepo(dir) {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: dir });
  spawnSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
}

function gitCommitAll(dir, message) {
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", message], { cwd: dir, encoding: "utf8" });
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `git rev-parse HEAD failed: ${r.stderr}`);
  return r.stdout.trim();
}

const DEPLOY_TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: {{ .Values.image }}
          securityContext:
            privileged: {{ .Values.privileged }}
`;

const REQUIRED_URL_TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: {{ .Values.image }}
          securityContext:
            privileged: {{ .Values.privileged }}
          env:
            - name: URL
              value: {{ required "url is required" .Values.url }}
`;

function writeChart(repoDir, {
  chartDir = "charts/app",
  privileged = false,
  image = "nginx:1.27",
  template = DEPLOY_TEMPLATE,
  values = `privileged: ${privileged}\nimage: ${image}\n`,
  chartYaml = "apiVersion: v2\nname: app\nversion: 0.1.0\n"
} = {}) {
  const dir = path.join(repoDir, chartDir);
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Chart.yaml"), chartYaml);
  fs.writeFileSync(path.join(dir, "values.yaml"), values);
  fs.writeFileSync(path.join(dir, "templates", "deploy.yaml"), template);
  return dir;
}

function runCheck(repoDir, baseRef, extraArgs = []) {
  const res = spawnSync(
    process.execPath,
    [CLI, "check", "--changed-from", baseRef, repoDir, "--json", ...extraArgs],
    { cwd: repoDir, encoding: "utf8", timeout: 120000 }
  );
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // handled by the assertions below
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json: parsed };
}

function makeRepo(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-"));
  gitInitRepo(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  const baseMutate = mutate && typeof mutate.base === "function" ? mutate.base : () => {};
  const headMutate = mutate && typeof mutate.head === "function" ? mutate.head : (typeof mutate === "function" ? mutate : () => {});
  writeChart(dir);
  baseMutate(dir);
  const base = gitCommitAll(dir, "base");
  headMutate(dir);
  return { dir, base };
}

function findingById(json, ruleId) {
  return (json?.findings || []).find(f => f.ruleId === ruleId);
}

function changedFileNotCheckedFinding(json, fileName) {
  return (json?.findings || []).find(f =>
    f.ruleId === "changed-file-not-checked" &&
    (f.source && f.source.file && String(f.source.file).endsWith(fileName))
  );
}

// a. FAILS-TODAY: --render-helm off, head changes only values.yaml (privileged: true) ->
// soft changed-file-not-checked naming values.yaml, exit 2.
test("a. --render-helm off, values-only change to privileged: true -> changed-file-not-checked for values.yaml", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { privileged: true });
  });
  try {
    const run = runCheck(dir, base, ["--render-helm", "off"]);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = changedFileNotCheckedFinding(run.json, "values.yaml");
    assert.ok(finding, `expected changed-file-not-checked for values.yaml in ${run.stdout}`);
    assert.equal(finding.level, "soft");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// b. FAILS-TODAY: render on, chart with {{ required "url is required" .Values.url }} and no
// values providing it: head changes only values.yaml -> changed-file-not-checked for values.yaml, exit 2.
test("b. render on, required value missing and head changes values.yaml -> changed-file-not-checked for values.yaml", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo({
    base: (repoDir) => {
      writeChart(repoDir, { template: REQUIRED_URL_TEMPLATE, values: "image: nginx:1.27\n" });
    },
    head: (repoDir) => {
      writeChart(repoDir, { template: REQUIRED_URL_TEMPLATE, values: "image: nginx:1.28\n" });
    }
  });
  try {
    const run = runCheck(dir, base, ["--render-helm", "on"]);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = changedFileNotCheckedFinding(run.json, "values.yaml");
    assert.ok(finding, `expected changed-file-not-checked for values.yaml in ${run.stdout}`);
    assert.equal(finding.level, "soft");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// c. FAILS-TODAY: --render-helm off, head changes only Chart.yaml (adds a dependency) ->
// changed-file-not-checked for Chart.yaml.
test("c. --render-helm off, Chart.yaml change -> changed-file-not-checked for Chart.yaml", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, {
      chartYaml: "apiVersion: v2\nname: app\nversion: 0.1.0\ndependencies:\n  - name: extra\n    version: 1.0.0\n    repository: https://example.com/charts\n"
    });
  });
  try {
    const run = runCheck(dir, base, ["--render-helm", "off"]);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = changedFileNotCheckedFinding(run.json, "Chart.yaml");
    assert.ok(finding, `expected changed-file-not-checked for Chart.yaml in ${run.stdout}`);
    assert.equal(finding.level, "soft");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// d. render on and the chart renders: head sets privileged: true in values.yaml -> the
// privileged finding, and NO changed-file-not-checked for values.yaml.
test("d. render on, chart renders, privileged: true in values.yaml -> hard finding, no changed-file-not-checked", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { privileged: true });
  });
  try {
    const run = runCheck(dir, base, ["--render-helm", "on"]);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    const finding = findingById(run.json, "no-k8s-privileged-containers");
    assert.ok(finding, `expected no-k8s-privileged-containers in ${run.stdout}`);
    assert.equal(finding.level, "hard");
    assert.equal(changedFileNotCheckedFinding(run.json, "values.yaml"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// e. a values.yaml outside any chart (no Chart.yaml above it) changed -> no new finding.
test("e. values.yaml outside any chart -> no new finding", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    fs.writeFileSync(path.join(repoDir, "values.yaml"), "privileged: true\n");
  });
  try {
    const run = runCheck(dir, base);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(changedFileNotCheckedFinding(run.json, "values.yaml"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// f. --render-helm off, a chart's README.md changed -> no new finding.
test("f. --render-helm off, chart README.md changed -> no new finding", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    fs.writeFileSync(path.join(repoDir, "charts", "app", "README.md"), "# app chart\n");
  });
  try {
    const run = runCheck(dir, base, ["--render-helm", "off"]);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(changedFileNotCheckedFinding(run.json, "README.md"), undefined);
    assert.equal(findingById(run.json, "changed-file-not-checked"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// g. (orchestrator, review of T-119) a chart inside a scanned subfolder: the chart folder is compared with the
// scope-relative paths, so a values-only change is still reported when only `services/api` is checked.
test("g. --render-helm off, values-only change in a chart inside a scanned subfolder -> changed-file-not-checked", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo({
    base: (repoDir) => {
      writeChart(repoDir, { chartDir: "services/api/charts/app" });
    },
    head: (repoDir) => {
      writeChart(repoDir, { chartDir: "services/api/charts/app", privileged: true });
    }
  });
  try {
    const run = runCheck(path.join(dir, "services", "api"), base, ["--render-helm", "off"]);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = changedFileNotCheckedFinding(run.json, "values.yaml");
    assert.ok(finding, `expected changed-file-not-checked for values.yaml in ${run.stdout}`);
    assert.equal(finding.level, "soft");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
