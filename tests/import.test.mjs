// Acceptance tests for T-115 adapter mode (Squawk, oasdiff, buf).
//
// The fixtures are the exact shapes the tools write. JSON and JSON Lines cannot
// carry comments without breaking the production parsers, so every fixture is
// described in tests/fixtures/import/README.md instead.
//
// Every assertion below compares a whole value (the finding object, the summary,
// the needsHuman object, the markdown report or the stderr line) to an exact
// expected value. None of them decides a pass by searching output for a
// substring.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "yaml";

const CLI = path.resolve("tools/cli.mjs");
const FIXTURES = path.resolve("tests/fixtures/import");
const SQUAWK_FIXTURE = path.join(FIXTURES, "squawk-ban-drop-column.json");
const OASDIFF_ERR_FIXTURE = path.join(FIXTURES, "oasdiff-api-path-removed.json");
const OASDIFF_WARN_FIXTURE = path.join(FIXTURES, "oasdiff-warn.json");
const OASDIFF_INFO_FIXTURE = path.join(FIXTURES, "oasdiff-info.json");
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
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-import-base-"));
  const headDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-import-head-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-import-file-"));
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

function expectedSummary({ total, blocking = 0, overridden = 0, excepted = 0, warnings = 0, hard = 0, soft = 0, warn = 0, advisory = 0 }) {
  return { total, blocking, overridden, excepted, warnings, hard, soft, warn, advisory };
}

function expectedNeedsHuman(reasons) {
  return { value: reasons.length > 0, reasons };
}

function squawkFinding(line, message = "Dropping a column is destructive and breaks running queries.") {
  return {
    ruleId: "squawk/ban-drop-column",
    level: "soft",
    message,
    source: { file: "migrations/0002.sql", line },
    entity: "file:migrations/0002.sql",
    entityId: "file:migrations/0002.sql",
    event: {
      type: "imported.squawk",
      entityId: "file:migrations/0002.sql",
      kind: "file",
      source: { file: "migrations/0002.sql", line },
      message
    },
    owners: [],
    docs: null,
    adjustable: true
  };
}

