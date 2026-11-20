import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/diagram.mjs");

function runCheck(baseFiles, headFiles) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "precision-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "precision-head-"));
  try {
    for (const [rel, content] of Object.entries(baseFiles)) {
      const p = path.join(tmpBase, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    for (const [rel, content] of Object.entries(headFiles)) {
      const p = path.join(tmpHead, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.ok(r.stdout, `check produced no stdout: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
}

function hasRule(parsed, ruleId) {
  return parsed.findings.some(f => f.ruleId === ruleId);
}

// A. Temporary tables -------------------------------------------------------

test("A: CREATE TEMP TABLE ... AS SELECT then DROP TABLE in the same file is not sql-no-drop-table", () => {
  const sql = "CREATE TEMP TABLE tmp AS SELECT 1;\nDROP TABLE tmp;\n";
  const parsed = runCheck({ "migrations/001.sql": sql }, { "migrations/001.sql": sql });
  assert.ok(!hasRule(parsed, "sql-no-drop-table"), `Expected no sql-no-drop-table, got ${JSON.stringify(parsed.findings)}`);
});

test("A: CREATE TEMPORARY TABLE with columns then DROP TABLE in the same file is not sql-no-drop-table", () => {
  const sql = "CREATE TEMPORARY TABLE tmp (id int);\nDROP TABLE tmp;\n";
  const parsed = runCheck({ "migrations/001.sql": sql }, { "migrations/001.sql": sql });
  assert.ok(!hasRule(parsed, "sql-no-drop-table"), `Expected no sql-no-drop-table, got ${JSON.stringify(parsed.findings)}`);
});

test("A: DROP TABLE of a normal table created in an earlier migration is still sql-no-drop-table", () => {
  const base = { "migrations/001.sql": "CREATE TABLE users (id int);\n" };
  const head = {
    "migrations/001.sql": "CREATE TABLE users (id int);\n",
    "migrations/002.sql": "DROP TABLE users;\n"
  };
  const parsed = runCheck(base, head);
  assert.ok(hasRule(parsed, "sql-no-drop-table"), `Expected sql-no-drop-table, got ${JSON.stringify(parsed.findings)}`);
});

test("A: DROP TABLE of a temp table from an earlier file is still sql-no-drop-table", () => {
  const base = { "migrations/001.sql": "CREATE TEMP TABLE x AS SELECT 1;\n" };
  const head = {
    "migrations/001.sql": "CREATE TEMP TABLE x AS SELECT 1;\n",
    "migrations/002.sql": "DROP TABLE x;\n"
  };
  const parsed = runCheck(base, head);
  assert.ok(hasRule(parsed, "sql-no-drop-table"), `Expected sql-no-drop-table, got ${JSON.stringify(parsed.findings)}`);
});

// E. Views are not tables ---------------------------------------------------

test("E: DROP TABLE of a materialized view is not sql-no-drop-table", () => {
  const base = { "migrations/001.sql": "CREATE TABLE t (id int);\nCREATE MATERIALIZED VIEW mv AS SELECT id FROM t;\n" };
  const head = {
    "migrations/001.sql": "CREATE TABLE t (id int);\nCREATE MATERIALIZED VIEW mv AS SELECT id FROM t;\n",
    "migrations/002.sql": "DROP TABLE IF EXISTS mv;\n"
  };
  const parsed = runCheck(base, head);
  assert.ok(!hasRule(parsed, "sql-no-drop-table"), `Expected no sql-no-drop-table, got ${JSON.stringify(parsed.findings)}`);
});

test("E: DROP TABLE of a real table that a view selects from is still sql-no-drop-table", () => {
  const base = { "migrations/001.sql": "CREATE TABLE t (id int);\nCREATE MATERIALIZED VIEW mv AS SELECT id FROM t;\n" };
  const head = {
    "migrations/001.sql": "CREATE TABLE t (id int);\nCREATE MATERIALIZED VIEW mv AS SELECT id FROM t;\n",
    "migrations/002.sql": "DROP TABLE t;\n"
  };
  const parsed = runCheck(base, head);
  assert.ok(hasRule(parsed, "sql-no-drop-table"), `Expected sql-no-drop-table, got ${JSON.stringify(parsed.findings)}`);
});

// B. Prisma relation fields -------------------------------------------------

const PRISMA_BASE = [
  "model User {",
  "  id Int @id",
  "  posts Post[]",
  "}",
  "",
  "model Post {",
  "  id Int @id",
  "  authorId Int",
  "  author User @relation(fields: [authorId], references: [id])",
  "}",
  ""
].join("\n");

test("B: removing a Prisma relation field is not no-db-field-removed", () => {
  const head = [
    "model User {",
    "  id Int @id",
    "}",
    "",
    "model Post {",
    "  id Int @id",
    "  authorId Int",
    "  author User @relation(fields: [authorId], references: [id])",
    "}",
    ""
  ].join("\n");
  const parsed = runCheck({ "schema.prisma": PRISMA_BASE }, { "schema.prisma": head });
  assert.ok(!hasRule(parsed, "no-db-field-removed"), `Expected no no-db-field-removed, got ${JSON.stringify(parsed.findings)}`);
});

test("B: removing the scalar FK field is still no-db-field-removed for it", () => {
  const head = [
    "model User {",
    "  id Int @id",
    "  posts Post[]",
    "}",
    "",
    "model Post {",
    "  id Int @id",
    "}",
    ""
  ].join("\n");
  const parsed = runCheck({ "schema.prisma": PRISMA_BASE }, { "schema.prisma": head });
  const fieldFindings = parsed.findings.filter(f => f.ruleId === "no-db-field-removed");
  assert.ok(fieldFindings.length > 0, `Expected no-db-field-removed, got ${JSON.stringify(parsed.findings)}`);
  assert.ok(
    fieldFindings.some(f => String(f.event?.before || f.message || "").includes("Post.authorId")),
    `Expected a finding for Post.authorId, got ${JSON.stringify(fieldFindings)}`
  );
});

test("B: removing a whole Prisma model is still no-db-model-removed", () => {
  const head = "model User {\n  id Int @id\n}\n";
  const parsed = runCheck({ "schema.prisma": PRISMA_BASE }, { "schema.prisma": head });
  assert.ok(hasRule(parsed, "no-db-model-removed"), `Expected no-db-model-removed, got ${JSON.stringify(parsed.findings)}`);
});

// C. Container-side port change --------------------------------------------

const composeWithPort = (port) => `services:\n  app:\n    image: node:20\n    ports:\n      - '${port}'\n`;

test("C: changing only the container-side port is not no-all-interfaces-port-binding", () => {
  const parsed = runCheck(
    { "docker-compose.yml": composeWithPort("3180:80") },
    { "docker-compose.yml": composeWithPort("3180:${ALT:-80}") }
  );
  assert.ok(!hasRule(parsed, "no-all-interfaces-port-binding"), `Expected no no-all-interfaces-port-binding, got ${JSON.stringify(parsed.findings)}`);
});

test("C: a new published host port is still no-all-interfaces-port-binding", () => {
  const parsed = runCheck(
    { "docker-compose.yml": composeWithPort("3180:80") },
    { "docker-compose.yml": `services:\n  app:\n    image: node:20\n    ports:\n      - '3180:80'\n      - '3181:80'\n` }
  );
  assert.ok(hasRule(parsed, "no-all-interfaces-port-binding"), `Expected no-all-interfaces-port-binding, got ${JSON.stringify(parsed.findings)}`);
});

test("C: loopback to all-interfaces binding is still compose.port_exposed", () => {
  const parsed = runCheck(
    { "docker-compose.yml": composeWithPort("127.0.0.1:3180:80") },
    { "docker-compose.yml": composeWithPort("3180:80") }
  );
  const finding = parsed.findings.find(f => f.ruleId === "no-all-interfaces-port-binding");
  assert.ok(finding, `Expected no-all-interfaces-port-binding, got ${JSON.stringify(parsed.findings)}`);
  assert.equal(finding.event.type, "compose.port_exposed");
});

// D. Path parameters are not newly required --------------------------------

const openapiWithParams = (params) => {
  const lines = [
    "openapi: 3.0.0",
    "info:",
    "  title: test",
    "  version: '1'",
    "paths:",
    "  /orgs/{orgId}:",
    "    get:"
  ];
  if (params) {
    lines.push("      parameters:");
    lines.push(...params);
  }
  lines.push("      responses:");
  lines.push("        '200':");
  lines.push("          description: ok");
  return lines.join("\n") + "\n";
};

test("D: declaring a route path parameter as required is not no-api-param-required-added", () => {
  const head = openapiWithParams([
    "        - name: orgId",
    "          in: path",
    "          required: true",
    "          schema:",
    "            type: string"
  ]);
  const parsed = runCheck({ "openapi.yaml": openapiWithParams(null) }, { "openapi.yaml": head });
  assert.ok(!hasRule(parsed, "no-api-param-required-added"), `Expected no no-api-param-required-added, got ${JSON.stringify(parsed.findings)}`);
});

// Multi-file Prisma schema (prismaSchemaFolder) ---------------------------

const PRISMA_TEAM_BASE = "model Team {\n  id Int @id\n  brand Brand?\n}\n";
const PRISMA_TEAM_HEAD = "model Team {\n  id Int @id\n  brands Brand[]\n}\n";
const PRISMA_BRAND_BASE = "model Brand {\n  id Int @id\n  teamId Int @unique\n  team Team @relation(fields: [teamId], references: [id])\n}\n";

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

test("T-107b: replacing a relation field across .prisma files is not no-db-field-removed", () => {
  const parsed = runCheck(
    { "prisma/schema/team.prisma": PRISMA_TEAM_BASE, "prisma/schema/brand.prisma": PRISMA_BRAND_BASE },
    { "prisma/schema/team.prisma": PRISMA_TEAM_HEAD, "prisma/schema/brand.prisma": PRISMA_BRAND_BASE }
  );
  assert.ok(!hasRule(parsed, "no-db-field-removed"), `Expected no no-db-field-removed, got ${JSON.stringify(parsed.findings)}`);
});

test("T-107b: removing a scalar field from a sibling .prisma file is still no-db-field-removed", () => {
  const parsed = runCheck(
    { "prisma/schema/team.prisma": PRISMA_TEAM_BASE, "prisma/schema/brand.prisma": PRISMA_BRAND_BASE },
    { "prisma/schema/team.prisma": PRISMA_TEAM_BASE, "prisma/schema/brand.prisma": "model Brand {\n  id Int @id\n}\n" }
  );
  const fieldFindings = parsed.findings.filter(f => f.ruleId === "no-db-field-removed");
  assert.ok(fieldFindings.length > 0, `Expected no-db-field-removed, got ${JSON.stringify(parsed.findings)}`);
  assert.ok(
    fieldFindings.some(f => String(f.event?.before || f.message || "").includes("Brand.teamId")),
    `Expected a finding for Brand.teamId, got ${JSON.stringify(fieldFindings)}`
  );
});

test("T-107b: --changed-from loads sibling .prisma models for relation fields", (t) => {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-folder-changed-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "prisma", "schema"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "prisma", "schema", "team.prisma"), PRISMA_TEAM_BASE);
    fs.writeFileSync(path.join(tmpRepo, "prisma", "schema", "brand.prisma"), PRISMA_BRAND_BASE);
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.writeFileSync(path.join(tmpRepo, "prisma", "schema", "team.prisma"), PRISMA_TEAM_HEAD);
    gitCommitAll(tmpRepo, "team relation replaced");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, "--policy-from", "head", "--json"],
      { cwd: tmpRepo, encoding: "utf8" }
    );
    assert.ok(r.stdout, `check produced no stdout: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(!hasRule(parsed, "no-db-field-removed"), `Expected no no-db-field-removed, got ${JSON.stringify(parsed.findings)}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("D: a new required query parameter is still no-api-param-required-added", () => {
  const head = openapiWithParams([
    "        - name: limit",
    "          in: query",
    "          required: true",
    "          schema:",
    "            type: string"
  ]);
  const parsed = runCheck({ "openapi.yaml": openapiWithParams(null) }, { "openapi.yaml": head });
  assert.ok(hasRule(parsed, "no-api-param-required-added"), `Expected no-api-param-required-added, got ${JSON.stringify(parsed.findings)}`);
});
