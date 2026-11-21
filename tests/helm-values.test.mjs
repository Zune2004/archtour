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

// A template that needs a value the chart's own values.yaml does not provide: only a helm.yml `set` or a
// ci/*-values.yaml file can render it.
const REQUIRED_TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  annotations:
    archtour.io/url: {{ required "url is required" .Values.url | quote }}
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

const PLAIN_TEMPLATE = `apiVersion: apps/v1
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

function chartPath(repoDir, chartDir = "charts/app") {
  return path.join(repoDir, ...chartDir.split("/"));
}

function writeChart(repoDir, {
  privileged = false,
  image = "nginx:1.27",
  template = REQUIRED_TEMPLATE,
  dependencies = null,
  chartDir = "charts/app",
  name = "app"
} = {}) {
  const dir = chartPath(repoDir, chartDir);
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Chart.yaml"), dependencies
    ? `apiVersion: v2\nname: ${name}\nversion: 0.1.0\ndependencies:\n${dependencies}`
    : `apiVersion: v2\nname: ${name}\nversion: 0.1.0\n`);
  fs.writeFileSync(path.join(dir, "values.yaml"), `privileged: ${privileged}\nimage: ${image}\n`);
  fs.writeFileSync(path.join(dir, "templates", "deploy.yaml"), template);
  return dir;
}

function writeHelmPolicy(repoDir, content) {
  fs.mkdirSync(path.join(repoDir, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".archtour", "helm.yml"), content);
}

function writeRules(repoDir) {
  fs.mkdirSync(path.join(repoDir, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".archtour", "rules.yml"), "version: 1\nextends: archtour:recommended\n");
}

function writeCiValues(repoDir, content, chartDir = "charts/app") {
  const dir = path.join(chartPath(repoDir, chartDir), "ci");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "default-values.yaml"), content);
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

// Creates a repo whose base commit already has the app chart (with REQUIRED_TEMPLATE), an optional base mutation,
// then applies the head mutation.
function makeRepo({ base = () => {}, head = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-values-"));
  gitInitRepo(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  writeChart(dir);
  base(dir);
  const baseRef = gitCommitAll(dir, "base");
  head(dir);
  return { dir, baseRef };
}

function findingById(json, ruleId) {
  return (json?.findings || []).filter(f => f.ruleId === ruleId);
}

const HELM_URL = `version: 1
charts:
  charts/app:
    set:
      url: https://qa.example.com
`;

test("a. helm.yml set values render the chart and the privileged finding is reported", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => writeHelmPolicy(d, HELM_URL),
    head: (d) => writeChart(d, { privileged: true })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    const privileged = findingById(run.json, "no-k8s-privileged-containers");
    assert.equal(privileged.length, 1, run.stdout);
    assert.equal(privileged[0].level, "hard");
    assert.equal(privileged[0].source.file, "charts/app/templates/deploy.yaml");
    assert.equal(findingById(run.json, "changed-file-not-checked").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const EDITED_TEMPLATE = REQUIRED_TEMPLATE.replace("      app: web\n", "      app: web\n      version: \"1\"\n");

test("b. a required value with no helm.yml and no ci values stays changed-file-not-checked", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    head: (d) => writeChart(d, { privileged: true, template: EDITED_TEMPLATE })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const skipped = findingById(run.json, "changed-file-not-checked");
    assert.equal(skipped.length, 1, run.stdout);
    assert.equal(skipped[0].level, "soft");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("c. ci/default-values.yaml renders the chart without a helm.yml", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => writeCiValues(d, "url: https://x\n"),
    head: (d) => writeChart(d, { privileged: true })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(findingById(run.json, "no-k8s-privileged-containers").length, 1, run.stdout);
    assert.equal(findingById(run.json, "changed-file-not-checked").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("d. a helm.yml added by the PR does not apply (policy comes from base) and is reported", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => writeRules(d),
    head: (d) => {
      writeChart(d, { privileged: true, template: EDITED_TEMPLATE });
      writeHelmPolicy(d, HELM_URL);
    }
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const skipped = findingById(run.json, "changed-file-not-checked");
    assert.equal(skipped.length, 1, run.stdout);
    assert.equal(skipped[0].level, "soft");
    const policy = findingById(run.json, "policy-changed");
    assert.equal(policy.length, 1, run.stdout);
    assert.match(JSON.stringify(policy[0].changes || policy[0].message), /helm\.yml/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("d2. a PR cannot hide a head value by editing the ci values file it is checked with", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => writeCiValues(d, "url: https://x\n"),
    head: (d) => {
      writeChart(d, { privileged: true });
      writeCiValues(d, "url: https://x\nprivileged: false\n");
    }
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(findingById(run.json, "no-k8s-privileged-containers").length, 1, run.stdout);
    assert.equal(findingById(run.json, "changed-file-not-checked").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("e. a local file:// dependency is copied from the same side and the chart renders", { skip: SKIP_HELM }, () => {
  const dependencies = "  - name: common\n    version: 0.1.0\n    repository: file://../common\n";
  const template = PLAIN_TEMPLATE.replace("  name: web\n", "  name: {{ include \"common.name\" . }}\n");
  const { dir, baseRef } = makeRepo({
    base: (d) => {
      writeChart(d, { dependencies, template });
      const common = chartPath(d, "charts/common");
      fs.mkdirSync(path.join(common, "templates"), { recursive: true });
      fs.writeFileSync(path.join(common, "Chart.yaml"), "apiVersion: v2\nname: common\nversion: 0.1.0\ntype: library\n");
      fs.writeFileSync(path.join(common, "templates", "_helpers.tpl"), "{{- define \"common.name\" -}}web{{- end -}}\n");
    },
    head: (d) => writeChart(d, { dependencies, template, privileged: true })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(findingById(run.json, "no-k8s-privileged-containers").length, 1, run.stdout);
    assert.equal(findingById(run.json, "changed-file-not-checked").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("f. a remote dependency is left out with one advisory notice and never blocks", { skip: SKIP_HELM }, () => {
  const dependencies = "  - name: missing\n    version: 1.0.0\n    repository: https://charts.example.com\n";
  const { dir, baseRef } = makeRepo({
    base: (d) => writeChart(d, { dependencies, template: PLAIN_TEMPLATE }),
    head: (d) => writeChart(d, { dependencies, template: PLAIN_TEMPLATE, privileged: true })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(findingById(run.json, "no-k8s-privileged-containers").length, 1, run.stdout);
    assert.equal(findingById(run.json, "changed-file-not-checked").length, 0);
    const notices = findingById(run.json, "file-not-checked");
    assert.equal(notices.length, 1, run.stdout);
    assert.equal(notices[0].level, "advisory");
    assert.match(
      notices[0].message,
      /Helm chart charts\/app: dependencies not vendored, rendered without them: missing \(https:\/\/charts\.example\.com\); vendor them in charts\/ to check them/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("g. a helm.yml values path escaping the chart folder is a config error", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => writeHelmPolicy(d, `version: 1
charts:
  charts/app:
    values: [../../etc/passwd]
`),
    head: (d) => writeChart(d, { privileged: true })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 3, run.stderr || run.stdout);
    assert.match(run.stderr, /helm\.yml/);
    assert.match(run.stderr, /relative/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
