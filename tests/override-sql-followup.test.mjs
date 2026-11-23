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

function runCheck(tmpRepo, baseCommit, extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json", ...extraArgs],
    { encoding: "utf8" }
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed: safeJson(r.stdout) };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function cleanup(tmpRepo) {
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

const WORKFLOW_RULES = `version: 1
extends:
  - archtour:recommended
rules:
  - id: no-db-model-removed
    level: soft
    owners: ["alice"]
`;

function buildWorkflowRepo() {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ovr-sql-wf-"));
  gitInitRepo(tmpRepo);

  fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), WORKFLOW_RULES);

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "schema.prisma"),
    `model Workflow {
  id Int @id
  name String
}
`
  );
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
    `CREATE TABLE "Workflow" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT
);
`
  );
  const baseCommit = gitCommitAll(tmpRepo, "base schema");

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_workflow"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, "prisma", "schema.prisma"), `// Workflow removed\n`);
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_workflow", "migration.sql"),
    `DROP TABLE "Workflow";
`
  );
  gitCommitAll(tmpRepo, "remove Workflow model and drop table");

  return { tmpRepo, baseCommit };
}

function buildSqlMigrationRepo(migrationSql) {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-mig-test-"));
  gitInitRepo(tmpRepo);

  fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRepo, ".archtour", "rules.yml"),
    `version: 1
extends:
  - archtour:recommended
`
  );
  const baseCommit = gitCommitAll(tmpRepo, "base config");

  fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, "migrations", "20240102000000_test.sql"), migrationSql);
  gitCommitAll(tmpRepo, "add migration");

  return { tmpRepo, baseCommit };
}

// 3a. FAILS-TODAY: base policy `- id: no-db-model-removed` with `level: soft` and `owners: ["alice"]`;
//     head removes a Prisma model and adds `DROP TABLE "Workflow";`;
//     bob (write access, `--override-permission write`, not the author) overrides `sql-no-drop-table`
//     -> still blocked (exit 2), nothing overridden.
test("FAILS-TODAY: bob overriding sql-no-drop-table stays blocked for also-matched no-db-model-removed owned by alice", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildWorkflowRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "sql-no-drop-table",
      "--override-by", "bob",
      "--override-permission", "write",
      "--override-reason", "Workflow model removal approved"
    ]);

    assert.equal(status, 2, `Expected exit 2 (still blocked), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-drop-table"),
      "The sql-no-drop-table finding must still be present"
    );
    const f = parsed.findings.find(x => x.ruleId === "sql-no-drop-table");
    assert.ok(!f.overridden, "The finding must NOT be marked overridden");
    assert.equal(parsed.summary.overridden, 0, "Nothing may be counted as overridden");
    assert.ok(
      stderr.includes('is not an owner of "no-db-model-removed"'),
      `Expected refusal line naming the also-matched rule, got stderr: ${stderr}`
    );
  } finally {
    cleanup(tmpRepo);
  }
});

// 3b. same, alice overrides `sql-no-drop-table` -> Passed, exit 0.
test("alice overriding sql-no-drop-table succeeds because she owns also-matched no-db-model-removed", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildWorkflowRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "sql-no-drop-table",
      "--override-by", "alice",
      "--override-permission", "write",
      "--override-reason", "Workflow model removal approved by alice"
    ]);

    assert.equal(status, 0, `Expected exit 0 (passed), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.equal(parsed.summary.overridden, 1, "Exactly one finding must be overridden");
    assert.equal(parsed.overrides.length, 1, "Exactly one audit entry must be recorded");
    assert.equal(parsed.overrides[0].ruleId, "sql-no-drop-table");
    assert.equal(parsed.overrides[0].overriddenBy, "alice");
  } finally {
    cleanup(tmpRepo);
  }
});

// 3c. FAILS-TODAY: one migration `CREATE SCHEMA staging; CREATE TABLE staging.t (id int); DROP SCHEMA staging CASCADE;`
//     -> no `sql-no-drop-schema`, exit 0.
test("FAILS-TODAY: schema created and dropped in one migration produces no sql-no-drop-schema", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const sql = `CREATE SCHEMA staging;
CREATE TABLE staging.t (id int);
DROP SCHEMA staging CASCADE;
`;
  const { tmpRepo, baseCommit } = buildSqlMigrationRepo(sql);
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit);

    assert.equal(status, 0, `Expected exit 0 (no drop schema finding), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.ok(
      !parsed.findings.some(f => f.ruleId === "sql-no-drop-schema"),
      "Must not have sql-no-drop-schema finding"
    );
  } finally {
    cleanup(tmpRepo);
  }
});

// 3d. FAILS-TODAY: one migration `CREATE TABLE tmp_import (id int); TRUNCATE tmp_import;`
//     -> no `sql-no-truncate`.
test("FAILS-TODAY: table created and truncated in the same migration produces no sql-no-truncate", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const sql = `CREATE TABLE tmp_import (id int);
TRUNCATE tmp_import;
`;
  const { tmpRepo, baseCommit } = buildSqlMigrationRepo(sql);
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit);

    assert.equal(status, 0, `Expected exit 0 (no truncate finding), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.ok(
      !parsed.findings.some(f => f.ruleId === "sql-no-truncate"),
      "Must not have sql-no-truncate finding"
    );
  } finally {
    cleanup(tmpRepo);
  }
});

// 3e. `DROP SCHEMA public CASCADE;` alone in a new migration -> still hard `sql-no-drop-schema`, exit 1.
test("dropping schema not created in the migration still triggers hard sql-no-drop-schema with exit 1", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const sql = `DROP SCHEMA public CASCADE;
`;
  const { tmpRepo, baseCommit } = buildSqlMigrationRepo(sql);
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit);

    assert.equal(status, 1, `Expected exit 1 (hard block), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.verdict, "failed");
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-drop-schema"),
      "Must have sql-no-drop-schema finding"
    );
    const f = parsed.findings.find(x => x.ruleId === "sql-no-drop-schema");
    assert.equal(f.level, "hard", "sql-no-drop-schema must be hard");
  } finally {
    cleanup(tmpRepo);
  }
});
