import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/cli.mjs");

// Helper to initialize a git repo with commits
function gitInitRepo(dir) {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, encoding: "utf8" });
}

function gitCommitAll(dir, message) {
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", message], { cwd: dir, encoding: "utf8" });
}

// Helper to run archtour check
function runCheck(args, opts = {}) {
  const defaultOpts = { encoding: "utf8", timeout: 30000 };
  return spawnSync(process.execPath, [CLI, "check", ...args], { ...defaultOpts, ...opts });
}

// --- Fixture for Examples 1 & 2: SQL migration drops column (sql-no-drop-column), route removed, image changed ---
function createFixtureExample1() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-ex1-"));
  gitInitRepo(tmp);

  // Base commit
  fs.mkdirSync(path.join(tmp, "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "migrations", "V1__create_users.sql"),
    "CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255));\n"
  );
  fs.writeFileSync(
    path.join(tmp, "openapi.yaml"),
    "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /items:\n    get:\n      operationId: getItems\n"
  );
  fs.writeFileSync(
    path.join(tmp, "docker-compose.yml"),
    "services:\n  app:\n    image: nginx\n"
  );
  gitCommitAll(tmp, "base");

  // Head commit: drop column (sql-no-drop-column), remove route (no-api-route-removed), change image (service-image-changed)
  fs.writeFileSync(
    path.join(tmp, "migrations", "V2__drop_email.sql"),
    "ALTER TABLE users DROP COLUMN email;\n"
  );
  fs.writeFileSync(
    path.join(tmp, "openapi.yaml"),
    "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths: {}\n"
  );
  fs.writeFileSync(
    path.join(tmp, "docker-compose.yml"),
    "services:\n  app:\n    image: nginx:1.21\n"
  );
  gitCommitAll(tmp, "head");

  return tmp;
}

// --- Fixture for Example 3: 5 findings (3 routes + 2 fields removed) ---
function createFixtureExample3() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-ex3-"));
  gitInitRepo(tmp);

  fs.writeFileSync(
    path.join(tmp, "openapi.yaml"),
    "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /a:\n    get:\n      operationId: getA\n  /b:\n    get:\n      operationId: getB\n  /c:\n    get:\n      operationId: getC\n"
  );
  fs.writeFileSync(
    path.join(tmp, "schema.prisma"),
    "model User {\n  id Int @id\n  f1 String\n  f2 String\n}\n"
  );
  gitCommitAll(tmp, "base");

  fs.writeFileSync(
    path.join(tmp, "openapi.yaml"),
    "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths: {}\n"
  );
  fs.writeFileSync(
    path.join(tmp, "schema.prisma"),
    "model User {\n  id Int @id\n}\n"
  );
  gitCommitAll(tmp, "head");

  return tmp;
}

// --- Fixture for Example 4: 2 soft findings (route removals) ---
function createFixtureExample4() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-ex4-"));
  gitInitRepo(tmp);

  fs.writeFileSync(
    path.join(tmp, "openapi.yaml"),
    "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /a:\n    get:\n      operationId: getA\n  /b:\n    get:\n      operationId: getB\n"
  );
  gitCommitAll(tmp, "base");

  fs.writeFileSync(
    path.join(tmp, "openapi.yaml"),
    "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths: {}\n"
  );
  gitCommitAll(tmp, "head");

  return tmp;
}

// --- Fixture for Example 5/6: simple docker-compose change ---
function createFixtureSimple() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-simple-"));
  gitInitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.21\n");
  gitCommitAll(tmp, "head");
  return tmp;
}

// --- Fixture for Example 6 default output (with privileged + host network) ---
function createFixtureDefault() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-default-"));
  gitInitRepo(tmp);
  fs.writeFileSync(
    path.join(tmp, "docker-compose.yml"),
    "services:\n  app:\n    image: nginx\n    privileged: true\n    network_mode: host\n"
  );
  gitCommitAll(tmp, "base");
  fs.writeFileSync(
    path.join(tmp, "docker-compose.yml"),
    "services:\n  app:\n    image: nginx:1.21\n    privileged: true\n    network_mode: host\n"
  );
  gitCommitAll(tmp, "head");
  return tmp;
}

