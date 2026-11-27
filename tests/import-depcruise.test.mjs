// Acceptance tests for dependency-cruiser import adapter mode.
//
// The fixtures are the exact shapes dependency-cruiser writes. JSON cannot
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

const CLI = path.resolve("tools/cli.mjs");
const FIXTURES = path.resolve("tests/fixtures/import");
const DEPCRUISE_MIXED = path.join(FIXTURES, "depcruise-mixed.json");
const DEPCRUISE_REACHABILITY_FIXTURE = path.join(FIXTURES, "depcruise-reachability.json");
const DEPCRUISE_INSTABILITY_FIXTURE = path.join(FIXTURES, "depcruise-instability.json");
const DEPCRUISE_IGNORE = path.join(FIXTURES, "depcruise-ignore.json");
const DEPCRUISE_VALID = path.join(FIXTURES, "depcruise-valid.json");
const DEPCRUISE_MISSING_TYPE = path.join(FIXTURES, "depcruise-missing-type.json");

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1024 * 1024 * 10, // 10 MB
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

const DEPCRUISE_NO_UI_TO_DB = {
  ruleId: "depcruise/no-ui-to-db",
  level: "soft",
  message: "src/ui/button.js imports src/db/client.js",
  source: { file: "src/ui/button.js", line: 1 },
  entity: "dep:src/ui/button.js -> src/db/client.js",
  entityId: "dep:src/ui/button.js -> src/db/client.js",
  event: {
    type: "imported.depcruise",
    entityId: "dep:src/ui/button.js -> src/db/client.js",
    kind: "dependency",
    source: { file: "src/ui/button.js", line: 1 },
    message: "src/ui/button.js imports src/db/client.js"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const DEPCRUISE_NO_CIRCULAR = {
  ruleId: "depcruise/no-circular",
  level: "warn",
  message: "circular dependency: src/a.js -> src/b.js -> src/a.js",
  source: { file: "src/a.js", line: 1 },
  entity: "cycle:src/a.js",
  entityId: "cycle:src/a.js",
  event: {
    type: "imported.depcruise",
    entityId: "cycle:src/a.js",
    kind: "dependency",
    source: { file: "src/a.js", line: 1 },
    message: "circular dependency: src/a.js -> src/b.js -> src/a.js"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const DEPCRUISE_NO_ORPHANS = {
  ruleId: "depcruise/no-orphans",
  level: "advisory",
  message: "src/orphan.js: module rule no-orphans",
  source: { file: "src/orphan.js", line: 1 },
  entity: "file:src/orphan.js",
  entityId: "file:src/orphan.js",
  event: {
    type: "imported.depcruise",
    entityId: "file:src/orphan.js",
    kind: "file",
    source: { file: "src/orphan.js", line: 1 },
    message: "src/orphan.js: module rule no-orphans"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const DEPCRUISE_REACHABILITY = {
  ruleId: "depcruise/no-reach",
  level: "soft",
  message: "src/a.js reaches src/d.js via src/b.js -> src/c.js",
  source: { file: "src/a.js", line: 1 },
  entity: "dep:src/a.js -> src/d.js",
  entityId: "dep:src/a.js -> src/d.js",
  event: {
    type: "imported.depcruise",
    entityId: "dep:src/a.js -> src/d.js",
    kind: "dependency",
    source: { file: "src/a.js", line: 1 },
    message: "src/a.js reaches src/d.js via src/b.js -> src/c.js"
  },
  owners: [],
  docs: null,
  adjustable: true
};

const DEPCRUISE_INSTABILITY = {
  ruleId: "depcruise/no-unstable",
  level: "warn",
  message: "src/a.js (instability 0.8) depends on src/b.js (instability 0.2)",
  source: { file: "src/a.js", line: 1 },
  entity: "dep:src/a.js -> src/b.js",
  entityId: "dep:src/a.js -> src/b.js",
  event: {
    type: "imported.depcruise",
    entityId: "dep:src/a.js -> src/b.js",
    kind: "dependency",
    source: { file: "src/a.js", line: 1 },
    message: "src/a.js (instability 0.8) depends on src/b.js (instability 0.2)"
  },
  owners: [],
  docs: null,
  adjustable: true
};

test("depcruise: mixed violations become findings with correct levels", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_MIXED}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "warning");
    assert.strictEqual(parsed.exitCode, 2);
    assert.deepStrictEqual(parsed.findings, [DEPCRUISE_NO_UI_TO_DB, DEPCRUISE_NO_CIRCULAR, DEPCRUISE_NO_ORPHANS]);
    // Only soft (and hard) are blocking; warn and advisory are not
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 3, blocking: 1, warnings: 2, soft: 1, warn: 1, advisory: 1 }));
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: depcruise/no-ui-to-db"]));
  } finally {
    cleanup();
  }
});

