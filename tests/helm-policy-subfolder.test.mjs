import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/cli.mjs");

function hasGit() {
  try {
    const r = spawnSync("git", ["--version"]);
    return r.status === 0;
  } catch {
    return false;
  }
}

function gitInitRepo(repoDir) {
  spawnSync("git", ["init"], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: repoDir });
  spawnSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir });
}

function gitCommitAll(repoDir, message) {
  spawnSync("git", ["add", "-A"], { cwd: repoDir });
  return spawnSync("git", ["commit", "-m", message], { cwd: repoDir, encoding: "utf8" });
}

function getHeadCommit(repoDir) {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
}

// a. FAILS-TODAY: root .archtour/ + subfolder scan with empty commit -> no policy-changed, exit 0
test("T-123a: subfolder scan with root .archtour/ and empty commit -> no policy-changed, exit 0", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t123a-"));
  try {
    gitInitRepo(tmpRepo);

    // Root .archtour/ with rules and helm config
    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "helm.yml"), "version: 1\ncharts: {}\n");

    // Subfolder with a file to scan
    fs.mkdirSync(path.join(tmpRepo, "svc"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "svc", "README.md"), "# Service\n");

    // Base commit
    gitCommitAll(tmpRepo, "base commit");
    const baseCommit = getHeadCommit(tmpRepo);

    // Empty second commit
    spawnSync("git", ["commit", "--allow-empty", "-m", "empty commit"], { cwd: tmpRepo, encoding: "utf8" });

    // Run check on subfolder
    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, path.join(tmpRepo, "svc"), "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    const policyChanged = parsed.findings.find(f => f.ruleId === "policy-changed");
    assert.equal(policyChanged, undefined, "policy-changed should NOT be reported for empty commit");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// b. Same repo, edit root .archtour/helm.yml -> policy-changed reported
test("T-123b: subfolder scan with root .archtour/helm.yml edit -> policy-changed reported", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t123b-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "helm.yml"), "version: 1\ncharts: {}\n");

    fs.mkdirSync(path.join(tmpRepo, "svc"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "svc", "README.md"), "# Service\n");

    gitCommitAll(tmpRepo, "base commit");
    const baseCommit = getHeadCommit(tmpRepo);

    // Edit root helm.yml
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "helm.yml"), "version: 1\ncharts:\n  svc: {}\n");
    gitCommitAll(tmpRepo, "edit helm.yml");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, path.join(tmpRepo, "svc"), "--json"], { encoding: "utf8" });
    // policy-changed is a soft finding -> exit 2
    assert.equal(r.status, 2, `Expected exit 2 (soft policy-changed), got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const policyChanged = parsed.findings.find(f => f.ruleId === "policy-changed");
    assert.ok(policyChanged, "policy-changed should be reported when root helm.yml changes");
    assert.equal(policyChanged.level, "soft");
    assert.ok(policyChanged.message.includes("Config \"helm.yml\" changed"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// c. Same repo, edit root .archtour/rules.yml -> policy-changed reported
test("T-123c: subfolder scan with root .archtour/rules.yml edit -> policy-changed reported", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t123c-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "helm.yml"), "version: 1\ncharts: {}\n");

    fs.mkdirSync(path.join(tmpRepo, "svc"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "svc", "README.md"), "# Service\n");

    gitCommitAll(tmpRepo, "base commit");
    const baseCommit = getHeadCommit(tmpRepo);

    // Edit root rules.yml - loosen a rule (policy-changed is for loosening; tightening needs no approval)
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\nrules:\n  - id: sql-no-drop-column\n    level: advisory\n");
    gitCommitAll(tmpRepo, "edit rules.yml");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, path.join(tmpRepo, "svc"), "--json"], { encoding: "utf8" });
    // policy-changed is a soft finding -> exit 2
    assert.equal(r.status, 2, `Expected exit 2 (soft policy-changed), got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const policyChanged = parsed.findings.find(f => f.ruleId === "policy-changed");
    assert.ok(policyChanged, "policy-changed should be reported when root rules.yml changes");
    assert.equal(policyChanged.level, "soft");
    assert.match(policyChanged.message, /sql-no-drop-column/);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// d. FAILS-TODAY: helm.yml with values: [values.yaml] -> exit 3 with error message
test("T-123d: helm.yml with values: [values.yaml] -> exit 3 config error", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t123d-"));
  try {
    fs.mkdirSync(path.join(tmpDir, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
    fs.writeFileSync(path.join(tmpDir, ".archtour", "helm.yml"), "version: 1\ncharts:\n  mychart:\n    values: [values.yaml]\n");
    fs.mkdirSync(path.join(tmpDir, "mychart"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "mychart", "Chart.yaml"), "name: mychart\nversion: 0.1.0\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpDir, tmpDir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 3, `Expected exit 3 for config error, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes('values file "values.yaml" for chart "mychart"'), `Expected specific error message, got: ${r.stderr}`);
    assert.ok(r.stderr.includes("the chart's own values.yaml is always read from each side; list only override files"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// e. Root scan with no .archtour/ at all and empty commit -> exit 0 (unchanged behaviour)
test("T-123e: root scan with no .archtour/ and empty commit -> exit 0", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t123e-"));
  try {
    gitInitRepo(tmpRepo);

    // No .archtour/ at all
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Repo\n");

    gitCommitAll(tmpRepo, "base commit");
    const baseCommit = getHeadCommit(tmpRepo);

    // Empty second commit
    spawnSync("git", ["commit", "--allow-empty", "-m", "empty commit"], { cwd: tmpRepo, encoding: "utf8" });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});