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

function writeChart(repoDir, { privileged = false, image = "nginx:1.27", template = DEPLOY_TEMPLATE, dependencies = null } = {}) {
  const chartDir = path.join(repoDir, "charts", "app");
  fs.mkdirSync(path.join(chartDir, "templates"), { recursive: true });
  fs.writeFileSync(path.join(chartDir, "Chart.yaml"), dependencies
    ? `apiVersion: v2\nname: app\nversion: 0.1.0\ndependencies:\n${dependencies}`
    : "apiVersion: v2\nname: app\nversion: 0.1.0\n");
  fs.writeFileSync(path.join(chartDir, "values.yaml"), `privileged: ${privileged}\nimage: ${image}\n`);
  fs.writeFileSync(path.join(chartDir, "templates", "deploy.yaml"), template);
  return chartDir;
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
  writeChart(dir);
  const base = gitCommitAll(dir, "base");
  mutate(dir);
  return { dir, base };
}

function findingById(json, ruleId) {
  return (json?.findings || []).find(f => f.ruleId === ruleId);
}

test("a. values-only change to privileged: true is rendered and blocked as hard", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { privileged: true });
  });
  try {
    const run = runCheck(dir, base);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    const finding = findingById(run.json, "no-k8s-privileged-containers");
    assert.ok(finding, `expected no-k8s-privileged-containers in ${run.stdout}`);
    assert.equal(finding.level, "hard");
    assert.equal(finding.source.file, "charts/app/templates/deploy.yaml");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("b. values-only image tag change renders without a not-checked finding", { skip: SKIP_HELM }, () => {
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { image: "nginx:1.28" });
  });
  try {
    const run = runCheck(dir, base);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(findingById(run.json, "changed-file-not-checked"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("c. harmless template edit renders instead of blocking", { skip: SKIP_HELM }, () => {
  const template = DEPLOY_TEMPLATE.replace("        app: web\n", "        app: web\n        version: \"1\"\n");
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { template });
  });
  try {
    const run = runCheck(dir, base);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(findingById(run.json, "changed-file-not-checked"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("d. --render-helm off keeps today's soft changed-file-not-checked", { skip: SKIP_HELM }, () => {
  const template = DEPLOY_TEMPLATE.replace("        app: web\n", "        app: web\n        version: \"1\"\n");
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { template });
  });
  try {
    const run = runCheck(dir, base, ["--render-helm", "off"]);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = findingById(run.json, "changed-file-not-checked");
    assert.ok(finding, `expected changed-file-not-checked in ${run.stdout}`);
    assert.equal(finding.level, "soft");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("e. a chart with a missing vendored dependency falls back to a soft not-checked finding", { skip: SKIP_HELM }, () => {
  const dependencies = "  - name: missing\n    version: 1.0.0\n    repository: https://example.com/charts\n";
  const template = DEPLOY_TEMPLATE.replace("        app: web\n", "        app: web\n        version: \"1\"\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-"));
  gitInitRepo(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  writeChart(dir, { dependencies });
  const base = gitCommitAll(dir, "base");
  writeChart(dir, { dependencies, template });
  try {
    const run = runCheck(dir, base);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = findingById(run.json, "changed-file-not-checked");
    assert.ok(finding, `expected changed-file-not-checked in ${run.stdout}`);
    assert.equal(finding.level, "soft");
    assert.match(String(finding.detail || finding.message), /helm template failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("f. --render-helm on with a missing helm binary is a config error", () => {
  const { dir, base } = makeRepo((repoDir) => {
    writeChart(repoDir, { image: "nginx:1.28" });
  });
  try {
    const missingBin = path.join(dir, "..", `no-such-helm-${process.pid}.mjs`);
    const run = runCheck(dir, base, ["--render-helm", "on", "--helm-bin", missingBin]);
    assert.equal(run.status, 3, run.stderr || run.stdout);
    assert.match(run.stderr, /--render-helm on: helm not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("g. a helm stub is used when --helm-bin is a .mjs file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-"));
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-stub-"));
  try {
    gitInitRepo(dir);
    fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
    const base = gitCommitAll(dir, "base");

    writeChart(dir, { privileged: true });
    gitCommitAll(dir, "add chart");

    const stub = path.join(stubDir, "stub-helm.mjs");
    fs.writeFileSync(stub, `const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("v0.0.0-stub");
  process.exit(0);
}
console.log("---");
console.log("# Source: app/templates/deploy.yaml");
console.log("apiVersion: apps/v1");
console.log("kind: Deployment");
console.log("metadata:");
console.log("  name: web");
console.log("spec:");
console.log("  template:");
console.log("    spec:");
console.log("      containers:");
console.log("        - name: web");
console.log("          image: nginx:1.27");
console.log("          securityContext:");
console.log("            privileged: true");
`);

    const run = runCheck(dir, base, ["--render-helm", "on", "--helm-bin", stub]);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    const finding = findingById(run.json, "no-k8s-privileged-containers");
    assert.ok(finding, `expected no-k8s-privileged-containers in ${run.stdout}`);
    assert.equal(finding.level, "hard");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test("h. action.yml declares render-helm and passes it from the env", () => {
  const action = fs.readFileSync(path.resolve("action.yml"), "utf8");
  assert.match(action, /render-helm:[\s\S]*?default: 'auto'/);
  assert.match(action, /INPUT_RENDER_HELM: \$\{\{ inputs\.render-helm \}\}/);
  assert.match(action, /CHECK_ARGS\+=\("--render-helm=\$INPUT_RENDER_HELM"\)/);
});
