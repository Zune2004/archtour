import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

test("needs-human false for ordinary code change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "app.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(tmp, "README.md"), "hi\n");
  const base = gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "src", "app.ts"), "export const x = 2;\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, false);
  assert.deepEqual(j.needsHuman.reasons, []);
});

test("needs-human true for new migration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "migrations", "0001_init.sql"), "CREATE TABLE users (id int);\n");
  const base = gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "migrations", "0002_add_bio.sql"), "ALTER TABLE users ADD COLUMN bio text;\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, true);
  assert.ok(j.needsHuman.reasons.includes("database change: migrations/0002_add_bio.sql"));
  assert.equal(j.verdict, "passed");
  assert.equal(r.status, 0);
});

test("needs-human true for API contract change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-"));
  gitInitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "openapi.yaml"), "openapi: 3.0.0\npaths: {}\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "openapi.yaml"), "openapi: 3.0.0\npaths: {}\ninfo:\n  title: x\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, true);
  assert.ok(j.needsHuman.reasons.some(x => x.startsWith("API contract change: openapi.yaml")));
});

test("needs-human true for policy change", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".archtour", "rules.yml"), "version: 1\nrules:\n  - id: x\n    level: warn\n    on: [db.field_removed]\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, ".archtour", "rules.yml"), "version: 1\nrules:\n  - id: x\n    level: soft\n    on: [db.field_removed]\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp, "--json"], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.needsHuman.value, true);
  assert.ok(j.needsHuman.reasons.includes("Archtour policy change: .archtour/rules.yml"));
});

test("markdown report needs human line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nh-"));
  gitInitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "README.md"), "hi\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "README.md"), "hello\n");
  gitCommitAll(tmp, "head");
  const r = spawnSync(process.execPath, [path.resolve("tools/cli.mjs"), "check", "--changed-from", "HEAD~1", tmp], { encoding: "utf8" });
  assert.match(r.stdout, /Needs a human: no/);
});
