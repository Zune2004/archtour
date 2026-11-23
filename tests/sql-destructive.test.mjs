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

const INIT_SQL = `CREATE TABLE logs (
  id INT PRIMARY KEY,
  message TEXT,
  created_at TIMESTAMP
);

CREATE TABLE events (
  id INT PRIMARY KEY,
  name TEXT
);
`;

// a. FAILS-TODAY DROP SCHEMA public CASCADE; -> hard sql-no-drop-schema, exit 1
test("FAILS-TODAY: DROP SCHEMA public CASCADE -> hard sql-no-drop-schema, exit 1", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-drop-schema-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(path.join(tmpRepo, "migrations", "0002_drop_schema.sql"), "DROP SCHEMA public CASCADE;\n");
    gitCommitAll(tmpRepo, "head: drop schema");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 1, `Expected exit 1 for hard drop schema, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    const finding = parsed.findings.find(f => f.ruleId === "sql-no-drop-schema");
    assert.ok(finding, "Expected sql-no-drop-schema finding");
    assert.equal(finding.level, "hard");
    assert.equal(finding.event.type, "sql.drop_schema");
    assert.equal(finding.event.entityId, "db.schema:public");
    assert.equal(finding.event.message, "Schema 'public' was dropped");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// b. FAILS-TODAY DROP DATABASE app; -> hard sql-no-drop-database
test("FAILS-TODAY: DROP DATABASE app -> hard sql-no-drop-database, exit 1", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-drop-db-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(path.join(tmpRepo, "migrations", "0002_drop_db.sql"), "DROP DATABASE app;\n");
    gitCommitAll(tmpRepo, "head: drop database");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 1, `Expected exit 1 for hard drop database, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    const finding = parsed.findings.find(f => f.ruleId === "sql-no-drop-database");
    assert.ok(finding, "Expected sql-no-drop-database finding");
    assert.equal(finding.level, "hard");
    assert.equal(finding.event.type, "sql.drop_database");
    assert.equal(finding.event.entityId, "db.database:app");
    assert.equal(finding.event.message, "Database 'app' was dropped");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// c. FAILS-TODAY TRUNCATE TABLE logs; -> soft sql-no-truncate, exit 2
test("FAILS-TODAY: TRUNCATE TABLE logs -> soft sql-no-truncate, exit 2", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-truncate-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(path.join(tmpRepo, "migrations", "0002_truncate.sql"), "TRUNCATE TABLE logs;\n");
    gitCommitAll(tmpRepo, "head: truncate table logs");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for soft truncate table, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const finding = parsed.findings.find(f => f.ruleId === "sql-no-truncate");
    assert.ok(finding, "Expected sql-no-truncate finding");
    assert.equal(finding.level, "soft");
    assert.equal(finding.event.type, "sql.truncate");
    assert.equal(finding.event.entityId, "db.table:logs");
    assert.equal(finding.event.message, "Table 'logs' was truncated (all rows deleted)");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// d. TRUNCATE logs, events RESTART IDENTITY; -> two sql-no-truncate findings
test("TRUNCATE logs, events RESTART IDENTITY -> two sql-no-truncate findings, exit 2", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-truncate-multi-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(path.join(tmpRepo, "migrations", "0002_truncate_multi.sql"), "TRUNCATE logs, events RESTART IDENTITY;\n");
    gitCommitAll(tmpRepo, "head: truncate multiple tables");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for soft truncate, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const findings = parsed.findings.filter(f => f.ruleId === "sql-no-truncate");
    assert.equal(findings.length, 2, "Expected two sql-no-truncate findings");
    assert.ok(findings.some(f => f.event.entityId === "db.table:logs"));
    assert.ok(findings.some(f => f.event.entityId === "db.table:events"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// e. FAILS-TODAY DELETE FROM logs; -> soft sql-no-delete-all
test("FAILS-TODAY: DELETE FROM logs -> soft sql-no-delete-all, exit 2", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-delete-all-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(path.join(tmpRepo, "migrations", "0002_delete.sql"), "DELETE FROM logs;\n");
    gitCommitAll(tmpRepo, "head: delete from logs");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for soft delete all, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const finding = parsed.findings.find(f => f.ruleId === "sql-no-delete-all");
    assert.ok(finding, "Expected sql-no-delete-all finding");
    assert.equal(finding.level, "soft");
    assert.equal(finding.event.type, "sql.delete_all");
    assert.equal(finding.event.entityId, "db.table:logs");
    assert.equal(finding.event.message, "All rows of table 'logs' are deleted (DELETE without WHERE)");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// f. DELETE FROM logs WHERE created_at < now() - interval '90 days'; -> no finding, exit 0
test("DELETE FROM logs WHERE created_at < now() - interval '90 days' -> no finding, exit 0", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-delete-where-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_delete_where.sql"),
      "DELETE FROM logs WHERE created_at < now() - interval '90 days';\n"
    );
    gitCommitAll(tmpRepo, "head: delete from logs where ...");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 0, `Expected exit 0 for delete with WHERE, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.findings.length, 0, "Expected zero findings for DELETE with WHERE");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// g. the same statements only inside comments (-- TRUNCATE logs; and /* DROP SCHEMA x */) -> no finding
test("destructive statements only inside comments -> no finding, exit 0", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-comments-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "0001_init.sql"), INIT_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base: init tables");

    fs.writeFileSync(
      path.join(tmpRepo, "migrations", "0002_comments.sql"),
      "-- TRUNCATE logs;\n/* DROP SCHEMA x; */\n/* DROP DATABASE app; */\n-- DELETE FROM logs;\n"
    );
    gitCommitAll(tmpRepo, "head: comments only");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 0, `Expected exit 0 for commented statements, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.findings.length, 0, "Expected zero findings for comments");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// h. a Prisma migration (prisma/migrations/<ts>_x/migration.sql) with TRUNCATE TABLE "logs"; -> sql-no-truncate
test("Prisma migration with TRUNCATE TABLE \"logs\" -> sql-no-truncate, exit 2", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sql-destr-prisma-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      INIT_SQL
    );
    const baseCommit = gitCommitAll(tmpRepo, "base: prisma init tables");

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_truncate"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_truncate", "migration.sql"),
      'TRUNCATE TABLE "logs";\n'
    );
    gitCommitAll(tmpRepo, "head: prisma truncate");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for prisma truncate, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const finding = parsed.findings.find(f => f.ruleId === "sql-no-truncate");
    assert.ok(finding, "Expected sql-no-truncate finding in Prisma migration");
    assert.equal(finding.event.entityId, "db.table:logs");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