// --- Fixture for comma-separated --only ---
function createFixtureComma() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-comma-"));
  gitInitRepo(tmp);
  fs.writeFileSync(
    path.join(tmp, "docker-compose.yml"),
    "services:\n  app:\n    image: nginx\n"
  );
  gitCommitAll(tmp, "base");
  fs.writeFileSync(
    path.join(tmp, "docker-compose.yml"),
    "services:\n  app:\n    image: nginx\n    privileged: true\n    network_mode: host\n"
  );
  gitCommitAll(tmp, "head");
  return tmp;
}

// --- Fixture for clean (no findings except advisory) ---
function createFixtureClean() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-clean-"));
  gitInitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, "README.md"), "# demo\n");
  gitCommitAll(tmp, "head");
  return tmp;
}

// --- Fixture for entity format test (Prisma field removal) ---
function createFixtureEntity() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-entity-"));
  gitInitRepo(tmp);
  fs.writeFileSync(
    path.join(tmp, "schema.prisma"),
    "model User {\n  id Int @id\n  email String\n}\n"
  );
  gitCommitAll(tmp, "base");
  fs.writeFileSync(
    path.join(tmp, "schema.prisma"),
    "model User {\n  id Int @id\n}\n"
  );
  gitCommitAll(tmp, "head");
  return tmp;
}

