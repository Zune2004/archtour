import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import yaml from "yaml";

function gitInitRepo(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: dir });
}

function gitCommitAll(dir, message) {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", message], { cwd: dir });
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

test("action.yml declares outputs needs-human, needs-human-reasons, verdict", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  assert.ok(parsed.outputs["needs-human"], "action.yml should declare output 'needs-human'");
  assert.equal(parsed.outputs["needs-human"].description, "Whether the PR needs a human review (true/false)");

  assert.ok(parsed.outputs["needs-human-reasons"], "action.yml should declare output 'needs-human-reasons'");
  assert.equal(parsed.outputs["needs-human-reasons"].description, "Semicolon-separated reasons why human review is needed");

  assert.ok(parsed.outputs.verdict, "action.yml should declare output 'verdict'");
  assert.equal(parsed.outputs.verdict.description, "The guardrails verdict: passed, warning, or failed");
});

test("action.yml declares input needs-human-label with empty default", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  assert.ok(parsed.inputs["needs-human-label"], "action.yml should declare input 'needs-human-label'");
  assert.equal(parsed.inputs["needs-human-label"].default, "");
  assert.equal(parsed.inputs["needs-human-label"].required, false);
});

test("needs-human true for GraphQL contract change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-gql-"));
  gitInitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "schema.graphql"), "type Query { hello: String }\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "schema.graphql"), "type Query { hello: String, world: Int }\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, true);
  assert.ok(j.needsHuman.reasons.some(x => x.startsWith("API contract change: schema.graphql")));
});

test("needs-human true for Protobuf contract change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-proto-"));
  gitInitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "service.proto"), 'syntax = "proto3";\npackage test;\nservice Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }\nmessage HelloRequest { string name = 1; }\nmessage HelloReply { string message = 1; }\n');
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "service.proto"), 'syntax = "proto3";\npackage test;\nservice Greeter { rpc SayHello (HelloRequest) returns (HelloReply); rpc SayGoodbye (HelloRequest) returns (HelloReply); }\nmessage HelloRequest { string name = 1; }\nmessage HelloReply { string message = 1; }\n');
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, true);
  assert.ok(j.needsHuman.reasons.some(x => x.startsWith("API contract change: service.proto")));
});

test("markdown report needs human line for migration PR", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-md-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "migrations", "0001_init.sql"), "CREATE TABLE users (id int);\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "migrations", "0002_add_bio.sql"), "ALTER TABLE users ADD COLUMN bio text;\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp], { encoding: "utf8" });
  assert.match(r.stdout, /Needs a human: yes \(database change: migrations\/0002_add_bio\.sql\)/);
});

test("markdown report needs human line for ordinary change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-md2-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "app.ts"), "export const x = 1;\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "src", "app.ts"), "export const x = 2;\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp], { encoding: "utf8" });
  assert.match(r.stdout, /Needs a human: no/);
});

test("needs-human true for overridden soft finding", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-override-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".archtour", "rules.yml"), "version: 1\nrules:\n  - id: no-host-network\n    level: soft\n    on: service.host_network_enabled\n");
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "version: '3'\nservices:\n  app:\n    image: nginx\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "version: '3'\nservices:\n  app:\n    image: nginx\n    network_mode: host\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json", "--override", "no-host-network", "--override-by", "reviewer", "--override-permission", "write", "--pr-author", "agent-bot", "--override-reason", "approved"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, true);
  assert.ok(j.needsHuman.reasons.includes("blocking finding: no-host-network"));
  assert.equal(j.verdict, "passed");
  assert.equal(r.status, 0);
});

test("action.yml parse: outputs needs-human, needs-human-reasons, verdict; input needs-human-label", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  // Check outputs
  assert.ok(parsed.outputs["needs-human"]);
  assert.ok(parsed.outputs["needs-human-reasons"]);
  assert.ok(parsed.outputs.verdict);

  // Check input
  assert.ok(parsed.inputs["needs-human-label"]);
  assert.equal(parsed.inputs["needs-human-label"].default, "");
});