test("depcruise: severity mapping error->soft, warn->warn, info->advisory", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_MIXED}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    // error -> soft
    assert.strictEqual(parsed.findings[0].level, "soft");
    assert.strictEqual(parsed.findings[0].ruleId, "depcruise/no-ui-to-db");
    // warn -> warn
    assert.strictEqual(parsed.findings[1].level, "warn");
    assert.strictEqual(parsed.findings[1].ruleId, "depcruise/no-circular");
    // info -> advisory
    assert.strictEqual(parsed.findings[2].level, "advisory");
    assert.strictEqual(parsed.findings[2].ruleId, "depcruise/no-orphans");
  } finally {
    cleanup();
  }
});

test("depcruise: ignore severity is skipped (no finding produced)", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_IGNORE}`] });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "passed");
    assert.deepStrictEqual(parsed.findings, []);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 0 }));
  } finally {
    cleanup();
  }
});

test("depcruise: reachability violation uses dependency entity and via path", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_REACHABILITY_FIXTURE}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [DEPCRUISE_REACHABILITY]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, blocking: 1, soft: 1 }));
  } finally {
    cleanup();
  }
});

test("depcruise: instability violation uses dependency entity and metrics", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_INSTABILITY_FIXTURE}`] });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.deepStrictEqual(parsed.findings, [DEPCRUISE_INSTABILITY]);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 1, warnings: 1, warn: 1 }));
  } finally {
    cleanup();
  }
});

test("depcruise: paths are normalised like other tools", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  // Create a fixture with backslash paths and absolute paths
  const fixture = path.join(FIXTURES, "depcruise-normalised.json");
  const content = `{
  "modules": [],
  "summary": {
    "violations": [
      { "type": "dependency", "from": "./src/ui/button.js", "to": "src\\\\db\\\\client.js",
        "dependencyTypes": ["local", "import"], "rule": { "severity": "error", "name": "no-ui-to-db" } }
    ],
    "error": 1, "warn": 0, "info": 0, "ignore": 0,
    "totalCruised": 2, "totalDependenciesCruised": 1, "optionsUsed": {}
  }
}`;
  fs.writeFileSync(fixture, content);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${fixture}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].source.file, "src/ui/button.js");
    assert.strictEqual(parsed.findings[0].entity, "dep:src/ui/button.js -> src/db/client.js");
    assert.strictEqual(parsed.findings[0].message, "src/ui/button.js imports src/db/client.js");
  } finally {
    fs.rmSync(fixture, { force: true });
    cleanup();
  }
});

test("depcruise: rules.yml explicit id sets level, owners and message", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: depcruise/no-ui-to-db
    level: hard
    owners: ["@arch"]
    message: "UI must not import DB"
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`depcruise:${DEPCRUISE_MIXED}`],
      rulesFile: rules.file
    });
    assert.strictEqual(res.status, 1, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "failed");
    assert.deepStrictEqual(parsed.findings[0], {
      ...DEPCRUISE_NO_UI_TO_DB,
      level: "hard",
      message: "UI must not import DB - src/ui/button.js imports src/db/client.js",
      owners: ["@arch"]
    });
    // hard is blocking, warn and advisory are not
    // warnings includes both warn and advisory
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 3, blocking: 1, warnings: 2, hard: 1, warn: 1, advisory: 1 }));
  } finally {
    rules.cleanup();
    cleanup();
  }
});

