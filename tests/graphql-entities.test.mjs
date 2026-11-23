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

// 1. FAILS-TODAY: 4 gql-breaking findings with entityIds gql.field:Color.BLUE, gql.field:Size.L, gql.field:User.name, gql.field:User.email
test("FAILS-TODAY: 4 gql-breaking findings for removed fields and enum values with their file source", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-a-"));
  try {
    gitInitRepo(tmpRepo);

    const baseSchema = [
      "enum Color { RED BLUE }",
      "enum Size { S L }",
      "type User { id: ID! name: String email: String }",
      "type Query { user: User color: Color size: Size }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);

    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    // Head removes BLUE, L, name, email
    const headSchema = [
      "enum Color { RED }",
      "enum Size { S }",
      "type User { id: ID! }",
      "type Query { user: User color: Color size: Size }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), headSchema);
    gitCommitAll(tmpRepo, "head schema with removals");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2 for soft findings, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    const breakingFindings = parsed.findings.filter(f => f.ruleId === "gql-breaking");
    assert.equal(breakingFindings.length, 4, `Expected exactly 4 gql-breaking findings, got ${breakingFindings.length}`);

    const expectedEntities = [
      "gql.field:Color.BLUE",
      "gql.field:Size.L",
      "gql.field:User.name",
      "gql.field:User.email"
    ];

    for (const expectedId of expectedEntities) {
      const f = breakingFindings.find(x => (x.entityId || x.event?.entityId) === expectedId);
      assert.ok(f, `Expected finding with entityId ${expectedId}, findings were: ${JSON.stringify(breakingFindings.map(x => ({ id: x.entityId || x.event?.entityId, source: x.source })))}`);
      assert.ok(f.source && f.source.file.includes("schema.graphql"), `Expected source.file to contain schema.graphql, got: ${JSON.stringify(f.source)}`);
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 2. FAILS-TODAY: an exception in the base .archtour/exceptions.yml for gql.field:Color.BLUE excepts only that finding
test("FAILS-TODAY: exception in base .archtour/exceptions.yml for gql.field:Color.BLUE excepts only that finding", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-b-"));
  try {
    gitInitRepo(tmpRepo);

    const baseSchema = [
      "enum Color { RED BLUE }",
      "enum Size { S L }",
      "type User { id: ID! name: String email: String }",
      "type Query { user: User color: Color size: Size }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);

    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    const exceptionsContent = [
      "- rule: gql-breaking",
      '  target: "gql.field:Color.BLUE"',
      '  reason: "Deprecating BLUE in Color enum"',
      '  owner: "@api-team"',
      '  expires: "2027-06-01"',
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "exceptions.yml"), exceptionsContent);

    const baseCommit = gitCommitAll(tmpRepo, "base schema with exception");

    // Head removes BLUE, L, name, email
    const headSchema = [
      "enum Color { RED }",
      "enum Size { S }",
      "type User { id: ID! }",
      "type Query { user: User color: Color size: Size }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), headSchema);
    gitCommitAll(tmpRepo, "head schema with removals");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2 because other 3 findings block, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    assert.equal(parsed.summary.excepted, 1, `Expected 1 excepted finding, got ${parsed.summary.excepted}`);
    assert.equal(parsed.summary.blocking, 3, `Expected 3 blocking findings, got ${parsed.summary.blocking}`);

    const blueFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.field:Color.BLUE");
    assert.ok(blueFinding, "Color.BLUE finding should exist");
    assert.equal(blueFinding.excepted, true, "Color.BLUE finding should be excepted");

    const sizeLFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.field:Size.L");
    assert.ok(sizeLFinding, "Size.L finding should exist");
    assert.ok(!sizeLFinding.excepted, "Size.L finding must not be excepted");

    const userNameFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.field:User.name");
    assert.ok(userNameFinding, "User.name finding should exist");
    assert.ok(!userNameFinding.excepted, "User.name finding must not be excepted");

    const userEmailFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.field:User.email");
    assert.ok(userEmailFinding, "User.email finding should exist");
    assert.ok(!userEmailFinding.excepted, "User.email finding must not be excepted");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 3. A removed type -> a finding with entityId gql.type:Post
test("removed type produces finding with entityId gql.type:Post and source file", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-c-"));
  try {
    gitInitRepo(tmpRepo);

    const baseSchema = [
      "enum Color { RED BLUE }",
      "enum Size { S L }",
      "type User { id: ID! name: String email: String }",
      "type Post { id: ID! }",
      "type Query { user: User color: Color size: Size post: Post }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);

    const baseCommit = gitCommitAll(tmpRepo, "base schema with Post");

    // Head removes Post and its field in Query
    const headSchema = [
      "enum Color { RED BLUE }",
      "enum Size { S L }",
      "type User { id: ID! name: String email: String }",
      "type Query { user: User color: Color size: Size }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), headSchema);
    gitCommitAll(tmpRepo, "head schema without Post");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);

    const postFinding = parsed.findings.find(f => (f.entityId || f.event?.entityId) === "gql.type:Post");
    assert.ok(postFinding, `Expected finding with entityId gql.type:Post, got findings: ${JSON.stringify(parsed.findings.map(x => x.entityId || x.event?.entityId))}`);
    assert.ok(postFinding.source && postFinding.source.file.includes("schema.graphql"), `Expected source.file to contain schema.graphql, got: ${JSON.stringify(postFinding.source)}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 4. No change -> no finding
test("no change produces no findings", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "gql-entities-d-"));
  try {
    gitInitRepo(tmpRepo);

    const baseSchema = [
      "enum Color { RED BLUE }",
      "enum Size { S L }",
      "type User { id: ID! name: String email: String }",
      "type Query { user: User color: Color size: Size }",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);

    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    // Head has identical schema
    fs.writeFileSync(path.join(tmpRepo, "schema.graphql"), baseSchema);
    gitCommitAll(tmpRepo, "head schema identical");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, `Expected exit 0 for no changes, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.length, 0, "Expected 0 findings for unchanged schema");
    assert.equal(parsed.verdict, "passed");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
