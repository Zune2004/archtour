import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/cli.mjs");

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 * 10, ...opts });
}

function makeDirs(baseFiles = {}, headFiles = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "r14-base-"));
  const headDir = fs.mkdtempSync(path.join(os.tmpdir(), "r14-head-"));
  for (const [rel, content] of Object.entries(baseFiles)) {
    fs.mkdirSync(path.dirname(path.join(baseDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(baseDir, rel), content);
  }
  for (const [rel, content] of Object.entries(headFiles)) {
    fs.mkdirSync(path.dirname(path.join(headDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(headDir, rel), content);
  }
  return { baseDir, headDir, cleanup() { fs.rmSync(baseDir, { recursive: true, force: true }); fs.rmSync(headDir, { recursive: true, force: true }); } };
}

function makeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r14-file-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { dir, file, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("review14: linter config changed finding with import", () => {
  const { baseDir, headDir, cleanup } = makeDirs(
    { ".dependency-cruiser-known-violations.json": "[]" },
    { ".dependency-cruiser-known-violations.json": "[1]" }
  );
  const imp = makeTempFile("dc.json", JSON.stringify({ modules: [], summary: { violations: [] } }));
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--import", `depcruise:${imp.file}`, "--json"]);
    const out = JSON.parse(res.stdout);
    const f = out.findings.find(x => x.ruleId === "linter-config-changed");
    assert.ok(f);
    assert.equal(f.level, "soft");
    assert.equal(f.message, `depcruise config changed in this PR: .dependency-cruiser-known-violations.json`);
    assert.equal(f.source.file, ".dependency-cruiser-known-violations.json");
    assert.equal(f.source.line, 1);
    assert.equal(f.entity, "config:.dependency-cruiser-known-violations.json");
    assert.deepEqual(f.owners, []);
    assert.equal(out.needsHuman.reasons.includes("linter config change: .dependency-cruiser-known-violations.json"), true);
    assert.equal(res.status, 2);
  } finally { imp.cleanup(); cleanup(); }
});

test("review14: no linter config finding without import", () => {
  const { baseDir, headDir, cleanup } = makeDirs(
    { ".dependency-cruiser-known-violations.json": "[]" },
    { ".dependency-cruiser-known-violations.json": "[1]" }
  );
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--json"]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.findings.some(x => x.ruleId === "linter-config-changed"), false);
  } finally { cleanup(); }
});

test("review14: buf config changed finding", () => {
  const { baseDir, headDir, cleanup } = makeDirs(
    { "proto/buf.yaml": "version: v1\n" },
    { "proto/buf.yaml": "version: v2\n" }
  );
  const imp = makeTempFile("buf.jsonl", "");
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--import", `buf:${imp.file}`, "--json"]);
    const out = JSON.parse(res.stdout);
    const f = out.findings.find(x => x.ruleId === "linter-config-changed");
    assert.ok(f);
    assert.equal(f.message, "buf config changed in this PR: proto/buf.yaml");
  } finally { imp.cleanup(); cleanup(); }
});

test("review14: unknown depcruise violation type exits 3", () => {
  const { baseDir, headDir, cleanup } = makeDirs({}, {});
  const imp = makeTempFile("dc.json", JSON.stringify({ modules: [], summary: { violations: [
    { type: "foo", from: "a.js", to: "b.js", rule: { severity: "warn", name: "r" } }
  ] } }));
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--import", `depcruise:${imp.file}`, "--json"]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /violation 1 is not a dependency-cruiser violation/);
  } finally { imp.cleanup(); cleanup(); }
});

test("review14: owners without level keeps mapped level", () => {
  const { baseDir, headDir, cleanup } = makeDirs({}, {});
  const imp = makeTempFile("dc.json", JSON.stringify({ modules: [], summary: { violations: [
    { from: "src/a.js", to: "src/b.js", rule: { severity: "warn", name: "no-circular" } }
  ] } }));
  const rules = makeTempFile("rules.yml", `version: 1\nrules:\n  - id: depcruise/*\n    owners: ["@arch"]\n`);
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--rules", rules.file, "--import", `depcruise:${imp.file}`, "--json"]);
    const out = JSON.parse(res.stdout);
    const f = out.findings.find(x => x.ruleId === "depcruise/no-circular");
    assert.ok(f);
    assert.equal(f.level, "warn");
    assert.deepEqual(f.owners, ["@arch"]);
  } finally { imp.cleanup(); rules.cleanup(); cleanup(); }
});