const OASDIFF_ERR_FINDING = {
  ruleId: "oasdiff/api-path-removed-without-deprecation",
  level: "soft",
  message: "API path /users was removed without deprecation",
  source: { file: "openapi.yaml", line: 12 },
  entity: "api.route:GET /users",
  entityId: "api.route:GET /users",
  event: {
    type: "imported.oasdiff",
    entityId: "api.route:GET /users",
    kind: "api.route",
    source: { file: "openapi.yaml", line: 12 },
    message: "API path /users was removed without deprecation"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const OASDIFF_WARN_FINDING = {
  ruleId: "oasdiff/request-property-type-changed",
  level: "warn",
  message: "Property type changed",
  source: { file: "openapi.yaml", line: 42 },
  entity: "api.route:POST /items",
  entityId: "api.route:POST /items",
  event: {
    type: "imported.oasdiff",
    entityId: "api.route:POST /items",
    kind: "api.route",
    source: { file: "openapi.yaml", line: 42 },
    message: "Property type changed"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const OASDIFF_INFO_FINDING = {
  ruleId: "oasdiff/description-changed",
  level: "advisory",
  message: "Description changed",
  source: { file: "openapi.yaml", line: 10 },
  entity: "api.route:GET /users",
  entityId: "api.route:GET /users",
  event: {
    type: "imported.oasdiff",
    entityId: "api.route:GET /users",
    kind: "api.route",
    source: { file: "openapi.yaml", line: 10 },
    message: "Description changed"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const BUF_FIELD_FINDING = {
  ruleId: "buf/FIELD_SAME_TYPE",
  level: "soft",
  message: "Field 'name' type changed from string to bytes",
  source: { file: "proto/user.proto", line: 8 },
  entity: "file:proto/user.proto",
  entityId: "file:proto/user.proto",
  event: {
    type: "imported.buf",
    entityId: "file:proto/user.proto",
    kind: "file",
    source: { file: "proto/user.proto", line: 8 },
    message: "Field 'name' type changed from string to bytes"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const BUF_FILE_FINDING = {
  ruleId: "buf/FILE_NO_DELETE",
  level: "soft",
  message: "File 'proto/old.proto' was deleted",
  source: { file: "unknown", line: 1 },
  entity: "file:unknown",
  entityId: "file:unknown",
  event: {
    type: "imported.buf",
    entityId: "file:unknown",
    kind: "file",
    source: { file: "unknown", line: 1 },
    message: "File 'proto/old.proto' was deleted"
  },
  owners: [],
  docs: null,
  adjustable: true
};

test("squawk: JSON array item becomes a soft finding at 1-based line", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "warning");
    assert.strictEqual(parsed.exitCode, 2);
    assert.deepStrictEqual(parsed.findings, [squawkFinding(1)]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, blocking: 1, soft: 1 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: squawk/ban-drop-column"]));
  } finally {
    cleanup();
  }
});

test("squawk: --changed-from includes imported findings", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-import-git-"));
  try {
    spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["config", "core.autocrlf", "false"], { cwd: repo, encoding: "utf8" });
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    spawnSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "base"], { cwd: repo, encoding: "utf8" });
    fs.writeFileSync(path.join(repo, "README.md"), "head\n");
    spawnSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "head"], { cwd: repo, encoding: "utf8" });

    const res = run([
      "check",
      "--changed-from", "HEAD~1",
      repo,
      "--import", `squawk:${SQUAWK_FIXTURE}`,
      "--json"
    ]);
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [squawkFinding(1)]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, blocking: 1, soft: 1 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: squawk/ban-drop-column"]));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("oasdiff: level 3 -> soft, 2 -> warn, 1 -> advisory", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const err = runCheck({ baseDir, headDir, imports: [`oasdiff:${OASDIFF_ERR_FIXTURE}`] });
    assert.strictEqual(err.status, 2, err.stderr);
    const errParsed = parseJson(err);
    assert.strictEqual(errParsed.verdict, "warning");
    assert.deepStrictEqual(errParsed.findings, [OASDIFF_ERR_FINDING]);
    assert.deepStrictEqual(errParsed.summary, expectedSummary({ total: 1, blocking: 1, soft: 1 }));

    const warn = runCheck({ baseDir, headDir, imports: [`oasdiff:${OASDIFF_WARN_FIXTURE}`] });
    assert.strictEqual(warn.status, 0, warn.stderr);
    const warnParsed = parseJson(warn);
    assert.strictEqual(warnParsed.verdict, "passed");
    assert.deepStrictEqual(warnParsed.findings, [OASDIFF_WARN_FINDING]);
    assert.deepStrictEqual(warnParsed.summary, expectedSummary({ total: 1, warnings: 1, warn: 1 }));
    assert.deepStrictEqual(warnParsed.needsHuman, expectedNeedsHuman([]));

    const info = runCheck({ baseDir, headDir, imports: [`oasdiff:${OASDIFF_INFO_FIXTURE}`] });
    assert.strictEqual(info.status, 0, info.stderr);
    const infoParsed = parseJson(info);
    assert.strictEqual(infoParsed.verdict, "passed");
    assert.deepStrictEqual(infoParsed.findings, [OASDIFF_INFO_FINDING]);
    assert.deepStrictEqual(infoParsed.summary, expectedSummary({ total: 1, warnings: 1, advisory: 1 }));
    assert.deepStrictEqual(infoParsed.needsHuman, expectedNeedsHuman([]));
  } finally {
    cleanup();
  }
});

test("buf: JSON Lines annotations become soft findings", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`buf:${BUF_FIXTURE}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [BUF_FIELD_FINDING, BUF_FILE_FINDING]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 2, blocking: 2, soft: 2 }));
    assert.deepStrictEqual(
      parsed.needsHuman,
      expectedNeedsHuman([
        "blocking finding: buf/FIELD_SAME_TYPE",
        "blocking finding: buf/FILE_NO_DELETE"
      ])
    );
  } finally {
    cleanup();
  }
});

test("buf: annotation without path becomes file unknown", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const file = path.join(FIXTURES, "buf-file-no-delete.jsonl");
    const res = runCheck({ baseDir, headDir, imports: [`buf:${file}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [BUF_FILE_FINDING]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, blocking: 1, soft: 1 }));
  } finally {
    cleanup();
  }
});

test("buf: empty file is valid", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const file = path.join(FIXTURES, "buf-empty.jsonl");
    const res = runCheck({ baseDir, headDir, imports: [`buf:${file}`] });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "passed");
    assert.deepStrictEqual(parsed.findings, []);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 0 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman([]));
  } finally {
    cleanup();
  }
});

test("rules.yml: explicit imported id sets level, owners and message", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/ban-drop-column
    level: hard
    owners: ["@db-team"]
    message: "Column drops need a backfill plan"
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`squawk:${SQUAWK_FIXTURE}`],
      rulesFile: rules.file
    });
    assert.strictEqual(res.status, 1, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "failed");
    assert.deepStrictEqual(parsed.findings, [{
      ...squawkFinding(1),
      level: "hard",
      message: "Column drops need a backfill plan",
      owners: ["@db-team"]
    }]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, blocking: 1, hard: 1 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: squawk/ban-drop-column"]));
  } finally {
    rules.cleanup();
    cleanup();
  }
});