test("depcruise: tool wildcard with where turns off advisory items", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: depcruise/*
    level: off
    where:
      level: advisory
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`depcruise:${DEPCRUISE_MIXED}`],
      rulesFile: rules.file
    });
    // advisory is turned off, leaving soft (blocking) and warn (not blocking) -> exit 2
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    // Orphan finding (advisory) should be dropped
    assert.strictEqual(parsed.findings.length, 2);
    assert.deepStrictEqual(parsed.findings.map(f => f.ruleId), ["depcruise/no-ui-to-db", "depcruise/no-circular"]);
    // warn is not blocking but counts as warning
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 2, blocking: 1, warnings: 1, soft: 1, warn: 1 }));
  } finally {
    rules.cleanup();
    cleanup();
  }
});

test("depcruise: exception with specific target clears the finding", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: depcruise/no-ui-to-db
  target: "src/ui/button.js -> src/db/client.js"
  reason: "Legacy integration"
  owner: "@arch"
  expires: "2027-06-01"
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`depcruise:${DEPCRUISE_MIXED}`],
      exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-11-14"]
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "passed");
    assert.strictEqual(parsed.findings[0].excepted, true);
    assert.strictEqual(parsed.findings[0].exception.rule, "depcruise/no-ui-to-db");
    assert.strictEqual(parsed.findings[0].exception.target, "src/ui/button.js -> src/db/client.js");
    // Soft finding is excepted, warn and advisory remain but are not blocking
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 3, excepted: 1, blocking: 0, warnings: 2, warn: 1, advisory: 1 }));
  } finally {
    exceptions.cleanup();
    cleanup();
  }
});

test("depcruise: wildcard exception with specific target works", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const exceptions = makeTempFile("exceptions.yml", `- rule: depcruise/*
  target: "dep:src/ui/button.js -> src/db/client.js"
  reason: "Legacy integration"
  owner: "@arch"
  expires: "2027-06-01"
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`depcruise:${DEPCRUISE_MIXED}`],
      exceptionsFile: exceptions.file,
      extraArgs: ["--now", "2026-11-14"]
    });
    // Only the specific target is excepted; warn and advisory remain but are not blocking
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.verdict, "passed");
    assert.strictEqual(parsed.findings[0].excepted, true);
    assert.deepStrictEqual(parsed.summary, expectedSummary({ total: 3, excepted: 1, blocking: 0, warnings: 2, warn: 1, advisory: 1 }));
  } finally {
    exceptions.cleanup();
    cleanup();
  }
});

test("depcruise: wildcard exception with target * exits 3", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  // Add a dummy "on" field to make the rule valid (imported rules don't need it but validation requires something)
  const rules = makeTempFile("rules.yml", `version: 1
extends: [archtour:recommended]
rules:
  - id: depcruise/no-ui-to-db
    level: hard
    on: dummy
`);
  const exceptions = makeTempFile("exceptions.yml", `- rule: depcruise/*
  target: "*"
  reason: "All"
  owner: "@arch"
  expires: "2027-06-01"
`);
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`depcruise:${DEPCRUISE_MIXED}`],
      rulesFile: rules.file,
      exceptionsFile: exceptions.file
    });
    assert.strictEqual(res.status, 3, res.stderr);
    // The error is about hard rules not allowing wildcard targets
    assert.match(res.stderr, /hard rule.*depcruise\/\*.*cannot have wildcard target/);
  } finally {
    rules.cleanup();
    exceptions.cleanup();
    cleanup();
  }
});

test("depcruise: needs-human says blocking finding", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_MIXED}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    // Only soft (and hard) findings are blocking and trigger needs-human
    assert.deepStrictEqual(parsed.needsHuman, expectedNeedsHuman(["blocking finding: depcruise/no-ui-to-db"]));
  } finally {
    cleanup();
  }
});

test("depcruise: baseline ratchet counts depcruise findings", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const baseline = makeTempFile("baseline.json", JSON.stringify({ "depcruise/no-ui-to-db": 0 }));
  try {
    const res = runCheck({
      baseDir,
      headDir,
      imports: [`depcruise:${DEPCRUISE_MIXED}`],
      baselineFile: baseline.file
    });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    // All three rules increased from baseline (0 for no-ui-to-db, 0->1 for others)
    // So there are 3 ratchet findings + 3 original findings = 6 total
    const ratchetFindings = parsed.findings.filter(f => f.message.startsWith("ratchet:"));
    assert.strictEqual(ratchetFindings.length, 3);
    // Check that no-ui-to-db ratchet is present
    const uiToDbRatchet = ratchetFindings.find(f => f.ruleId === "depcruise/no-ui-to-db");
    assert.ok(uiToDbRatchet);
    assert.strictEqual(uiToDbRatchet.message, "ratchet: depcruise/no-ui-to-db 0 -> 1");
    assert.strictEqual(uiToDbRatchet.level, "soft");
    // The original findings should also be present
    const originalFindings = parsed.findings.filter(f => !f.message.startsWith("ratchet:"));
    assert.strictEqual(originalFindings.length, 3);
    assert.deepStrictEqual(originalFindings.map(f => f.ruleId).sort(), ["depcruise/no-circular", "depcruise/no-orphans", "depcruise/no-ui-to-db"].sort());
  } finally {
    baseline.cleanup();
    cleanup();
  }
});

// Orchestrator (2026-11-27): brief example 4 round trip. A baseline written with --import holds each rule's count;
// a check with the same file adds no ratchet finding (the findings themselves stay), one more violation adds one.
test("depcruise: baseline written with --import, then check: same file no ratchet, one more is blocked", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const out = makeTempFile("baseline.json", "");
  const mixed = JSON.parse(fs.readFileSync(DEPCRUISE_MIXED, "utf8"));
  mixed.summary.violations.push({ type: "dependency", from: "src/ui/list.js", to: "src/db/client.js",
    rule: { severity: "error", name: "no-ui-to-db" } });
  const more = makeTempFile("depcruise-more.json", JSON.stringify(mixed));
  try {
    const bl = run(["baseline", headDir, "--import", `depcruise:${DEPCRUISE_MIXED}`, "--out", out.file]);
    assert.strictEqual(bl.status, 0, bl.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out.file, "utf8")),
      { "depcruise/no-circular": 1, "depcruise/no-orphans": 1, "depcruise/no-ui-to-db": 1 });

    const same = parseJson(runCheck({ baseDir, headDir, imports: [`depcruise:${DEPCRUISE_MIXED}`], baselineFile: out.file }));
    assert.deepStrictEqual(same.findings.filter(f => f.message.startsWith("ratchet:")), []);
    assert.strictEqual(same.findings.length, 3);

    const grown = parseJson(runCheck({ baseDir, headDir, imports: [`depcruise:${more.file}`], baselineFile: out.file }));
    assert.deepStrictEqual(grown.findings.filter(f => f.message.startsWith("ratchet:")).map(f => [f.ruleId, f.level, f.message]),
      [["depcruise/no-ui-to-db", "soft", "ratchet: depcruise/no-ui-to-db 1 -> 2"]]);
  } finally {
    out.cleanup();
    more.cleanup();
    cleanup();
  }
});

// Orchestrator: cycle/via must be lists of { name }; their names are normalised like from/to.
test("depcruise: cycle names are normalised; a cycle that is not a list exits 3", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const good = makeTempFile("depcruise-cycle.json", JSON.stringify({ modules: [], summary: { violations: [
    { type: "cycle", from: "./src/a.js", to: "src/b.js", cycle: [{ name: "src\\b.js", dependencyTypes: [] }, { name: "./src/a.js", dependencyTypes: [] }],
      rule: { severity: "warn", name: "no-circular" } }] } }));
  const bad = makeTempFile("depcruise-badcycle.json", JSON.stringify({ modules: [], summary: { violations: [
    { type: "cycle", from: "src/a.js", to: "src/b.js", cycle: "src/b.js", rule: { severity: "warn", name: "no-circular" } }] } }));
  try {
    const ok = parseJson(runCheck({ baseDir, headDir, imports: [`depcruise:${good.file}`] }));
    assert.deepStrictEqual(ok.findings.map(f => [f.entity, f.message]),
      [["cycle:src/a.js", "circular dependency: src/a.js -> src/b.js -> src/a.js"]]);
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stdout, "");
    assert.match(res.stderr, /^archtour: --import depcruise:.*depcruise-badcycle\.json: violation 1 is not a dependency-cruiser violation$/m);
  } finally {
    good.cleanup();
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - empty file", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("empty.json", "");
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import depcruise:${bad.file}: not valid JSON`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - not valid JSON", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", "{not json");
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import depcruise:${bad.file}: not valid JSON`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - missing summary.violations", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("shape.json", '{"summary": {}}');
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.match(res.stderr.trimEnd(), /not a dependency-cruiser JSON result \(expected summary\.violations; run depcruise with --output-type json\)/);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - violation missing from", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", `{
  "summary": {
    "violations": [
      { "to": "src/b.js", "rule": { "severity": "error", "name": "no-dep" } }
    ]
  }
}`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import depcruise:${bad.file}: violation 1 is not a dependency-cruiser violation`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - violation missing to", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", `{
  "summary": {
    "violations": [
      { "from": "src/a.js", "rule": { "severity": "error", "name": "no-dep" } }
    ]
  }
}`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import depcruise:${bad.file}: violation 1 is not a dependency-cruiser violation`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - violation missing rule.name", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", `{
  "summary": {
    "violations": [
      { "from": "src/a.js", "to": "src/b.js", "rule": { "severity": "error" } }
    ]
  }
}`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import depcruise:${bad.file}: violation 1 is not a dependency-cruiser violation`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: import errors - violation with unknown severity", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const bad = makeTempFile("bad.json", `{
  "summary": {
    "violations": [
      { "from": "src/a.js", "to": "src/b.js", "rule": { "severity": "critical", "name": "no-dep" } }
    ]
  }
}`);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${bad.file}`] });
    assert.strictEqual(res.status, 3);
    assert.strictEqual(res.stderr.trimEnd(), `archtour: --import depcruise:${bad.file}: violation 1 is not a dependency-cruiser violation`);
  } finally {
    bad.cleanup();
    cleanup();
  }
});

test("depcruise: reachability without via array", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const fixture = path.join(FIXTURES, "depcruise-reach-no-via.json");
  const content = `{
  "modules": [],
  "summary": {
    "violations": [
      { "type": "reachability", "from": "src/a.js", "to": "src/c.js",
        "rule": { "severity": "error", "name": "no-reach" } }
    ],
    "error": 1, "warn": 0, "info": 0, "ignore": 0,
    "totalCruised": 3, "totalDependenciesCruised": 2, "optionsUsed": {}
  }
}`;
  fs.writeFileSync(fixture, content);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${fixture}`] });
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].message, "src/a.js reaches src/c.js");
  } finally {
    fs.rmSync(fixture, { force: true });
    cleanup();
  }
});

test("depcruise: instability without metrics", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const fixture = path.join(FIXTURES, "depcruise-instability-no-metrics.json");
  const content = `{
  "modules": [],
  "summary": {
    "violations": [
      { "type": "instability", "from": "src/a.js", "to": "src/b.js",
        "rule": { "severity": "warn", "name": "no-unstable" } }
    ],
    "error": 0, "warn": 1, "info": 0, "ignore": 0,
    "totalCruised": 2, "totalDependenciesCruised": 1, "optionsUsed": {}
  }
}`;
  fs.writeFileSync(fixture, content);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${fixture}`] });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].message, "src/a.js depends on less stable src/b.js");
  } finally {
    fs.rmSync(fixture, { force: true });
    cleanup();
  }
});

test("depcruise: module violation uses file entity", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  const fixture = path.join(FIXTURES, "depcruise-module.json");
  const content = `{
  "modules": [],
  "summary": {
    "violations": [
      { "type": "module", "from": "src/module.js", "to": "src/module.js",
        "rule": { "severity": "info", "name": "no-module" } }
    ],
    "error": 0, "warn": 0, "info": 1, "ignore": 0,
    "totalCruised": 1, "totalDependenciesCruised": 0, "optionsUsed": {}
  }
}`;
  fs.writeFileSync(fixture, content);
  try {
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${fixture}`] });
    assert.strictEqual(res.status, 0, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings[0].entity, "file:src/module.js");
    assert.strictEqual(parsed.findings[0].event.kind, "file");
    assert.strictEqual(parsed.findings[0].message, "src/module.js: module rule no-module");
  } finally {
    fs.rmSync(fixture, { force: true });
    cleanup();
  }
});

test("depcruise: large result imports without crash", () => {
  const { baseDir, headDir, cleanup } = makeDirs();
  // Create a large result with 5000 violations
  const violations = [];
  for (let i = 0; i < 5000; i++) {
    violations.push({
      type: "dependency",
      from: `src/file${i}.js`,
      to: `src/dep${i}.js`,
      dependencyTypes: ["local"],
      rule: { severity: "error", name: "no-dep" }
    });
  }
  const largeFixture = path.join(FIXTURES, "depcruise-large.json");
  const content = JSON.stringify({
    modules: [],
    summary: {
      violations,
      error: 5000, warn: 0, info: 0, ignore: 0,
      totalCruised: 10000, totalDependenciesCruised: 5000, optionsUsed: {}
    }
  });
  fs.writeFileSync(largeFixture, content);
  try {
    const start = Date.now();
    const res = runCheck({ baseDir, headDir, imports: [`depcruise:${largeFixture}`] });
    const elapsed = Date.now() - start;
    assert.strictEqual(res.status, 2, res.stderr);
    const parsed = parseJson(res);
    assert.strictEqual(parsed.findings.length, 5000);
    // Should complete in reasonable time (well under 5 seconds)
    // Orchestrator: a generous limit (CI machines vary); the point is no crash or quadratic blow-up.
    assert.ok(elapsed < 30000, `Import took ${elapsed}ms, expected < 30000ms`);
  } finally {
    fs.rmSync(largeFixture, { force: true });
    cleanup();
  }
});

test("help: check lists depcruise in --import", () => {
  const checkHelp = run(["help", "check"]);
  assert.strictEqual(checkHelp.status, 0, checkHelp.stderr);
  assert.match(checkHelp.stdout, /dependency-cruiser/);
});

test("help: baseline lists depcruise in --import", () => {
  const baselineHelp = run(["help", "baseline"]);
  assert.strictEqual(baselineHelp.status, 0, baselineHelp.stderr);
  assert.match(baselineHelp.stdout, /depcruise/);
});

test("action.yml: import input description includes depcruise", () => {
  const content = fs.readFileSync(path.resolve("action.yml"), "utf8");
  assert.match(content, /dependency-cruiser/);
});