// --- Fixture for file:line format test (policy-changed) ---
function createFixtureFileLine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t127-fileline-"));
  gitInitRepo(tmp);
  fs.mkdirSync(path.join(tmp, ".archtour"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
  gitCommitAll(tmp, "base");
  fs.writeFileSync(path.join(tmp, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\nrules:\n  - id: custom-rule\n    on: service.privileged_enabled\n    level: hard\n");
  fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");
  gitCommitAll(tmp, "head");
  return tmp;
}

// ============================================================================
// TESTS
// ============================================================================

test("T-127: brief mode lists all findings with correct format and verdict line", () => {
  const tmp = createFixtureExample1();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 3 finding lines + 1 verdict line = 4 lines
    assert.equal(lines.length, 4, `Expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    // Exact finding lines (order: sql-no-drop-column, no-api-route-removed, service-image-changed)
    // Note: sql-no-drop-column is soft in built-in rules, not hard as brief example 1 states
    const findingLines = lines.slice(0, 3);
    assert.deepStrictEqual(findingLines, [
      "soft sql-no-drop-column db.column:users.email migrations/V2__drop_email.sql:1",
      "soft no-api-route-removed api.route:GET /items openapi.yaml:6",
      "advisory service-image-changed service:app docker-compose.yml:2"
    ], `Finding lines mismatch: ${JSON.stringify(findingLines)}`);

    // Verdict line (counts ALL findings: 0 hard, 2 soft, 0 warn, 1 advisory -> exit 2)
    const verdictLine = lines[3];
    assert.strictEqual(
      verdictLine,
      "verdict: warning (exit 2): 0 hard, 2 soft, 0 warn, 1 advisory",
      `Verdict line mismatch: ${verdictLine}`
    );

    // Exit code matches verdict
    assert.strictEqual(r.status, 2, `Expected exit 2, got ${r.status}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: brief mode with --only hard filters findings but verdict counts all", () => {
  const tmp = createFixtureExample1();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--only", "hard"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // No hard findings in this fixture, so 0 finding lines + 1 verdict line = 1 line
    assert.equal(lines.length, 1, `Expected 1 line (only verdict), got ${lines.length}: ${JSON.stringify(lines)}`);

    // Verdict line MUST be same as without --only (counts ALL findings)
    const verdictLine = lines[0];
    assert.strictEqual(
      verdictLine,
      "verdict: warning (exit 2): 0 hard, 2 soft, 0 warn, 1 advisory",
      `Verdict line mismatch: ${verdictLine}`
    );

    // Exit code still 2
    assert.strictEqual(r.status, 2, `Expected exit 2, got ${r.status}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: brief mode with --limit and --offset shows paging line then verdict", () => {
  const tmp = createFixtureExample3();
  try {
    // 5 findings: 3 route removals (no-api-route-removed) + 2 field removals (no-db-field-removed)
    // --limit 2 --offset 2 should show findings 3 and 4 (0-indexed: 2, 3)
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--limit", "2", "--offset", "2"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 2 finding lines + 1 showing line + 1 verdict line = 4 lines
    assert.equal(lines.length, 4, `Expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    // Finding lines 3 and 4 (0-indexed 2, 3): 3rd route removal + 1st field removal
    assert.match(lines[0], /^soft no-api-route-removed api\.route:GET \/c openapi\.yaml:\d+$/, `Line 1 format invalid: ${lines[0]}`);
    assert.match(lines[1], /^soft no-db-field-removed db\.field:User\.f1 schema\.prisma:\d+$/, `Line 2 format invalid: ${lines[1]}`);

    // Showing line
    const showingLine = lines[2];
    assert.strictEqual(
      showingLine,
      "showing 3-4 of 5; next: --offset 4",
      `Showing line mismatch: ${showingLine}`
    );

    // Verdict line (5 findings: 5 soft, 0 hard, 0 warn, 0 advisory -> exit 2)
    const verdictLine = lines[3];
    assert.strictEqual(
      verdictLine,
      "verdict: warning (exit 2): 0 hard, 5 soft, 0 warn, 0 advisory",
      `Verdict line mismatch: ${verdictLine}`
    );

    assert.strictEqual(r.status, 2, `Expected exit 2, got ${r.status}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: json mode with --only and --limit includes shown field", () => {
  const tmp = createFixtureExample4();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--json", "--only", "soft", "--limit", "1"]);
    const json = JSON.parse(r.stdout);

    // findings array holds at most 1 soft finding
    assert.ok(json.findings.length <= 1, `Expected at most 1 finding, got ${json.findings.length}`);
    if (json.findings.length === 1) {
      assert.equal(json.findings[0].level, "soft", `Expected soft finding, got ${json.findings[0].level}`);
    }

    // summary is unchanged (counts ALL findings: 2 soft)
    assert.ok(json.summary, "summary field missing");
    assert.equal(json.summary.soft, 2, `Expected summary.soft=2, got ${json.summary.soft}`);
    assert.equal(json.summary.hard, 0);
    assert.equal(json.summary.warn, 0);
    assert.equal(json.summary.advisory, 0);

    // shown field exists with correct structure
    assert.ok(json.shown, "shown field missing");
    assert.deepStrictEqual(json.shown, { offset: 0, limit: 1, matched: 2 });

    // Exit code matches verdict (2 soft -> exit 2)
    assert.strictEqual(r.status, 2, `Expected exit 2, got ${r.status}`);
    assert.equal(json.exitCode, 2);
    assert.equal(json.verdict, "warning");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: invalid --only value exits 3 with specific error", () => {
  const tmp = createFixtureSimple();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--only", "hardd"]);
    assert.strictEqual(r.status, 3, `Expected exit 3, got ${r.status}`);
    const stderr = r.stderr.trim();
    assert.match(stderr, /--only takes hard, soft, warn, advisory \(comma-separated\)/, `Error message missing valid values: ${stderr}`);
    assert.ok(!stderr.includes("stack"), `Stack trace in error: ${stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: invalid --limit value exits 3 with specific error", () => {
  const tmp = createFixtureSimple();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--limit", "-1"]);
    assert.strictEqual(r.status, 3, `Expected exit 3, got ${r.status}`);
    const stderr = r.stderr.trim();
    assert.match(stderr, /--limit takes a whole number >= 1/, `Error message missing valid values: ${stderr}`);
    assert.ok(!stderr.includes("stack"), `Stack trace in error: ${stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --brief --json combined exits 3 with specific error", () => {
  const tmp = createFixtureSimple();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--json"]);
    assert.strictEqual(r.status, 3, `Expected exit 3, got ${r.status}`);
    const stderr = r.stderr.trim();
    assert.match(stderr, /--brief cannot be combined with --json/, `Error message missing: ${stderr}`);
    assert.ok(!stderr.includes("stack"), `Stack trace in error: ${stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: default output unchanged when no new flags (byte-for-byte)", () => {
  const tmp = createFixtureDefault();
  try {
    // Stored from 0.3.1 + T-125 before the build (orchestrator, 2026-11-23); the new flags must not change it.
    // T-128 (2026-11-24) adds the "Needs a human" line under the title on purpose.
    const EXPECTED =
      "## ✅ Architecture Guardrails: Passed (0 blocking, 0 overridden, 0 excepted, 0 warnings, 1 advisory)\n" +
      "Needs a human: no\n\n" +
      "### ℹ️ Advisory (1)\n" +
      "- **Container image changed. - Service 'app' image changed from 'nginx' to 'nginx:1.21'** (`service-image-changed`)\n" +
      "  - Entity: `service:app`\n" +
      "  - File: `docker-compose.yml:2`\n" +
      "  - Owners: none\n" +
      "  - Docs: [docs](https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended)\n";
    const r = runCheck(["--changed-from", "HEAD~1", tmp]);
    assert.strictEqual(r.status, 0, `Expected exit 0, got ${r.status}`);
    assert.strictEqual(r.stdout, EXPECTED);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --only with comma-separated values works", () => {
  const tmp = createFixtureComma();
  try {
    // Should show both hard (no-privileged-containers) and soft (no-host-network)
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--only", "hard,soft"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 2 finding lines (1 hard, 1 soft) + 1 verdict line = 3 lines
    assert.equal(lines.length, 3, `Expected 3 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    const findingLines = lines.slice(0, 2);
    const hasHard = findingLines.some(l => l.startsWith("hard "));
    const hasSoft = findingLines.some(l => l.startsWith("soft "));
    assert.ok(hasHard, `Expected hard finding, got: ${JSON.stringify(findingLines)}`);
    assert.ok(hasSoft, `Expected soft finding, got: ${JSON.stringify(findingLines)}`);

    // Verdict: 1 hard, 1 soft -> exit 1
    const verdictLine = lines[2];
    assert.strictEqual(
      verdictLine,
      "verdict: failed (exit 1): 1 hard, 1 soft, 0 warn, 0 advisory",
      `Verdict line mismatch: ${verdictLine}`
    );
    assert.strictEqual(r.status, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --limit 0 exits 3", () => {
  const tmp = createFixtureSimple();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--limit", "0"]);
    assert.strictEqual(r.status, 3, `Expected exit 3, got ${r.status}`);
    const stderr = r.stderr.trim();
    assert.match(stderr, /--limit takes a whole number >= 1/, `Error message: ${stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --offset without --limit works (shows from offset to end)", () => {
  const tmp = createFixtureExample3();
  try {
    // 5 findings, offset 1 should show 4 findings (2nd through 5th)
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--offset", "1"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 4 finding lines + 1 showing line + 1 verdict line = 6 lines
    assert.equal(lines.length, 6, `Expected 6 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    // Showing line should indicate 2-5 of 5
    assert.match(lines[4], /^showing 2-5 of 5$/, `Showing line: ${lines[4]}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --only filters markdown output too (title counts stay all findings)", () => {
  const tmp = createFixtureComma();
  try {
    // Default markdown (no --only)
    const r1 = runCheck(["--changed-from", "HEAD~1", tmp]);
    const md1 = r1.stdout;

    // With --only hard (should filter findings in markdown but title counts stay same)
    const r2 = runCheck(["--changed-from", "HEAD~1", tmp, "--only", "hard"]);
    const md2 = r2.stdout;

    // Title line should have same counts (all findings: 1 hard, 1 soft)
    const title1 = md1.split("\n")[0];
    const title2 = md2.split("\n")[0];
    assert.strictEqual(title1, title2, "Title counts should be same (all findings)");

    // But findings listed should differ
    assert.ok(md1.includes("⚠️ Soft"), "Default should have soft section");
    assert.ok(!md2.includes("⚠️ Soft"), "With --only hard should not have soft section");
    assert.ok(md2.includes("⛔ Hard"), "With --only hard should still have hard section");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: brief mode with no findings shows verdict line only", () => {
  const tmp = createFixtureClean();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // Should have only verdict line (1 line)
    assert.equal(lines.length, 1, `Expected 1 line, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^verdict: passed \(exit 0\): 0 hard, 0 soft, 0 warn, 0 advisory$/, `Verdict line: ${lines[0]}`);
    assert.strictEqual(r.status, 0, `Expected exit 0, got ${r.status}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: brief mode entity format matches --json entityId", () => {
  const tmp = createFixtureEntity();
  try {
    // Get JSON output to see entityId format
    const rJson = runCheck(["--changed-from", "HEAD~1", tmp, "--json"]);
    const json = JSON.parse(rJson.stdout);
    const jsonEntity = json.findings[0]?.event?.entityId;

    // Get brief output
    const rBrief = runCheck(["--changed-from", "HEAD~1", tmp, "--brief"]);
    const briefLine = rBrief.stdout.trim().split("\n")[0];
    const briefEntity = briefLine.split(" ")[2]; // level ruleId entity file:line

    assert.strictEqual(briefEntity, jsonEntity, `Entity mismatch: brief="${briefEntity}" json="${jsonEntity}"`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: brief mode file:line format uses unknown when no file, no :line when no line", () => {
  const tmp = createFixtureFileLine();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // Find the policy-changed line
    const policyLine = lines.find(l => l.includes("policy-changed"));
    if (policyLine) {
      // Should have file:line format
      const parts = policyLine.split(" ");
      const fileLine = parts[3];
      assert.match(fileLine, /^\S+:\d+$/, `File:line format invalid: ${fileLine}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --only soft in brief mode shows only soft findings", () => {
  const tmp = createFixtureExample1();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--only", "soft"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 2 soft findings + 1 verdict = 3 lines
    assert.equal(lines.length, 3, `Expected 3 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    const findingLines = lines.slice(0, 2);
    for (const line of findingLines) {
      assert.ok(line.startsWith("soft "), `Expected soft finding, got: ${line}`);
    }

    // Verdict unchanged
    const verdictLine = lines[2];
    assert.strictEqual(
      verdictLine,
      "verdict: warning (exit 2): 0 hard, 2 soft, 0 warn, 1 advisory",
      `Verdict line mismatch: ${verdictLine}`
    );
    assert.strictEqual(r.status, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --limit with no --offset starts from beginning", () => {
  const tmp = createFixtureExample3();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--limit", "2"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 2 finding lines + 1 showing line + 1 verdict line = 4 lines
    assert.equal(lines.length, 4, `Expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    // Showing line
    assert.strictEqual(lines[2], "showing 1-2 of 5; next: --offset 2", `Showing line: ${lines[2]}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --offset beyond findings shows only showing line and verdict", () => {
  const tmp = createFixtureExample3();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--offset", "10"]);
    const lines = r.stdout.trim().split("\n").filter(l => l.trim());

    // 0 finding lines + 1 showing line + 1 verdict line = 2 lines
    assert.equal(lines.length, 2, `Expected 2 lines, got ${lines.length}: ${JSON.stringify(lines)}`);

    // Showing line
    assert.strictEqual(lines[0], "showing 0 of 5", `Showing line: ${lines[0]}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --only advisory in json mode filters findings array but summary unchanged", () => {
  const tmp = createFixtureExample1();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--json", "--only", "advisory"]);
    const json = JSON.parse(r.stdout);

    // findings array holds only advisory findings
    assert.equal(json.findings.length, 1, `Expected 1 advisory finding, got ${json.findings.length}`);
    assert.equal(json.findings[0].level, "advisory");

    // summary unchanged (all findings)
    assert.equal(json.summary.advisory, 1);
    assert.equal(json.summary.soft, 2);
    assert.equal(json.summary.hard, 0);

    // shown field
    assert.deepStrictEqual(json.shown, { offset: 0, limit: null, matched: 1 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("T-127: --only with invalid level in comma list exits 3", () => {
  const tmp = createFixtureSimple();
  try {
    const r = runCheck(["--changed-from", "HEAD~1", tmp, "--brief", "--only", "hard,invalid"]);
    assert.strictEqual(r.status, 3, `Expected exit 3, got ${r.status}`);
    const stderr = r.stderr.trim();
    assert.match(stderr, /--only takes hard, soft, warn, advisory \(comma-separated\)/, `Error message: ${stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});