test("review14: cycle entity names whole cycle", () => {
  const { baseDir, headDir, cleanup } = makeDirs({}, {});
  const imp = makeTempFile("dc.json", JSON.stringify({ modules: [], summary: { violations: [
    { type: "cycle", from: "src/a.js", to: "src/b.js", cycle: [{ name: "src/b.js" }, { name: "src/a.js" }], rule: { severity: "warn", name: "no-circular" } }
  ] } }));
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--import", `depcruise:${imp.file}`, "--json"]);
    const out = JSON.parse(res.stdout);
    const f = out.findings.find(x => x.ruleId === "depcruise/no-circular");
    assert.ok(f);
    assert.equal(f.entity, "cycle:src/a.js -> src/b.js -> src/a.js");
  } finally { imp.cleanup(); cleanup(); }
});

// Orchestrator (2026-11-27): the cases the worker run did not cover.
function gitRepo(baseFiles, headFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r14-git-"));
  const git = (...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const write = (files) => {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  };
  write(baseFiles);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  write(headFiles);
  git("add", "-A");
  git("commit", "-q", "-m", "pr");
  return { dir, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("review14: --changed-from: a PR that edits the known-violations file is blocked, and can be overridden", () => {
  const repo = gitRepo({ ".dependency-cruiser-known-violations.json": "[]\n", "src/a.js": "x\n" },
    { ".dependency-cruiser-known-violations.json": "[{\"from\":\"src/a.js\"}]\n" });
  const imp = makeTempFile("dc.json", JSON.stringify({ modules: [], summary: { violations: [] } }));
  try {
    const res = run(["check", "--changed-from", "HEAD~1", repo.dir, "--import", `depcruise:${imp.file}`, "--json"]);
    assert.strictEqual(res.status, 2, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepStrictEqual(out.findings.map((f) => [f.ruleId, f.level, f.message]),
      [["linter-config-changed", "soft", "depcruise config changed in this PR: .dependency-cruiser-known-violations.json"]]);
    assert.deepStrictEqual(out.needsHuman.reasons,
      ["linter config change: .dependency-cruiser-known-violations.json", "blocking finding: linter-config-changed"]);

    const ovr = run(["check", "--changed-from", "HEAD~1", repo.dir, "--import", `depcruise:${imp.file}`, "--json",
      "--override", "linter-config-changed", "--override-by", "bob", "--override-reason", "legacy violation accepted",
      // No owners: anyone with write access who is not the PR author may override (as for policy-changed).
      "--override-permission", "write", "--pr-author", "alice"]);
    assert.strictEqual(ovr.status, 0, ovr.stderr);
    assert.strictEqual(JSON.parse(ovr.stdout).findings[0].overridden, true);
  } finally { imp.cleanup(); repo.cleanup(); }
});

test("review14: a built-in rule without level still exits 3", () => {
  const { baseDir, headDir, cleanup } = makeDirs({}, {});
  const rules = makeTempFile("rules.yml", "version: 1\nrules:\n  - id: sql-no-drop-column\n    owners: [\"@db\"]\n");
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--rules", rules.file, "--json"]);
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stdout, "");
    assert.match(res.stderr, /^archtour: .*Rule "sql-no-drop-column" has invalid field "level": "undefined"/m);
  } finally { rules.cleanup(); cleanup(); }
});

test("review14: an exception for the a<->b cycle does not except a new a<->c cycle", () => {
  const { baseDir, headDir, cleanup } = makeDirs({}, {});
  const imp = makeTempFile("dc.json", JSON.stringify({ modules: [], summary: { violations: [
    { type: "cycle", from: "src/a.js", to: "src/b.js", cycle: [{ name: "src/b.js" }, { name: "src/a.js" }], rule: { severity: "error", name: "no-circular" } },
    { type: "cycle", from: "src/a.js", to: "src/c.js", cycle: [{ name: "src/c.js" }, { name: "src/a.js" }], rule: { severity: "error", name: "no-circular" } }
  ] } }));
  const exc = makeTempFile("exceptions.yml", "- rule: depcruise/no-circular\n  target: \"src/a.js -> src/b.js -> src/a.js\"\n  reason: known\n  owner: \"@arch\"\n  expires: \"2026-12-31\"\n");
  try {
    const res = run(["check", baseDir, headDir, "--policy-from", "head", "--import", `depcruise:${imp.file}`,
      "--exceptions", exc.file, "--now", "2026-11-27", "--json"]);
    assert.strictEqual(res.status, 2, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepStrictEqual(out.findings.map((f) => [f.entity, Boolean(f.excepted)]),
      [["cycle:src/a.js -> src/b.js -> src/a.js", true], ["cycle:src/a.js -> src/c.js -> src/a.js", false]]);
  } finally { imp.cleanup(); exc.cleanup(); cleanup(); }
});
