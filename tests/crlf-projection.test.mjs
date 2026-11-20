import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/diagram.mjs");

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

const PRISMA_SCHEMA_BASE = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id    Int      @id @default(autoincrement())
  email String   @unique
  tags  String[]
  meta  Json
}
`;

const PRISMA_INIT_MIGRATION = `CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "tags" TEXT[],
    "meta" JSONB NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
`;

const CLICKHOUSE_INIT_SQL = `CREATE TABLE website_event (id UUID, url_path String) ENGINE = MergeTree ORDER BY id;\n`;
const CLICKHOUSE_PROJ_SQL = `ALTER TABLE website_event ADD PROJECTION website_event_url_path_projection (SELECT * ORDER BY\nurl_path);\n`;

function setupBaseRepo(tmpRepo) {
  gitInitRepo(tmpRepo);

  fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
  fs.mkdirSync(path.join(tmpRepo, "db", "clickhouse", "migrations"), { recursive: true });

  fs.writeFileSync(path.join(tmpRepo, "prisma", "schema.prisma"), PRISMA_SCHEMA_BASE);
  fs.writeFileSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"), PRISMA_INIT_MIGRATION);
  fs.writeFileSync(path.join(tmpRepo, "db", "clickhouse", "migrations", "01_init.sql"), CLICKHOUSE_INIT_SQL);
  fs.writeFileSync(path.join(tmpRepo, "db", "clickhouse", "migrations", "02_proj.sql"), CLICKHOUSE_PROJ_SQL);

  return gitCommitAll(tmpRepo, "base commit with LF files");
}

// Test (a): base commit with LF files; head commit rewrites all with CRLF only -> no finding with level hard, soft or warn; exit 0
test("(a) CRLF-only commit produces no hard/soft/warn findings and exits 0", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-test-a-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);

    const files = [
      path.join(tmpRepo, "prisma", "schema.prisma"),
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      path.join(tmpRepo, "db", "clickhouse", "migrations", "01_init.sql"),
      path.join(tmpRepo, "db", "clickhouse", "migrations", "02_proj.sql")
    ];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, content.replace(/\r?\n/g, "\r\n"));
    }

    gitCommitAll(tmpRepo, "convert LF to CRLF");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const badFindings = (parsed.findings || []).filter(f => ["hard", "soft", "warn"].includes(f.level));
    assert.deepEqual(badFindings, [], `Expected no hard/soft/warn findings, got: ${JSON.stringify(badFindings)}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Test (b): same base; head working tree (not committed) has the CRLF files -> also no hard/soft/warn finding
test("(b) CRLF-only working tree produces no hard/soft/warn findings and exits 0", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-test-b-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);

    const files = [
      path.join(tmpRepo, "prisma", "schema.prisma"),
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      path.join(tmpRepo, "db", "clickhouse", "migrations", "01_init.sql"),
      path.join(tmpRepo, "db", "clickhouse", "migrations", "02_proj.sql")
    ];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, content.replace(/\r?\n/g, "\r\n"));
    }

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const badFindings = (parsed.findings || []).filter(f => ["hard", "soft", "warn"].includes(f.level));
    assert.deepEqual(badFindings, [], `Expected no hard/soft/warn findings, got: ${JSON.stringify(badFindings)}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Test (c): head adds 03_drop_proj.sql = ALTER TABLE website_event DROP PROJECTION website_event_url_path_projection; -> no sql-no-drop-column; exit 0
test("(c) DROP PROJECTION does not emit sql-no-drop-column and exits 0", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-test-c-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);

    fs.writeFileSync(
      path.join(tmpRepo, "db", "clickhouse", "migrations", "03_drop_proj.sql"),
      "ALTER TABLE website_event DROP PROJECTION website_event_url_path_projection;\n"
    );

    gitCommitAll(tmpRepo, "drop projection");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const dropColFinding = (parsed.findings || []).find(f => f.ruleId === "sql-no-drop-column");
    assert.equal(dropColFinding, undefined, `Expected no sql-no-drop-column finding, got: ${JSON.stringify(dropColFinding)}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Test (d): head adds 04_drop_col.sql = ALTER TABLE website_event DROP COLUMN url_path; -> sql-no-drop-column is still reported
test("(d) DROP COLUMN is still reported as sql-no-drop-column", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-test-d-"));
  try {
    const baseCommit = setupBaseRepo(tmpRepo);

    fs.writeFileSync(
      path.join(tmpRepo, "db", "clickhouse", "migrations", "04_drop_col.sql"),
      "ALTER TABLE website_event DROP COLUMN url_path;\n"
    );

    gitCommitAll(tmpRepo, "drop column");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(r.stdout);
    const dropColFinding = (parsed.findings || []).find(f => f.ruleId === "sql-no-drop-column");
    assert.ok(dropColFinding, "Expected sql-no-drop-column finding for DROP COLUMN url_path");
    assert.equal(dropColFinding.level, "soft");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Test (e): a CRLF Prisma migration that really drops a column (ALTER TABLE "User" DROP COLUMN "name";\r\n) -> still sql-no-drop-column
test("(e) CRLF Prisma migration dropping a column still reports sql-no-drop-column", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-test-e-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });

    const schemaWithCol = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id   Int    @id @default(autoincrement())
  name String
}
`;
    const initMigrationWithCol = `CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
`;

    fs.writeFileSync(path.join(tmpRepo, "prisma", "schema.prisma"), schemaWithCol);
    fs.writeFileSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"), initMigrationWithCol);

    const baseCommit = gitCommitAll(tmpRepo, "base with name column");

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_name"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_name", "migration.sql"),
      'ALTER TABLE "User" DROP COLUMN "name";\r\n'
    );

    gitCommitAll(tmpRepo, "drop column with CRLF");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(r.stdout);
    const dropColFinding = (parsed.findings || []).find(f => f.ruleId === "sql-no-drop-column");
    assert.ok(dropColFinding, "Expected sql-no-drop-column finding for CRLF Prisma migration");
    assert.equal(dropColFinding.level, "soft");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