test("rules.yml: tool wildcard with where turns off only matching items", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: oasdiff/*
    level: off
    where:
      level: warn
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`oasdiff:${OASDIFF_WARN_FIXTURE}`, `oasdiff:${OASDIFF_ERR_FIXTURE}`],
      rulesFile: rules.file
    });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [OASDIFF_ERR_FINDING]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, blocking: 1, soft: 1 }));
    assert.deepStrictEqual(
      parsed.needsHuman,
      expectedNeedsHuman(["blocking finding: oasdiff/api-path-removed-without-deprecation"])
    );
  } finally {
    rules.cleanup();
    cleanup();
  }
});

test("imported findings: override clears the finding and audits it", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/ban-drop-column
    level: soft
    owners: ["alice"]
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`squawk:${SQUAWK_FIXTURE}`],
      rulesFile: rules.file,
      extraArgs: [
        "--override", "squawk/ban-drop-column",
        "--override-by", "alice",
        "--override-reason", "Emergency migration",
        "--now", "2026-11-27"
      ]
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "passed");
    assert.deepStrictEqual(parsed.findings, [{
      ...squawkFinding(1),
      owners: ["alice"],
      overridden: true,
      overriddenBy: "alice",
      overrideReason: "Emergency migration"
    }]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, overridden: 1 }));
    assert.deepStrictEqual(parsed.overrides, [{
      ruleId: "squawk/ban-drop-column",
      entityId: "file:migrations/0002.sql",
      overriddenBy: "alice",
      reason: "Emergency migration",
      timestamp: "2026-11-27T00:00:00.000Z"
    }]);
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: squawk/ban-drop-column"]));
  } finally {
    rules.cleanup();
    cleanup();
  }
});

test("imported findings: exception clears the finding", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: squawk/ban-drop-column
  target: "file:migrations/0002.sql"
  reason: "Legacy cleanup approved"
  owner: "@db-team"
  expires: "2027-06-01"
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`squawk:${SQUAWK_FIXTURE}`],
      exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-11-14"]
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "passed");
    assert.deepStrictEqual(parsed.findings, [{
      ...squawkFinding(1),
      excepted: true,
      exception: {
        rule: "squawk/ban-drop-column",
        target: "file:migrations/0002.sql",
        reason: "Legacy cleanup approved",
        owner: "@db-team",
        expires: "2027-06-01",
        line: 1,
        file: exceptions.file,
        expired: false
      }
    }]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, excepted: 1 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman([]));
  } finally {
    exceptions.cleanup();
    cleanup();
  }
});

test("imported findings: baseline ratchet counts imported ids", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const baseline = makeTempFile("baseline.json", JSON.stringify({ "squawk/ban-drop-column": 1 }));
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`squawk:${path.join(FIXTURES, "squawk-two-drops.json")}`],
      baselineFile: baseline.file
    });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(
      { ...parsed.findings[0], source: { ...parsed.findings[0].source, file: path.basename(parsed.findings[0].source.file) } },
      {
        ruleId: "squawk/ban-drop-column",
        level: "soft",
        message: "ratchet: squawk/ban-drop-column 1 -> 2",
        owners: [],
        docs: null,
        source: { file: "baseline.json", line: 1 }
      }
    );
    assert.deepStrictEqual(parsed.findings.slice(1), [squawkFinding(1), squawkFinding(2)]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 3, blocking: 3, soft: 3 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: squawk/ban-drop-column"]));
  } finally {
    baseline.cleanup();
    cleanup();
  }
});

test("imported findings: needs-human names the blocking imported rule", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${SQUAWK_FIXTURE}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: squawk/ban-drop-column"]));
  } finally {
    cleanup();
  }
});

test("imported findings: markdown report", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/ban-drop-column
    level: soft
`);
  const mdFile = path.join(headDir, "report.md");
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`squawk:${SQUAWK_FIXTURE}`],
      rulesFile: rules.file,
      extraArgs: ["--md", mdFile]
    });
    assert.strictEqual(res.status, 2, res.stderr);
    assert.strictEqual(
      fs.readFileSync(mdFile, "utf8"),
      "## ⚠️ Architecture Guardrails: Blocked (soft) (1 blocking, 0 overridden, 0 excepted, 0 warnings, 0 advisory)\n" +
      "Needs a human: yes (blocking finding: squawk/ban-drop-column)\n" +
      "\n" +
      "### ⚠️ Soft (1)\n" +
      "- **Dropping a column is destructive and breaks running queries.** (`squawk/ban-drop-column`)\n" +
      "  - Entity: `file:migrations/0002.sql`\n" +
      "  - File: `migrations/0002.sql:1`\n" +
      "  - Owners: none\n" +
      "\n" +
      "To override: `/archtour override squawk/ban-drop-column <sha> <reason>`\n"
    );
  } finally {
    rules.cleanup();
    cleanup();
  }
});

test("import errors: missing file", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: ["squawk:/nonexistent/path.json"] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), "archtour: --import squawk:/nonexistent/path.json: file not found");
  } finally {
    cleanup();
  }
});

test("import errors: invalid JSON", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", "{not json");
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import squawk:${bad.file}: not valid JSON`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("import errors: wrong top-level shape", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("shape.json", '{"not":"an array"}');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import squawk:${bad.file}: not a Squawk JSON array`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("import errors: invalid item", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("item.json", '[{"file":"migrations/0002.sql"}]');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import squawk:${bad.file}: item 1 is not a Squawk violation`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("import errors: empty Squawk file", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("empty.json", "");
  try {
    const res = runCheck({ baseDir, headDir, imports: [`squawk:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import squawk:${bad.file}: not a Squawk JSON array`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("import errors: unknown tool", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: ["unknowntool:somefile.json"] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(
      res.stderr.trimEnd(),
      'archtour: --import unknowntool:somefile.json: unknown tool "unknowntool" (supported: squawk, oasdiff, buf)'
    );
  } finally {
    cleanup();
  }
});

test("import errors: missing tool: prefix", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: ["/some/path.json"] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), 'archtour: --import /some/path.json: expected "tool:path"');
  } finally {
    cleanup();
  }
});

test("import errors: buf line is not an annotation", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.jsonl", '{"type":"FIELD_SAME_TYPE"}');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`buf:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import buf:${bad.file}: line 1: not a buf annotation`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("import errors: oasdiff item is not a change", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", '[{"id":"x","level":9}]');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`oasdiff:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import oasdiff:${bad.file}: item 1 is not an oasdiff change`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("import: repeatable --import accepts multiple tools and files", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [
        `squawk:${SQUAWK_FIXTURE}`,
        `oasdiff:${OASDIFF_ERR_FIXTURE}`,
        `oasdiff:${OASDIFF_WARN_FIXTURE}`
      ]
    });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [squawkFinding(1), OASDIFF_ERR_FINDING, OASDIFF_WARN_FINDING]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 3, blocking: 2, warnings: 1, soft: 2, warn: 1 }));
    assert.deepStrictEqual(
      parsed.needsHuman,
      expectedNeedsHuman([
        "blocking finding: squawk/ban-drop-column",
        "blocking finding: oasdiff/api-path-removed-without-deprecation"
      ])
    );
  } finally {
    cleanup();
  }
});

test("help: check and baseline list --import", () => {
  const checkHelp = run(["help", "check"]);
  assert.strictEqual(checkHelp.status, 0, checkHelp.stderr);
  assert.deepStrictEqual(
    checkHelp.stdout.split(/\r?\n/).filter((line) => line.startsWith("  --import")),
    ["  --import <tool:path>        Import findings from Squawk, oasdiff or buf output (repeatable)"]
  );

  const baselineHelp = run(["help", "baseline"]);
  assert.strictEqual(baselineHelp.status, 0, baselineHelp.stderr);
  assert.deepStrictEqual(
    baselineHelp.stdout.split(/\r?\n/).filter((line) => line.startsWith("  --import")),
    ["  --import <tool:path>        Include imported findings in the baseline (repeatable)"]
  );
});

test("action.yml: import input is passed to the CLI", () => {
  const doc = yaml.parse(fs.readFileSync(path.resolve("action.yml"), "utf8"));
  assert.strictEqual(
    doc.inputs.import.description,
    'Newline-separated "tool:path" pairs for importing Squawk, oasdiff or buf output (for example "squawk:squawk.json"). Run those linters in an earlier step, before Archtour.'
  );
  const checkStep = doc.runs.steps.find((step) => step.id === "check");
  assert.ok(checkStep, "check step not found");
  assert.strictEqual(checkStep.env.INPUT_IMPORT, "${{ inputs.import }}");
  const lines = checkStep.run.split(/\r?\n/);
  const start = lines.indexOf('if [ -n "$INPUT_IMPORT" ]; then');
  assert.notStrictEqual(start, -1, "import block not found in the check step");
  assert.deepStrictEqual(lines.slice(start, start + 8), [
    'if [ -n "$INPUT_IMPORT" ]; then',
    '  while IFS= read -r item; do',
    "    item=$(printf '%s' \"$item\" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/\\r$//')",
    '    if [ -n "$item" ]; then',
    '      CHECK_ARGS+=("--import=$item")',
    '    fi',
    '  done <<< "$INPUT_IMPORT"',
    'fi'
  ]);
});