test("label is added when needs-human is true and removed when false (parse action.yml)", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  // Find the "Manage needs-human label" step
  const labelStep = parsed.runs.steps.find(s => s.name === "Manage needs-human label");
  assert.ok(labelStep, "Manage needs-human label step should exist");

  // Check the step condition
  assert.ok(labelStep.if?.includes("needs-human-label"), "Step should only run when needs-human-label is set");
  assert.ok(labelStep.if?.includes("github.event_name == 'pull_request'"), "Step should only run on PRs");
  assert.ok(labelStep.if?.includes("inputs.mode == 'check'"), "Step should only run in check mode");

  // Check the script uses the outputs
  const script = labelStep.with?.script;
  assert.ok(typeof script === "string", "script should be a string");
  assert.ok(script.includes("NEEDS_HUMAN"), "Script should read NEEDS_HUMAN env");
  assert.ok(script.includes("NEEDS_HUMAN_LABEL"), "Script should read NEEDS_HUMAN_LABEL env");
  assert.ok(script.includes("addLabels"), "Script should add label when needs-human is true");
  assert.ok(script.includes("removeLabel"), "Script should remove label when needs-human is false");
});

test("check step extracts needs-human outputs from check result", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  const checkStep = parsed.runs.steps.find(s => s.id === "check" || s.name === "Run Archtour Guardrails Check");
  assert.ok(checkStep, "Check step should exist");

  const runScript = checkStep.run;
  assert.ok(typeof runScript === "string", "run script should be a string");
  assert.ok(runScript.includes("needs-human="), "Script should output needs-human");
  assert.ok(runScript.includes("needs-human-reasons="), "Script should output needs-human-reasons");
  assert.ok(runScript.includes("verdict="), "Script should output verdict");
  assert.ok(runScript.includes("GITHUB_OUTPUT"), "Script should write to GITHUB_OUTPUT");
});

// Orchestrator review of build run 3 (2026-11-24): needsHuman looks only at the files the PR changes, uses the facts'
// own classification (also --migration-dir folders), and lists active blocking findings too.
function needsHumanFor(tmp, extraArgs = []) {
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json", ...extraArgs], { encoding: "utf8" });
  return { r, j: JSON.parse(r.stdout) };
}

test("existing migrations in the repo do not make an app-only PR need a human", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-existing-mig-"));
  try {
    gitInitRepo(tmp);
    fs.mkdirSync(path.join(tmp, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "migrations", "0001_init.sql"), "CREATE TABLE users (id int);\n");
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "app.ts"), "export const a = 1;\n");
    gitCommitAll(tmp, "base");
    fs.writeFileSync(path.join(tmp, "src", "app.ts"), "export const a = 2;\n");
    gitCommitAll(tmp, "head");
    const { r, j } = needsHumanFor(tmp);
    assert.deepEqual(j.needsHuman, { value: false, reasons: [] });
    assert.equal(r.status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a new migration in a --migration-dir folder is a database change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-migdir-"));
  try {
    gitInitRepo(tmp);
    fs.mkdirSync(path.join(tmp, "dbchanges"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "dbchanges", "0001_init.sql"), "CREATE TABLE users (id int);\n");
    gitCommitAll(tmp, "base");
    fs.writeFileSync(path.join(tmp, "dbchanges", "0002_bio.sql"), "ALTER TABLE users ADD COLUMN bio text;\n");
    gitCommitAll(tmp, "head");
    const { j } = needsHumanFor(tmp, ["--migration-dir", "dbchanges"]);
    assert.deepEqual(j.needsHuman, { value: true, reasons: ["database change: dbchanges/0002_bio.sql"] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an active hard finding is listed as a blocking finding (verdict and exit code unchanged)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-hard-"));
  try {
    gitInitRepo(tmp);
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    gitCommitAll(tmp, "base");
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");
    gitCommitAll(tmp, "head");
    const { r, j } = needsHumanFor(tmp);
    assert.deepEqual(j.needsHuman, { value: true, reasons: ["blocking finding: no-privileged-containers"] });
    assert.equal(j.verdict, "failed");
    assert.equal(r.status, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
