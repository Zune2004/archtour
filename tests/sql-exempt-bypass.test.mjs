import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/cli.mjs");

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

function setupBaseRepo(tmpRepo) {
  gitInitRepo(tmpRepo);
  const migDir = path.join(tmpRepo, "migrations");
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(
    path.join(migDir, "0001_init.sql"),
    "CREATE SCHEMA audit;\nCREATE TABLE logs (id int);\nCREATE TABLE audit.logs (id int);\n"
  );
  return gitCommitAll(tmpRepo, "0001_init");
}

function runCheck(tmpRepo, baseCommit) {
  return spawnSync(
    process.execPath,
    [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
    { cwd: tmpRepo, encoding: "utf8" }
  );
}

// 2a. FAILS-TODAY CREATE TABLE IF NOT EXISTS logs (id int); TRUNCATE logs; -> sql-no-truncate
test("2a. CREATE TABLE IF NOT EXISTS does not exempt TRUNCATE -> sql-no-truncate", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2a-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE TABLE IF NOT EXISTS logs (id int);\nTRUNCATE logs;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 2, `Expected exit 2 (soft finding), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-truncate"),
      `Expected sql-no-truncate finding, got: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2b. FAILS-TODAY CREATE SCHEMA IF NOT EXISTS public; DROP SCHEMA public CASCADE; -> hard sql-no-drop-schema
test("2b. CREATE SCHEMA IF NOT EXISTS does not exempt DROP SCHEMA -> hard sql-no-drop-schema", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2b-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE SCHEMA IF NOT EXISTS public;\nDROP SCHEMA public CASCADE;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 1, `Expected exit 1 (hard finding), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-drop-schema"),
      `Expected sql-no-drop-schema finding, got: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2c. FAILS-TODAY CREATE TABLE audit.tmp (id int); TRUNCATE logs; -> sql-no-truncate for logs
test("2c. CREATE TABLE audit.tmp does not exempt TRUNCATE logs -> sql-no-truncate", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2c-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE TABLE audit.tmp (id int);\nTRUNCATE logs;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 2, `Expected exit 2 (soft finding), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-truncate"),
      `Expected sql-no-truncate finding for logs, got: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2c-bis. FAILS-TODAY CREATE TABLE audit.logs (id int); TRUNCATE logs; -> sql-no-truncate (schema-qualified create does not match unqualified truncate)
test("2c-bis. CREATE TABLE audit.logs does not exempt TRUNCATE logs -> sql-no-truncate", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2c-bis-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE TABLE audit.logs (id int);\nTRUNCATE logs;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 2, `Expected exit 2 (soft finding), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-truncate"),
      `Expected sql-no-truncate finding for logs, got: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2d. CREATE TABLE tmp_import (id int); TRUNCATE tmp_import; -> no finding (still exempt)
test("2d. CREATE TABLE tmp_import followed by TRUNCATE tmp_import is exempt", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2d-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE TABLE tmp_import (id int);\nTRUNCATE tmp_import;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 0, `Expected exit 0 (exempt), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 0, `Expected 0 findings, got: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2e. CREATE SCHEMA staging; DROP SCHEMA staging CASCADE; -> no finding (still exempt)
test("2e. CREATE SCHEMA staging followed by DROP SCHEMA staging CASCADE is exempt", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2e-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE SCHEMA staging;\nDROP SCHEMA staging CASCADE;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 0, `Expected exit 0 (exempt), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 0, `Expected 0 findings, got: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2f. CREATE TABLE audit.tmp2 (id int); TRUNCATE audit.tmp2; -> no finding (qualified names match)
test("2f. CREATE TABLE audit.tmp2 followed by TRUNCATE audit.tmp2 is exempt (qualified match)", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "t124-2f-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_x.sql"),
      "CREATE TABLE audit.tmp2 (id int);\nTRUNCATE audit.tmp2;\n"
    );
    gitCommitAll(tmpRepo, "0002_x");

    const r = runCheck(tmpRepo, baseCommit);
    assert.equal(r.status, 0, `Expected exit 0 (exempt), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 0, `Expected 0 findings, got: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
