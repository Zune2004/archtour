// T-110: audit-history must give the same findings as `check --changed-from` for each commit.
//
// One temp repo with a linear history:
//   a. init: multi-file Prisma schema (user.prisma + team.prisma) and the init migration
//   b. rename the relation field `team` -> `group` in user.prisma only (multi-file schema)
//   c. a migration creating a materialized view and a later one dropping it in the same commit
//   d. a migration dropping the name column
//   e. edit the already-applied init migration
//   f. add .archtour/rules.yml raising sql-no-drop-column to hard and, in the same commit, drop the email column
//
// For each commit b-f we compare the audit-history findings for that commit with what `check --changed-from <sha>^`
// reports with the repository checked out at that commit (commit a is the root commit: it has no `<sha>^`).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/diagram.mjs");

function hasGit() {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

function git(dir, args) {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(dir, message, env) {
  const run = (args) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
    return res.stdout.trim();
  };
  run(["add", "-A"]);
  run(["commit", "-m", message]);
  return run(["rev-parse", "HEAD"]);
}

const USER_A = `model User {
  id     Int    @id
  name   String
  team   Team?  @relation(fields: [teamId], references: [id])
  teamId Int?
}
`;

const USER_B = `model User {
  id     Int    @id
  name   String
  group  Team?  @relation(fields: [teamId], references: [id])
  teamId Int?
}
`;

const TEAM = `model Team {
  id    Int    @id
  users User[]
}
`;

const INIT_SQL = `CREATE TABLE "Team" (
  "id" INTEGER NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "User" (
  "id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "teamId" INTEGER,
  PRIMARY KEY ("id")
);
`;

const INIT_SQL_EDITED = INIT_SQL.replace(`"email" TEXT,`, `"email" VARCHAR(255),`);

const RULES_YML = `version: 1
extends: [archtour:recommended]
rules:
  - id: sql-no-drop-column
    level: hard
`;

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

let shared = null;

function getShared() {
  if (shared) return shared;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-parity-"));

  const baseEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "parity@example.com"]);
  git(dir, ["config", "user.name", "Parity Test"]);
  git(dir, ["config", "commit.gpgSign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);

  const shas = {};

  write(dir, "prisma/schema/user.prisma", USER_A);
  write(dir, "prisma/schema/team.prisma", TEAM);
  write(dir, "prisma/migrations/20240101000000_init/migration.sql", INIT_SQL);
  shas.a = commitAll(dir, "a: init the prisma schema and migration", baseEnv);

  write(dir, "prisma/schema/user.prisma", USER_B);
  shas.b = commitAll(dir, "b: rename the relation field team to group", baseEnv);

  write(dir, "prisma/migrations/20240201000000_stats/migration.sql", "CREATE MATERIALIZED VIEW stats_mv AS SELECT 1 AS id;\n");
  write(dir, "prisma/migrations/20240201000001_drop_stats/migration.sql", "DROP TABLE IF EXISTS stats_mv;\n");
  shas.c = commitAll(dir, "c: create and drop a materialized view", baseEnv);

  write(dir, "prisma/migrations/20240301000000_drop_name/migration.sql", 'ALTER TABLE "User" DROP COLUMN "name";\n');
  shas.d = commitAll(dir, "d: drop the name column", baseEnv);

  write(dir, "prisma/migrations/20240101000000_init/migration.sql", INIT_SQL_EDITED);
  shas.e = commitAll(dir, "e: edit the applied init migration", baseEnv);

  write(dir, ".archtour/rules.yml", RULES_YML);
  write(dir, "prisma/migrations/20240401000000_drop_email/migration.sql", 'ALTER TABLE "User" DROP COLUMN "email";\n');
  shas.f = commitAll(dir, "f: tighten the policy and drop the email column", baseEnv);

  // Worktree is at HEAD (f), so the audit runs on a clean tree like a user would run it.
  const auditRes = runCli(["audit-history", dir, "--json"], dir);
  assert.equal(auditRes.status, 0, `audit-history failed: ${auditRes.stderr}`);
  const audit = JSON.parse(auditRes.stdout);

  shared = { dir, shas, audit };
  return shared;
}

const COMPARED_LEVELS = new Set(["hard", "soft", "warn"]);

// audit-history replays architecture changes; check also reports policy-file changes as `policy-changed`
// (kind "policy"), which audit-history never emitted and is not an architecture finding.
function comparable(findings) {
  return findings
    .filter(f => COMPARED_LEVELS.has(f.level))
    .filter(f => !(f.event && f.event.kind === "policy"))
    .map(f => `${f.ruleId}|${f.level}|${f.event && f.event.entityId}`)
    .sort();
}

function checkAtCommit(commitKey) {
  const { dir, shas } = getShared();
  const sha = shas[commitKey];
  const head = git(dir, ["rev-parse", "HEAD"]);
  try {
    git(dir, ["checkout", "-q", sha]);
    const res = runCli(["check", "--changed-from", `${sha}^`, dir, "--json"], dir);
    assert.ok(res.stdout, `check produced no JSON at ${commitKey}: ${res.stderr}`);
    return JSON.parse(res.stdout).findings;
  } finally {
    git(dir, ["checkout", "-q", head]);
  }
}

function auditAtCommit(commitKey) {
  const { audit, shas } = getShared();
  return audit.findings.filter(f => f.sha === shas[commitKey]);
}

function assertParity(commitKey) {
  const live = comparable(checkAtCommit(commitKey));
  const recorded = comparable(auditAtCommit(commitKey));
  assert.deepEqual(recorded, live, `audit-history must match check for commit ${commitKey}`);
  return { live, recorded };
}

if (!hasGit()) {
  test("history parity tests skipped because git is missing", (t) => {
    t.skip("git binary is not available");
  });
} else {
  test("parity b: renaming a relation field in a multi-file Prisma schema gives no no-db-field-removed", () => {
    const { live, recorded } = assertParity("b");
    assert.equal(live.some(f => f.startsWith("no-db-field-removed|")), false, `check reported no-db-field-removed: ${live}`);
    assert.equal(recorded.some(f => f.startsWith("no-db-field-removed|")), false, `audit reported no-db-field-removed: ${recorded}`);
  });

  test("parity c: creating and dropping a materialized view in one commit gives no sql-no-drop-table", () => {
    const { live, recorded } = assertParity("c");
    for (const list of [live, recorded]) {
      assert.equal(list.some(f => f.startsWith("sql-no-drop-table|")), false, `unexpected sql-no-drop-table: ${list}`);
    }
  });

  test("parity d: dropping a column gives sql-no-drop-column in both tools", () => {
    const { live, recorded } = assertParity("d");
    assert.ok(live.some(f => f.startsWith("sql-no-drop-column|")), `check missed sql-no-drop-column: ${live}`);
    assert.ok(recorded.some(f => f.startsWith("sql-no-drop-column|")), `audit missed sql-no-drop-column: ${recorded}`);
  });

  test("parity e: editing an applied migration gives hard sql-no-migration-edited in both tools", () => {
    const { live, recorded } = assertParity("e");
    assert.ok(live.some(f => f.startsWith("sql-no-migration-edited|hard|")), `check missed hard sql-no-migration-edited: ${live}`);
    assert.ok(recorded.some(f => f.startsWith("sql-no-migration-edited|hard|")), `audit missed hard sql-no-migration-edited: ${recorded}`);
  });

  test("parity f: both tools use the parent policy, so the column drop is soft", () => {
    const { live, recorded } = assertParity("f");
    assert.ok(live.some(f => f.startsWith("sql-no-drop-column|soft|")), `check did not use the parent policy: ${live}`);
    assert.ok(recorded.some(f => f.startsWith("sql-no-drop-column|soft|")), `audit did not use the parent policy: ${recorded}`);
    assert.equal(live.some(f => f.startsWith("sql-no-drop-column|hard|")), false, "check must not apply the new policy");
    assert.equal(recorded.some(f => f.startsWith("sql-no-drop-column|hard|")), false, "audit must not apply the new policy");
  });

  test("audit-history --json keeps summary, totals, commits and findings", () => {
    const { audit } = getShared();
    for (const key of ["summary", "totals", "commits", "findings"]) {
      assert.ok(key in audit, `audit-history JSON must contain "${key}"`);
    }
    assert.equal(audit.commits.length, 6, "every commit of the linear history must be listed");
    assert.equal(audit.summary.commitsScanned, 6);
  });
}
