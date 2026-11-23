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

const baseSchema = [
  "interface Node { id: ID! }",
  "interface Entity { id: ID! }",
  "type User implements Node & Entity { id: ID! }",
  "type Field { value: String }",
  "type Post { id: ID! }",
  "union Search = User | Field | Post",
  "type Query { users(limit: Int, offset: Int): [User] search: [Search] }",
  ""
].join("\n");

const headSchema = [
  "interface Node { id: ID! }",
  "interface Entity { id: ID! }",
  "type User { id: ID! }",
  "type Post { id: ID! }",
  "union Search = User | Post",
  "type Query { users(tenant: ID!): [User] search: [Search] }",
  ""
].join("\n");

// a. FAILS-TODAY: 7 breaking findings (2 implements, 2 removed args, 1 added required arg, 1 union member, and whatever else graphql-js reports), every entityId distinct, every finding with a source.file
test("FAILS-TODAY: 7 breaking findings, every entityId distinct, every finding with a source.file", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-2-a-"));
  try {
    gitInitRepo(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), headSchema);
    gitCommitAll(tmpRepo, "head schema");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    const breakingFindings = parsed.findings.filter(f => f.ruleId === "gql-breaking");
    assert.equal(breakingFindings.length, 7, `Expected 7 breaking findings, got ${breakingFindings.length}: ${JSON.stringify(breakingFindings)}`);

    const expectedEntities = [
      "gql.implements:User.Node",
      "gql.implements:User.Entity",
      "gql.arg:Query.users.limit",
      "gql.arg:Query.users.offset",
      "gql.arg:Query.users.tenant",
      "gql.union:Search.Field",
      "gql.type:Field"
    ];

    const entityIds = breakingFindings.map(f => f.entityId || f.event?.entityId);
    assert.equal(new Set(entityIds).size, 7, `Expected 7 distinct entityIds, got ${new Set(entityIds).size}: ${JSON.stringify(entityIds)}`);

    for (const expectedId of expectedEntities) {
      const f = breakingFindings.find(x => (x.entityId || x.event?.entityId) === expectedId);
      assert.ok(f, `Expected finding with entityId ${expectedId}, findings were: ${JSON.stringify(entityIds)}`);
      assert.ok(f.source && f.source.file && f.source.file.includes("schema.graphql"), `Expected source.file for ${expectedId}, got: ${JSON.stringify(f.source)}`);
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// b. FAILS-TODAY: an exception for gql.arg:Query.users.limit excepts only that one finding
test("FAILS-TODAY: an exception for gql.arg:Query.users.limit excepts only that one finding", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-2-b-"));
  try {
    gitInitRepo(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);

    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    const exceptionsContent = [
      "- rule: gql-breaking",
      '  target: "gql.arg:Query.users.limit"',
      '  reason: "Removing limit argument"',
      '  owner: "@api-team"',
      '  expires: "2027-06-01"',
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "exceptions.yml"), exceptionsContent);

    const baseCommit = gitCommitAll(tmpRepo, "base schema with exception");

    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), headSchema);
    gitCommitAll(tmpRepo, "head schema");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2 because other 6 findings block, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    assert.equal(parsed.summary.excepted, 1, `Expected 1 excepted finding, got ${parsed.summary.excepted}`);
    assert.equal(parsed.summary.blocking, 6, `Expected 6 blocking findings, got ${parsed.summary.blocking}`);

    const limitFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.arg:Query.users.limit");
    assert.ok(limitFinding, "Query.users.limit finding should exist");
    assert.equal(limitFinding.excepted, true, "Query.users.limit finding should be excepted");

    const otherFindings = parsed.findings.filter(f => (f.entityId || f.event?.entityId) !== "gql.arg:Query.users.limit" && f.ruleId === "gql-breaking");
    assert.equal(otherFindings.length, 6, `Expected 6 other findings, got ${otherFindings.length}`);
    for (const f of otherFindings) {
      assert.ok(!f.excepted, `Finding ${f.entityId || f.event?.entityId} must not be excepted`);
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// c. gql.union:Search.Field is the entityId of the union change
test("gql.union:Search.Field is the entityId of the union change", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-2-c-"));
  try {
    gitInitRepo(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    // Head removes Field from union Search (keeps Field type itself)
    const headWithField = [
      "interface Node { id: ID! }",
      "interface Entity { id: ID! }",
      "type User implements Node & Entity { id: ID! }",
      "type Field { value: String }",
      "type Post { id: ID! }",
      "union Search = User | Post",
      "type Query { users(limit: Int, offset: Int): [User] search: [Search] }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), headWithField);
    gitCommitAll(tmpRepo, "head schema with Field removed from Search union");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    const unionFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.union:Search.Field");
    assert.ok(unionFinding, `Expected finding with entityId gql.union:Search.Field, got: ${JSON.stringify(parsed.findings.map(x => x.entityId || x.event?.entityId))}`);
    assert.ok(unionFinding.source && unionFinding.source.file && unionFinding.source.file.includes("schema.graphql"), `Expected source.file for union finding`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// d. the field/enum cases of tests/graphql-entities.test.mjs still give gql.field:... (one quick case)
test("the field/enum cases still give gql.field:...", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-2-d-"));
  try {
    gitInitRepo(tmpRepo);
    const base = [
      "enum Color { RED BLUE }",
      "type User { id: ID! name: String }",
      "type Query { user: User color: Color }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), base);
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    const head = [
      "enum Color { RED }",
      "type User { id: ID! }",
      "type Query { user: User color: Color }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), head);
    gitCommitAll(tmpRepo, "head schema");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    const breakingFindings = parsed.findings.filter(f => f.ruleId === "gql-breaking");
    const blueFinding = breakingFindings.find(f => (f.entityId || f.event?.entityId) === "gql.field:Color.BLUE");
    assert.ok(blueFinding, "Expected gql.field:Color.BLUE");
    assert.ok(blueFinding.source && blueFinding.source.file && blueFinding.source.file.includes("schema.graphql"));

    const nameFinding = breakingFindings.find(f => (f.entityId || f.event?.entityId) === "gql.field:User.name");
    assert.ok(nameFinding, "Expected gql.field:User.name");
    assert.ok(nameFinding.source && nameFinding.source.file && nameFinding.source.file.includes("schema.graphql"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
