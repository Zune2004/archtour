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

// T-116. An override must never clear a finding whose own rule the overrider does not own.
//
// One real removal gives ONE finding: sql-no-drop-column with no-db-field-removed in alsoMatched.
// The base policy makes alice the only owner of sql-no-drop-column. Bob (write access) must NOT be able
// to clear the SAME finding by overriding the pack rule no-db-field-removed, whose owners are empty.
//
// Builds a repo with:
//   .archtour/rules.yml  -> version 1, extends [archtour:recommended], sql-no-drop-column owners ["alice"]
//   prisma/schema.prisma  -> model User { id Int @id  name String }  + init migration
// Head removes `name` and adds ALTER TABLE "User" DROP COLUMN "name";.

const DROP_COLUMN_RULES = `version: 1
extends:
  - archtour:recommended
rules:
  - id: sql-no-drop-column
    level: soft
    owners: ["alice"]
`;

const DROP_TABLE_RULES = `version: 1
extends:
  - archtour:recommended
rules:
  - id: sql-no-drop-table
    level: soft
    owners: ["alice"]
`;

// Builds a base commit that drops a Prisma column `User.name` on head. Returns { tmpRepo, baseCommit }.
function buildDropColumnRepo() {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ovr-also-col-"));
  gitInitRepo(tmpRepo);

  fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), DROP_COLUMN_RULES);

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "schema.prisma"),
    `model User {
  id Int @id
  name String
}
`
  );
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
    `CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT
);
`
  );
  const baseCommit = gitCommitAll(tmpRepo, "base schema");

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "schema.prisma"),
    `model User {
  id Int @id
}
`
  );
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col", "migration.sql"),
    `ALTER TABLE "User" DROP COLUMN "name";
`
  );
  gitCommitAll(tmpRepo, "remove name and drop column");

  return { tmpRepo, baseCommit };
}

// Builds a base commit that drops a whole Prisma model `User` on head (DROP TABLE "User";). Returns { tmpRepo, baseCommit }.
function buildDropTableRepo() {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ovr-also-tbl-"));
  gitInitRepo(tmpRepo);

  fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), DROP_TABLE_RULES);

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "schema.prisma"),
    `model User {
  id Int @id
  name String
}
`
  );
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
    `CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT
);
`
  );
  const baseCommit = gitCommitAll(tmpRepo, "base schema");

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_table"), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, "prisma", "schema.prisma"), `// User removed\n`);
  fs.writeFileSync(
    path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_table", "migration.sql"),
    `DROP TABLE "User";
`
  );
  gitCommitAll(tmpRepo, "remove User model and drop table");

  return { tmpRepo, baseCommit };
}

// Runs `check --changed-from <baseCommit> <tmpRepo>` with the given override flags, parsed from JSON.
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

// (a) FAILS-TODAY: bob overrides no-db-field-removed -> still blocked (exit 2), the finding is not overridden.
//     Bob does not own the finding's own rule (sql-no-drop-column, owned by alice). The finding is sql-no-drop-column
//     with no-db-field-removed in alsoMatched. Today applyOverrides checks owners of the OVERRIDDEN rule
//     (no-db-field-removed, empty owners) and clears it; after the fix it must stay blocking.
test("FAILS-TODAY: bob overriding no-db-field-removed stays blocked for a sql-no-drop-column finding", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildDropColumnRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "no-db-field-removed",
      "--override-by", "bob",
      "--override-permission", "write",
      "--override-reason", "Platform migration approved"
    ]);

    assert.equal(status, 2, `Expected exit 2 (still blocked), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-drop-column"),
      "The sql-no-drop-column finding must still be present"
    );
    const f = parsed.findings.find(x => x.ruleId === "sql-no-drop-column");
    assert.ok(!f.overridden, "The finding must NOT be marked overridden");
    assert.equal(parsed.summary.overridden, 0, "Nothing may be counted as overridden");
    assert.ok(
      stderr.includes('is not an owner of "sql-no-drop-column"'),
      `Expected refusal line naming the finding's own rule, got stderr: ${stderr}`
    );
  } finally {
    cleanup(tmpRepo);
  }
});

// (b) bob overrides sql-no-drop-column -> refused, exit 2 (as today).
test("bob overriding sql-no-drop-column (owned by alice) is refused with exit 2", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildDropColumnRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "sql-no-drop-column",
      "--override-by", "bob",
      "--override-reason", "Platform migration approved"
    ]);

    assert.equal(status, 2, `Expected exit 2 (refused), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.summary.overridden, 0, "Nothing may be overridden");
    const f = parsed.findings.find(x => x.ruleId === "sql-no-drop-column");
    assert.ok(!f.overridden, "The finding must NOT be overridden");
  } finally {
    cleanup(tmpRepo);
  }
});

// (c) alice overrides sql-no-drop-column -> Passed, exit 0, one audit entry.
test("alice overriding sql-no-drop-column (she owns it) passes with exit 0 and one audit entry", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildDropColumnRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "sql-no-drop-column",
      "--override-by", "alice",
      "--override-reason", "Column drop approved for migration v2"
    ]);

    assert.equal(status, 0, `Expected exit 0 (passed), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.equal(parsed.summary.overridden, 1, "Exactly one finding must be overridden");
    assert.equal(parsed.overrides.length, 1, "Exactly one audit entry must be recorded");
    assert.equal(parsed.overrides[0].ruleId, "sql-no-drop-column");
    assert.equal(parsed.overrides[0].overriddenBy, "alice");
    assert.equal(parsed.overrides[0].reason, "Column drop approved for migration v2");
  } finally {
    cleanup(tmpRepo);
  }
});

// (d) alice overrides no-db-field-removed -> Passed, exit 0. She owns the finding's own rule (sql-no-drop-column);
//     the overridden rule (no-db-field-removed) has no owners, so the empty-owner write-access branch accepts her.
test("alice overriding no-db-field-removed passes because she owns the finding's own rule", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildDropColumnRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "no-db-field-removed",
      "--override-by", "alice",
      "--override-permission", "write",
      "--override-reason", "Column drop approved for migration v2"
    ]);

    assert.equal(status, 0, `Expected exit 0 (passed), got ${status}: ${stderr}`);
    assert.ok(parsed, "stdout must be valid JSON");
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.equal(parsed.summary.overridden, 1, "Exactly one finding must be overridden");
    assert.equal(parsed.overrides.length, 1, "Exactly one audit entry must be recorded");
    assert.equal(parsed.overrides[0].overriddenBy, "alice");
  } finally {
    cleanup(tmpRepo);
  }
});

// (e) FAILS-TODAY: removed model + DROP TABLE "User"; with sql-no-drop-table owned by alice:
//     bob overriding no-db-model-removed stays blocked.
test("FAILS-TODAY: bob overriding no-db-model-removed stays blocked for a sql-no-drop-table finding", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const { tmpRepo, baseCommit } = buildDropTableRepo();
  try {
    const { status, stderr, parsed } = runCheck(tmpRepo, baseCommit, [
      "--override", "no-db-model-removed",
      "--override-by", "bob",
      "--override-permission", "write",
      "--override-reason", "Platform migration approved"
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
      stderr.includes('is not an owner of "sql-no-drop-table"'),
      `Expected refusal line naming the finding's own rule, got stderr: ${stderr}`
    );
  } finally {
    cleanup(tmpRepo);
  }
});