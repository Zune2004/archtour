import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isSqlMigrationCandidate } from "../tools/facts-sql.mjs";
import { setSettings, resetSettings, getMaxFileBytes, getMigrationDirs } from "../tools/settings.mjs";

const CLI = path.resolve("tools/cli.mjs");

// Settings are process-wide; each test file is its own process, and tests inside a
// file run one after another, so resetting after each test is enough.
test.afterEach(() => resetSettings());

test("built-in Drizzle and Liquibase folders are migration candidates", () => {
  assert.equal(isSqlMigrationCandidate("drizzle/0003_add.sql"), true);
  assert.equal(isSqlMigrationCandidate("packages/db/drizzle/0000_init.sql"), true);
  assert.equal(isSqlMigrationCandidate("drizzle/meta/x.sql"), false);
  assert.equal(isSqlMigrationCandidate("src/main/resources/db/changelog/changes/001-users.sql"), true);
  assert.equal(isSqlMigrationCandidate("db/deploy/users.sql"), false);
});

test("configured migration dirs make .sql files migrations until reset", () => {
  setSettings({ migrationDirs: ["db/deploy/"] });
  assert.deepEqual(getMigrationDirs(), ["db/deploy"]);
  assert.equal(isSqlMigrationCandidate("db/deploy/users.sql"), true);
  assert.equal(isSqlMigrationCandidate("db/deploy/sub/x.sql"), true);
  assert.equal(isSqlMigrationCandidate("db/deployx/users.sql"), false);
  assert.equal(isSqlMigrationCandidate("db/deploy/users.down.sql"), false);

  resetSettings();
  assert.equal(isSqlMigrationCandidate("db/deploy/users.sql"), false);
});

test("max file size defaults to 5 MB and follows setSettings", () => {
  assert.equal(getMaxFileBytes(), 5 * 1024 * 1024);
  setSettings({ maxFileSizeMb: 1 });
  assert.equal(getMaxFileBytes(), 1 * 1024 * 1024);
});

test("check --migration-dir makes a configured folder's .sql changes checked", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migdir-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migdir-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "deploy"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, "db", "deploy", "001.sql"), "CREATE TABLE users (id int, email text);\n");
    fs.writeFileSync(path.join(tmpHead, "db", "deploy", "001.sql"), "CREATE TABLE users (id int, email text);\n");
    fs.writeFileSync(path.join(tmpHead, "db", "deploy", "002.sql"), "ALTER TABLE users DROP COLUMN email;\n");

    const plain = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    const plainParsed = JSON.parse(plain.stdout);
    assert.ok(
      !plainParsed.findings.some(f => f.ruleId === "sql-no-drop-column"),
      "Without --migration-dir the folder must not be checked"
    );

    const withDir = spawnSync(
      process.execPath,
      [CLI, "check", tmpBase, tmpHead, "--migration-dir", "db/deploy", "--json"],
      { encoding: "utf8" }
    );
    const withDirParsed = JSON.parse(withDir.stdout);
    assert.ok(
      withDirParsed.findings.some(f => f.ruleId === "sql-no-drop-column"),
      `Expected sql-no-drop-column with --migration-dir, got ${JSON.stringify(withDirParsed.findings.map(f => f.ruleId))}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("check --max-file-size lowers the size cap and defaults to 5 MB", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "settings-maxsize-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "settings-maxsize-head-"));
  try {
    const original = "services:\n  web:\n    image: nginx:1.20\n";
    const padded = original + "# " + "x".repeat(2 * 1024 * 1024) + "\n";
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), original);
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), padded);

    const small = spawnSync(
      process.execPath,
      [CLI, "check", tmpBase, tmpHead, "--max-file-size", "1", "--json"],
      { encoding: "utf8" }
    );
    assert.equal(small.status, 2, `Expected exit 2 with --max-file-size 1, got ${small.status}: ${small.stderr}`);
    const smallParsed = JSON.parse(small.stdout);
    assert.ok(
      smallParsed.findings.some(f => f.ruleId === "file-not-checked"),
      "Expected file-not-checked finding at a 1 MB cap"
    );

    const normal = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    const normalParsed = JSON.parse(normal.stdout);
    assert.ok(
      !normalParsed.findings.some(f => f.ruleId === "file-not-checked"),
      "2 MB must be checked under the default 5 MB cap"
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("check rejects an invalid --max-file-size with exit 3", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "settings-badmax-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "settings-badmax-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.20\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.20\n");

    const zero = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--max-file-size", "0"], { encoding: "utf8" });
    assert.equal(zero.status, 3, `Expected exit 3 for --max-file-size 0, got ${zero.status}`);
    assert.ok(zero.stderr.includes("--max-file-size must be a number of MB between 0 and 1024"));

    const nan = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--max-file-size", "abc"], { encoding: "utf8" });
    assert.equal(nan.status, 3, `Expected exit 3 for --max-file-size abc, got ${nan.status}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});
