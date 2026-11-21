import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/diagram.mjs");

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

// (a) mapped field: base has apiPollLimit Int? @map("api_poll_limit") in model Subscription { id Int @id ... @@map("subscriptions") }
// and the init migration; head removes the field and adds migration ALTER TABLE "subscriptions" DROP COLUMN "api_poll_limit";
// -> exactly ONE finding for it: sql-no-drop-column with alsoMatched containing no-db-field-removed
test("mapped field removal merges Prisma and SQL findings into sql-no-drop-column", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-map-a-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  apiPollLimit Int? @map("api_poll_limit")
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      `CREATE TABLE "subscriptions" (
  "id" INTEGER PRIMARY KEY,
  "api_poll_limit" INTEGER
);
`
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col", "migration.sql"),
      `ALTER TABLE "subscriptions" DROP COLUMN "api_poll_limit";
`
    );
    gitCommitAll(tmpRepo, "remove apiPollLimit field and drop column");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 1, `Expected exactly 1 finding, got: ${JSON.stringify(parsed.findings)}`);
    const f = parsed.findings[0];
    assert.equal(f.ruleId, "sql-no-drop-column");
    assert.ok(
      Array.isArray(f.alsoMatched) && f.alsoMatched.includes("no-db-field-removed"),
      `Expected alsoMatched to include no-db-field-removed, got: ${JSON.stringify(f.alsoMatched)}`
    );
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// (b) model + table, no map: head removes model Workflow and adds DROP TABLE "Workflow";
// -> one sql-no-drop-table finding with alsoMatched containing no-db-model-removed
test("unmapped model and table removal merges into sql-no-drop-table", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-map-b-"));
  try {
    gitInitRepo(tmpRepo);

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

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_table"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "prisma", "schema.prisma"), `// Workflow removed\n`);
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_table", "migration.sql"),
      `DROP TABLE "Workflow";
`
    );
    gitCommitAll(tmpRepo, "remove Workflow model and drop table");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 1, `Expected exactly 1 finding, got: ${JSON.stringify(parsed.findings)}`);
    const f = parsed.findings[0];
    assert.equal(f.ruleId, "sql-no-drop-table");
    assert.ok(
      Array.isArray(f.alsoMatched) && f.alsoMatched.includes("no-db-model-removed"),
      `Expected alsoMatched to include no-db-model-removed, got: ${JSON.stringify(f.alsoMatched)}`
    );
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// (c) mapped model: model Workflow { ... @@map("workflows") } and DROP TABLE "public"."workflows"; -> merged as (b)
test("mapped model removal merges with schema-qualified DROP TABLE into sql-no-drop-table", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-map-c-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Workflow {
  id Int @id
  name String
  @@map("workflows")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      `CREATE TABLE "workflows" (
  "id" INTEGER PRIMARY KEY,
  "name" TEXT
);
`
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_table"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "prisma", "schema.prisma"), `// Workflow removed\n`);
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_table", "migration.sql"),
      `DROP TABLE "public"."workflows";
`
    );
    gitCommitAll(tmpRepo, "remove mapped Workflow model and drop table with schema");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 1, `Expected exactly 1 finding, got: ${JSON.stringify(parsed.findings)}`);
    const f = parsed.findings[0];
    assert.equal(f.ruleId, "sql-no-drop-table");
    assert.ok(
      Array.isArray(f.alsoMatched) && f.alsoMatched.includes("no-db-model-removed"),
      `Expected alsoMatched to include no-db-model-removed, got: ${JSON.stringify(f.alsoMatched)}`
    );
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// (d) different entities do NOT merge: head removes field a (@map("col_a")) but migration drops col_b -> both findings stay
test("different entities do not merge when mapped names differ", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-map-d-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  a Int? @map("col_a")
  b Int? @map("col_b")
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      `CREATE TABLE "subscriptions" (
  "id" INTEGER PRIMARY KEY,
  "col_a" INTEGER,
  "col_b" INTEGER
);
`
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  b Int? @map("col_b")
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col", "migration.sql"),
      `ALTER TABLE "subscriptions" DROP COLUMN "col_b";
`
    );
    gitCommitAll(tmpRepo, "remove field a and drop column col_b");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 2, `Expected both findings to stay, got: ${JSON.stringify(parsed.findings)}`);
    const prismaFinding = parsed.findings.find(f => f.ruleId === "no-db-field-removed");
    const sqlFinding = parsed.findings.find(f => f.ruleId === "sql-no-drop-column");
    assert.ok(prismaFinding, "Expected no-db-field-removed to be reported");
    assert.ok(sqlFinding, "Expected sql-no-drop-column to be reported");
    assert.equal(prismaFinding.event?.before, "Subscription.a");
    assert.equal(sqlFinding.event?.before, "subscriptions.col_b");
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// (e) field removed with no migration -> no-db-field-removed still reported
test("field removed with no migration reports no-db-field-removed", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-map-e-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  apiPollLimit Int? @map("api_poll_limit")
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      `CREATE TABLE "subscriptions" (
  "id" INTEGER PRIMARY KEY,
  "api_poll_limit" INTEGER
);
`
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  @@map("subscriptions")
}
`
    );
    gitCommitAll(tmpRepo, "remove apiPollLimit field without migration");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 1, `Expected exactly 1 finding, got: ${JSON.stringify(parsed.findings)}`);
    assert.equal(parsed.findings[0].ruleId, "no-db-field-removed");
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// (f) levels: with .archtour/rules.yml in the base setting no-db-field-removed to hard, case (a) gives ONE finding at level hard
test("deduplication raises level to hard when no-db-field-removed is hard", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dedupe-map-f-"));
  try {
    gitInitRepo(tmpRepo);

    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, ".archtour", "rules.yml"),
      `version: 1
extends:
  - archtour:recommended
rules:
  - id: no-db-field-removed
    level: hard
`
    );
    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101000000_init"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  apiPollLimit Int? @map("api_poll_limit")
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240101000000_init", "migration.sql"),
      `CREATE TABLE "subscriptions" (
  "id" INTEGER PRIMARY KEY,
  "api_poll_limit" INTEGER
);
`
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema with custom rule level");

    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "schema.prisma"),
      `model Subscription {
  id Int @id
  @@map("subscriptions")
}
`
    );
    fs.writeFileSync(
      path.join(tmpRepo, "prisma", "migrations", "20240102000000_drop_col", "migration.sql"),
      `ALTER TABLE "subscriptions" DROP COLUMN "api_poll_limit";
`
    );
    gitCommitAll(tmpRepo, "remove field and drop column");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 1, `Expected exactly 1 finding, got: ${JSON.stringify(parsed.findings)}`);
    const f = parsed.findings[0];
    assert.equal(f.ruleId, "sql-no-drop-column");
    assert.equal(f.level, "hard", `Expected finding level to be hard, got: ${f.level}`);
    assert.ok(
      Array.isArray(f.alsoMatched) && f.alsoMatched.includes("no-db-field-removed"),
      `Expected alsoMatched to include no-db-field-removed, got: ${JSON.stringify(f.alsoMatched)}`
    );
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});
