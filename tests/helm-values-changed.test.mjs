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

// Needs a value the chart's own values.yaml does not provide: only a helm.yml `values` entry or a
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

function chartPath(repoDir, chartDir = "charts/app") {
  return path.join(repoDir, ...chartDir.split("/"));
}

function writeChart(repoDir, { privileged = false, image = "nginx:1.27", template = REQUIRED_TEMPLATE, chartDir = "charts/app" } = {}) {
  const dir = chartPath(repoDir, chartDir);
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: app\nversion: 0.1.0\n");
  fs.writeFileSync(path.join(dir, "values.yaml"), `privileged: ${privileged}\nimage: ${image}\n`);
  fs.writeFileSync(path.join(dir, "templates", "deploy.yaml"), template);
}

function writeHelmPolicy(repoDir, content) {
  fs.mkdirSync(path.join(repoDir, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".archtour", "helm.yml"), content);
}

function writeValuesFile(repoDir, name, content, chartDir = "charts/app") {
  const file = path.join(chartPath(repoDir, chartDir), ...name.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeCiValues(repoDir, content, chartDir = "charts/app") {
  writeValuesFile(repoDir, "ci/default-values.yaml", content, chartDir);
}

function runCheck(repoDir, baseRef) {
  const res = spawnSync(
    process.execPath,
    [CLI, "check", "--changed-from", baseRef, repoDir, "--json"],
    { cwd: repoDir, encoding: "utf8", timeout: 120000 }
  );
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // asserted below
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json: parsed };
}

function makeRepo({ base = () => {}, head = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-values-changed-"));
  gitInitRepo(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  writeChart(dir);
  base(dir);
  const baseRef = gitCommitAll(dir, "base");
  head(dir);
  return { dir, baseRef };
}

function findingsByRule(json, ruleId) {
  return (json?.findings || []).filter(f => f.ruleId === ruleId);
}

function notCheckedFor(json, fileName) {
  return findingsByRule(json, "changed-file-not-checked").find(f =>
    String(f.source?.file || "").endsWith(fileName)
  );
}

const HELM_VALUES_PROD = `version: 1
charts:
  charts/app:
    values: [values-prod.yaml]
`;

const BASE_VALUES_PROD = "url: https://qa.example.com\n";

// a. FAILS-TODAY: base helm.yml renders the chart with values-prod.yaml; the PR sets privileged: true in
// that file. Values are read from the base branch, so the change is not checked and must be reported.
test("a. helm.yml values: [values-prod.yaml], PR sets privileged: true in values-prod.yaml -> soft changed-file-not-checked, exit 2", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => {
      writeHelmPolicy(d, HELM_VALUES_PROD);
      writeValuesFile(d, "values-prod.yaml", BASE_VALUES_PROD);
    },
    head: (d) => writeValuesFile(d, "values-prod.yaml", `${BASE_VALUES_PROD}privileged: true\n`)
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = notCheckedFor(run.json, "values-prod.yaml");
    assert.ok(finding, `expected changed-file-not-checked for values-prod.yaml in ${run.stdout}`);
    assert.equal(finding.level, "soft");
    assert.equal(
      finding.detail,
      "Helm values file charts/app/values-prod.yaml of chart charts/app is read from the base branch; the change in this PR takes effect after merge and was not checked"
    );
    assert.equal(findingsByRule(run.json, "no-k8s-privileged-containers").length, 0, run.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// b. FAILS-TODAY: no helm.yml, the chart's ci/default-values.yaml provides the required url; the PR edits
// that file. It is read from the base branch, so the edit is not checked and must be reported.
test("b. no helm.yml, PR edits ci/default-values.yaml -> changed-file-not-checked naming it", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => writeCiValues(d, "url: https://qa.example.com\n"),
    head: (d) => writeCiValues(d, "url: https://staging.example.com\n")
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 2, run.stderr || run.stdout);
    const finding = notCheckedFor(run.json, "ci/default-values.yaml");
    assert.ok(finding, `expected changed-file-not-checked for ci/default-values.yaml in ${run.stdout}`);
    assert.equal(finding.level, "soft");
    assert.equal(
      finding.detail,
      "Helm values file charts/app/ci/default-values.yaml of chart charts/app is read from the base branch; the change in this PR takes effect after merge and was not checked"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// c. The PR changes only the chart's own values.yaml (not an override file): it is rendered from each side
// and checked, so the privileged finding is reported and there is no changed-file-not-checked for it.
test("c. PR changes only the chart's values.yaml -> privileged finding, no changed-file-not-checked", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => {
      writeHelmPolicy(d, HELM_VALUES_PROD);
      writeValuesFile(d, "values-prod.yaml", BASE_VALUES_PROD);
    },
    head: (d) => writeChart(d, { privileged: true })
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 1, run.stderr || run.stdout);
    const privileged = findingsByRule(run.json, "no-k8s-privileged-containers");
    assert.equal(privileged.length, 1, run.stdout);
    assert.equal(privileged[0].level, "hard");
    assert.equal(notCheckedFor(run.json, "values.yaml"), undefined, run.stdout);
    assert.equal(findingsByRule(run.json, "changed-file-not-checked").length, 0, run.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// d. A values file the chart is not rendered with is an ordinary changed file: no new finding.
test("d. PR adds an unrelated values-staging.yaml that is not used for rendering -> no new finding", { skip: SKIP_HELM }, () => {
  const { dir, baseRef } = makeRepo({
    base: (d) => {
      writeHelmPolicy(d, HELM_VALUES_PROD);
      writeValuesFile(d, "values-prod.yaml", BASE_VALUES_PROD);
    },
    head: (d) => writeValuesFile(d, "values-staging.yaml", "replicaCount: 2\n")
  });
  try {
    const run = runCheck(dir, baseRef);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(findingsByRule(run.json, "changed-file-not-checked").length, 0, run.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});