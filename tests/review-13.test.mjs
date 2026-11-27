// Acceptance tests for the review-13 fixes (0.4.0).
// Every acceptance example from the brief gets at least one test here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stripComments } from "../scripts/check-bans.mjs";

const CLI = path.resolve("tools/cli.mjs");
const FIXTURES = path.resolve("tests/fixtures/import");
const SQUAWK_FIXTURE = path.join(FIXTURES, "squawk-ban-drop-column.json");
const OASDIFF_ERR_FIXTURE = path.join(FIXTURES, "oasdiff-api-path-removed.json");
const BUF_FIXTURE = path.join(FIXTURES, "buf-field-same-type.jsonl");

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30000,
    ...opts
  });
}

function writeFiles(dir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function makeDirs(baseFiles = {}, headFiles = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-review13-base-"));
  const headDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-review13-head-"));
  writeFiles(baseDir, baseFiles);
  writeFiles(headDir, headFiles);
  return {
    baseDir,
    headDir,
    cleanup() {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(headDir, { recursive: true, force: true });
    }
  };
}

function makeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-review13-file-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return {
    dir,
    file,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function runCheck({ baseDir, headDir, imports = [], rulesFile, exceptionsFile, baselineFile, extraArgs = [], cwd }) {
  const args = ["check", baseDir, headDir, "--policy-from", "head"];
  if (rulesFile) args.push("--rules", rulesFile);
  if (exceptionsFile) args.push("--exceptions", exceptionsFile);
  if (baselineFile) args.push("--baseline", baselineFile);
  for (const imp of imports) args.push("--import", imp);
  args.push("--json", ...extraArgs);
  return run(args, cwd ? { cwd } : {});
}

function parseJson(res) {
  return JSON.parse(res.stdout);
}

// --- 1. Ban check string-awareness tests (also in check-bans.test.mjs) ---

test("review13: ban check - string with /* does not hide next line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-bans-"));
  try {
    fs.writeFileSync(path.join(dir, "test.mjs"), 'const a = "squawk/*";\nfetch("x");\n');
    const result = spawnSync(process.execPath, [path.resolve("scripts/check-bans.mjs"), dir], { encoding: "utf8" });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /test\.mjs:2: no-network/);
    assert.doesNotMatch(result.stdout, /test.mjs:1: no-network/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review13: ban check - single quoted string with /* does not hide next line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-bans-"));
  try {
    fs.writeFileSync(path.join(dir, "test.mjs"), "const a = 'x/*';\nfetch(\"x\");\n");
    const result = spawnSync(process.execPath, [path.resolve("scripts/check-bans.mjs"), dir], { encoding: "utf8" });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /test\.mjs:2: no-network/);
    assert.doesNotMatch(result.stdout, /test.mjs:1: no-network/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review13: ban check - template literal with // does not hide next line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-bans-"));
  try {
    fs.writeFileSync(path.join(dir, "test.mjs"), 'const a = `a//b`;\nfetch("x");\n');
    const result = spawnSync(process.execPath, [path.resolve("scripts/check-bans.mjs"), dir], { encoding: "utf8" });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /test\.mjs:2: no-network/);
    assert.doesNotMatch(result.stdout, /test.mjs:1: no-network/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review13: ban check - http:// in string does not start line comment on next line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-bans-"));
  try {
    fs.writeFileSync(path.join(dir, "test.mjs"), 'const a = "http://x";\nfetch("x");\n');
    const result = spawnSync(process.execPath, [path.resolve("scripts/check-bans.mjs"), dir], { encoding: "utf8" });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /test\.mjs:2: no-network/);
    assert.doesNotMatch(result.stdout, /test.mjs:1: no-network/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review13: ban check - escaped quote does not end string", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-bans-"));
  try {
    fs.writeFileSync(path.join(dir, "test.mjs"), 'const a = "a\\"/*";\nfetch("x");\n');
    const result = spawnSync(process.execPath, [path.resolve("scripts/check-bans.mjs"), dir], { encoding: "utf8" });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /test\.mjs:2: no-network/);
    assert.doesNotMatch(result.stdout, /test.mjs:1: no-network/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review13: ban check - real tools/cli.mjs and tools/rules.mjs have no code lines hidden", () => {
  const cliPath = path.resolve("tools/cli.mjs");
  const rulesPath = path.resolve("tools/rules.mjs");
  const cliText = fs.readFileSync(cliPath, "utf8");
  const rulesText = fs.readFileSync(rulesPath, "utf8");

  const cliStripped = stripComments(cliText);
  const rulesStripped = stripComments(rulesText);

  // Orchestrator (2026-11-27): list code lines (not empty, not starting a comment) that the stripper blanks.
  // On 4dca968 this listed 1,186 lines of cli.mjs (a "/*" inside the string "squawk/*" opened a comment).
  function hiddenCodeLines(original, stripped) {
    const strippedLines = Array.isArray(stripped) ? stripped : stripped.split("\n");
    const hidden = [];
    original.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
      if (!(strippedLines[i] || "").trim()) hidden.push(i + 1);
    });
    return hidden;
  }

  assert.deepStrictEqual(hiddenCodeLines(cliText, cliStripped), []);
  assert.deepStrictEqual(hiddenCodeLines(rulesText, rulesStripped), []);
});

// --- 2. Imported paths normalisation ---

test("review13: imported paths - squawk ./path normalised", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const squawkFile = makeTempFile("sq.json", '[{"file":"./migrations/0002.sql","line":0,"column":3,"level":"Warning","message":"test","rule_name":"ban-drop-column"}]');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${squawkFile.file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].source.file, "migrations/0002.sql");
    assert.strictEqual(parsed.findings[0].entity, "file:migrations/0002.sql");
  } finally {
    cleanup();
    squawkFile.cleanup();
  }
});

test("review13: imported paths - squawk backslash path normalised", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const squawkFile = makeTempFile("sq.json", '[{"file":"migrations\\\\0002.sql","line":0,"column":3,"level":"Warning","message":"test","rule_name":"ban-drop-column"}]');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${squawkFile.file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].source.file, "migrations/0002.sql");
    assert.strictEqual(parsed.findings[0].entity, "file:migrations/0002.sql");
  } finally {
    cleanup();
    squawkFile.cleanup();
  }
});

test("review13: imported paths - squawk absolute path inside checked folder normalised", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const absPath = path.resolve(headDir, "migrations/0002.sql").replace(/\\/g, "/");
  const squawkFile = makeTempFile("sq.json", `[{"file":"${absPath}","line":0,"column":3,"level":"Warning","message":"test","rule_name":"ban-drop-column"}]`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${squawkFile.file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].source.file, "migrations/0002.sql");
    assert.strictEqual(parsed.findings[0].entity, "file:migrations/0002.sql");
  } finally {
    cleanup();
    squawkFile.cleanup();
  }
});

test("review13: imported paths - oasdiff revisionSource preferred over baseSource", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const oasdiffFile = makeTempFile("oa.json", `[{"id":"test-rule","text":"test","level":3,"operation":"GET","path":"/test","section":"paths","baseSource":{"file":"base.yaml","line":10},"revisionSource":{"file":"head.yaml","line":20}}]`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`oasdiff:${oasdiffFile.file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    // Should use revisionSource (head.yaml) not baseSource
    assert.strictEqual(parsed.findings[0].source.file, "head.yaml");
    assert.strictEqual(parsed.findings[0].source.line, 20);
  } finally {
    cleanup();
    oasdiffFile.cleanup();
  }
});

test("review13: imported paths - buf path normalised", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bufFile = makeTempFile("buf.jsonl", '{"path":"./proto/user.proto","start_line":8,"start_column":12,"end_line":8,"end_column":17,"type":"FIELD_SAME_TYPE","message":"test"}');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`buf:${bufFile.file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].source.file, "proto/user.proto");
    assert.strictEqual(parsed.findings[0].entity, "file:proto/user.proto");
  } finally {
    cleanup();
    bufFile.cleanup();
  }
});

// --- 3. enforce_from for imported ids ---

test("review13: enforce_from on imported id makes finding warn with suffix", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/ban-drop-column
    level: hard
    enforce_from: "2099-01-01"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], rulesFile: rules.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 0, res.stderr); // warn = exit 0
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].level, "warn");
    assert.match(parsed.findings[0].message, /\(becomes hard on 2099-01-01\)$/);
    assert.strictEqual(parsed.verdict, "passed");
  } finally {
    cleanup();
    rules.cleanup();
  }
});

test("review13: enforce_from on tool wildcard works", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: buf/*
    level: hard
    enforce_from: "2099-01-01"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`buf:${BUF_FIXTURE}`], rulesFile: rules.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 0, res.stderr); // warn = exit 0
    const parsed = parseJson(res);
    for (const f of parsed.findings) {
      assert.strictEqual(f.level, "warn");
      assert.match(f.message, /\(becomes hard on 2099-01-01\)$/);
    }
  } finally {
    cleanup();
    rules.cleanup();
  }
});

// --- 4. Exceptions accept <tool>/* ---

test("review13: exception with buf/* wildcard works", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  // Orchestrator: a tool wildcard needs a specific target ("*" exits 3), so only the user.proto item is excepted.
  const exceptions = makeTempFile("exceptions.yml", `- rule: buf/*
  target: "proto/user.proto"
  reason: "Known issue"
  owner: "@team"
  expires: "2026-12-31"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`buf:${BUF_FIXTURE}`], exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    const bufField = parsed.findings.find(f => f.ruleId === "buf/FIELD_SAME_TYPE");
    assert.ok(bufField, "buf/FIELD_SAME_TYPE finding should exist");
    assert.strictEqual(bufField.excepted, true);
    assert.strictEqual(bufField.exception.rule, "buf/*");
    const fileDelete = parsed.findings.find(f => f.ruleId === "buf/FILE_NO_DELETE");
    assert.strictEqual(fileDelete.excepted, undefined);
    assert.strictEqual(fileDelete.level, "soft");
  } finally {
    cleanup();
    exceptions.cleanup();
  }
});

test("review13: exception with squawk/* wildcard works", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: squawk/*
  target: "file:migrations/0002.sql"
  reason: "Known issue"
  owner: "@team"
  expires: "2026-12-31"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].excepted, true);
    assert.strictEqual(parsed.findings[0].exception.rule, "squawk/*");
  } finally {
    cleanup();
    exceptions.cleanup();
  }
});

test("review13: exception with oasdiff/* wildcard works", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: oasdiff/*
  target: "GET /users"
  reason: "Known issue"
  owner: "@team"
  expires: "2026-12-31"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`oasdiff:${OASDIFF_ERR_FIXTURE}`], exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].excepted, true);
    assert.strictEqual(parsed.findings[0].exception.rule, "oasdiff/*");
  } finally {
    cleanup();
    exceptions.cleanup();
  }
});

test("review13: exception with non-tool wildcard (sql-*) exits 3", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: sql-*
  target: "file:migrations/0002.sql"
  reason: "Known issue"
  owner: "@team"
  expires: "2026-12-31"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 3, res.stderr);
    // Orchestrator: sql-* matches several built-in rules, so the existing (0.3.x) rejection applies.
    assert.match(res.stderr, /exception rule "sql-\*" cannot be "\*" or match multiple rules$/m);
  } finally {
    cleanup();
    exceptions.cleanup();
  }
});

// Orchestrator (2026-11-27): <tool>/* can include imported ids that rules.yml makes hard, and hard rules are only
// excepted per target, so a tool wildcard with target "*" is rejected.
test("review13: exception with squawk/* and target * exits 3", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: squawk/*
  target: "*"
  reason: "Known issue"
  owner: "@team"
  expires: "2026-12-31"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 3, res.stderr);
    assert.match(res.stderr, /hard rule "squawk\/\*" cannot have wildcard target "\*"$/m);
  } finally {
    cleanup();
    exceptions.cleanup();
  }
});

test("review13: explicit exception id still works", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: squawk/ban-drop-column
  target: "file:migrations/0002.sql"
  reason: "Known issue"
  owner: "@team"
  expires: "2026-12-31"
`);
  try {
    const res = runCheck({
      baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-01-01"]
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].excepted, true);
    assert.strictEqual(parsed.findings[0].exception.rule, "squawk/ban-drop-column");
  } finally {
    cleanup();
    exceptions.cleanup();
  }
});

// --- 5. Custom message on imported-id rule keeps tool text ---

test("review13: custom message on imported id prepends tool message", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/ban-drop-column
    level: soft
    message: "Custom rule message"
`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], rulesFile: rules.file });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    // Should be "Custom rule message - <original tool message>"
    assert.match(parsed.findings[0].message, /^Custom rule message - Dropping a column is destructive and breaks running queries\.$/);
  } finally {
    cleanup();
    rules.cleanup();
  }
});

test("review13: custom message on tool wildcard prepends tool message", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: oasdiff/*
    level: soft
    message: "API change detected"
`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`oasdiff:${OASDIFF_ERR_FIXTURE}`], rulesFile: rules.file });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.match(parsed.findings[0].message, /^API change detected - API path \/users was removed without deprecation$/);
  } finally {
    cleanup();
    rules.cleanup();
  }
});

// --- 6. Small fail-closed fixes ---

test("review13: import error in --changed-from mode calls policyCleanup (no leaked temp folder)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-review13-git-"));
  try {
    spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo, encoding: "utf8" });
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    spawnSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "base"], { cwd: repo, encoding: "utf8" });
    fs.writeFileSync(path.join(repo, "README.md"), "head\n");
    spawnSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "head"], { cwd: repo, encoding: "utf8" });

    const tempDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
    const before = fs.readdirSync(tempDir).filter(f => f.startsWith("archtour-base-policy-")).length;

    const res = run([
      "check",
      "--changed-from", "HEAD~1",
      repo,
      "--import", "squawk:/nonexistent.json",
      "--json"
    ]);
    assert.strictEqual(res.status, 3);
    assert.match(res.stderr, /file not found/);

    const after = fs.readdirSync(tempDir).filter(f => f.startsWith("archtour-base-policy-")).length;
    assert.strictEqual(after, before, `Temp folder count grew from ${before} to ${after}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("review13: UTF-8 BOM at start of import file is ignored", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bomContent = "\uFEFF" + '[{"file":"migrations/0002.sql","line":0,"column":3,"level":"Warning","message":"test","rule_name":"ban-drop-column"}]';
  const squawkFile = makeTempFile("sq.json", bomContent);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${squawkFile.file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].source.file, "migrations/0002.sql");
  } finally {
    cleanup();
    squawkFile.cleanup();
  }
});

test("review13: large Squawk array (150k items) does not crash with stack overflow", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const items = [];
  for (let i = 0; i < 150000; i++) {
    items.push({ file: "migrations/0002.sql", line: 0, column: 3, level: "Warning", message: "test", rule_name: "ban-drop-column" });
  }
  const squawkFile = makeTempFile("sq.json", JSON.stringify(items));
  try {
    // Orchestrator: list one finding only; 150,000 findings as JSON overflow spawnSync's output buffer.
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${squawkFile.file}`], extraArgs: ["--only", "soft", "--limit", "1"] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings.length, 1);
    assert.strictEqual(parsed.summary.soft, 150000);
  } finally {
    cleanup();
    squawkFile.cleanup();
  }
});

test("review13: --import on facts command exits 3", () => {
  const res = run(["facts", ".", "--import", "squawk:squawk.json", "--json"]);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /--import is only for check and baseline/);
});

test("review13: --import on audit-history command exits 3", () => {
  const res = run(["audit-history", ".", "--import", "squawk:squawk.json", "--json"]);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /--import is only for check and baseline/);
});

test("review13: --import on scan command exits 3", () => {
  const res = run(["scan", ".", "--import", "squawk:squawk.json", "--json"]);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /--import is only for check and baseline/);
});

test("review13: --import on changes command exits 3", () => {
  const res = run(["changes", ".", ".", "--import", "squawk:squawk.json", "--json"]);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /--import is only for check and baseline/);
});

// --- 7. where.level matches level after default mapping ---

test("review13: where.level matches Squawk Warning as soft", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/*
    level: off
    where:
      level: soft
`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`], rulesFile: rules.file });
    // Squawk Warning -> soft, so where.level: soft should match and turn it off
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings.length, 0);
  } finally {
    cleanup();
    rules.cleanup();
  }
});

test("review13: where.level matches oasdiff level 3 as soft", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: oasdiff/*
    level: off
    where:
      level: soft
`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`oasdiff:${OASDIFF_ERR_FIXTURE}`], rulesFile: rules.file });
    // oasdiff level 3 -> soft, so where.level: soft should match and turn it off
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings.length, 0);
  } finally {
    cleanup();
    rules.cleanup();
  }
});

test("review13: where.level matches buf as soft", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: buf/*
    level: off
    where:
      level: soft
`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`buf:${BUF_FIXTURE}`], rulesFile: rules.file });
    // buf -> soft, so where.level: soft should match and turn it off
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings.length, 0);
  } finally {
    cleanup();
    rules.cleanup();
  }
});