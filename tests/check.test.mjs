import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { extractFacts } from "../tools/facts.mjs";
import { diffFacts } from "../tools/facts-diff.mjs";
import {
  validateRule,
  validateRulesConfig,
  loadRules,
  loadRulesFile,
  evaluateRules,
  formatMarkdownReport,
  formatJobLogLines,
  getExitCode,
  matchGlob,
  extractStateEvents,
  loadExceptionsFile,
  applyExceptions,
  applyOverrides,
  diffPolicy
} from "../tools/rules.mjs"
import { RECOMMENDED_RULES } from "../tools/rules-recommended.mjs";
import { batchCatFile, parseCatFileBatchOutput } from "../tools/changed.mjs";
import { isHelmTemplate } from "../tools/scan.mjs";

const CLI = path.resolve("tools/cli.mjs");

// 1. Schema validation errors
test("schema validation errors with clear rule id and field name", () => {
  // Invalid config version
  assert.throws(
    () => validateRulesConfig({ version: 2 }),
    (err) => err.message.includes('"version" must be 1')
  );

  // Missing config version
  assert.throws(
    () => validateRulesConfig({ rules: [] }),
    (err) => err.message.includes('"version" must be 1')
  );

  // Network URL in extends
  assert.throws(
    () => validateRulesConfig({ version: 1, extends: ["https://example.com/rules.yml"] }),
    (err) => err.message.includes("network URL") && err.message.includes("Network imports are not allowed")
  );

  assert.throws(
    () => validateRulesConfig({ version: 1, extends: ["git://github.com/org/repo.git"] }),
    (err) => err.message.includes("network URL")
  );

  // Duplicate rule id in same file
  assert.throws(
    () => validateRulesConfig({
      version: 1,
      rules: [
        { id: "rule-a", on: "service.privileged_enabled", level: "hard" },
        { id: "rule-a", on: "service.host_network_enabled", level: "soft" }
      ]
    }),
    (err) => err.message.includes('Duplicate rule id "rule-a"')
  );

  // Missing rule id
  assert.throws(
    () => validateRule({ level: "hard", on: "service.privileged_enabled" }),
    (err) => err.message.includes('Rule is missing required field "id"')
  );

  // Invalid rule level
  assert.throws(
    () => validateRule({ id: "bad-level-rule", level: "super-hard", on: "service.privileged_enabled" }),
    (err) => err.message.includes('Rule "bad-level-rule"') && err.message.includes('invalid field "level"')
  );

  // Missing 'on' for new rule
  assert.throws(
    () => validateRule({ id: "missing-on-rule", level: "hard" }, true),
    (err) => err.message.includes('Rule "missing-on-rule"') && err.message.includes('missing required field "on"')
  );

  // Invalid 'where'
  assert.throws(
    () => validateRule({ id: "bad-where", level: "hard", on: "service.privileged_enabled", where: "not-an-object" }),
    (err) => err.message.includes('Rule "bad-where"') && err.message.includes('invalid field "where"')
  );

  // Invalid 'owners'
  assert.throws(
    () => validateRule({ id: "bad-owners", level: "hard", on: "service.privileged_enabled", owners: 123 }),
    (err) => err.message.includes('Rule "bad-owners"') && err.message.includes('invalid field "owners"')
  );

  // Invalid 'adjustable'
  assert.throws(
    () => validateRule({ id: "bad-adjustable", level: "hard", on: "service.privileged_enabled", adjustable: "yes" }),
    (err) => err.message.includes('Rule "bad-adjustable"') && err.message.includes('invalid field "adjustable"')
  );

  // Unknown built-in pack in extends
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-ext-err-"));
  try {
    const file = path.join(tmp, "rules.yml");
    fs.writeFileSync(file, "version: 1\nextends: [archtour:unknown_pack]\n");
    assert.throws(
      () => loadRulesFile(file),
      (err) => err.message.includes('Unknown built-in pack "archtour:unknown_pack"')
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Non-existent relative extended file
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "rules-ext-missing-"));
  try {
    const file2 = path.join(tmp2, "rules.yml");
    fs.writeFileSync(file2, "version: 1\nextends: [./missing-file.yml]\n");
    assert.throws(
      () => loadRulesFile(file2),
      (err) => err.message.includes("Extended rules file") && err.message.includes("not found")
    );
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

// 2. extends + merge + loosening rules
test("extends + merge order and loosening rules (allowed when adjustable, ignored with warning when not, stricter always allowed)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rules-merge-test-"));
  try {
    // Base policy: one non-adjustable hard rule, one adjustable soft rule, one non-adjustable warn rule
    const basePolicy = `
version: 1
rules:
  - id: non-adj-hard
    on: service.privileged_enabled
    level: hard
    adjustable: false
    message: "Base hard message"
  - id: adj-soft
    on: service.host_network_enabled
    level: soft
    adjustable: true
  - id: non-adj-warn
    on: db.field_type_changed
    level: warn
    adjustable: false
`;
    const basePath = path.join(tmp, "base.yml");
    fs.writeFileSync(basePath, basePolicy);

    // Child policy extending base policy:
    // 1. Attempts to loosen non-adj-hard from hard -> warn (should be ignored with warning)
    // 2. Loosens adj-soft from soft -> advisory (should be allowed because adjustable: true)
    // 3. Tightens non-adj-warn from warn -> hard (should be allowed because stricter is always allowed)
    // 4. Overrides message and owners on adj-soft
    const childPolicy = `
version: 1
extends: [./base.yml]
rules:
  - id: non-adj-hard
    level: warn
  - id: adj-soft
    level: advisory
    message: "Overridden child message"
    owners: ["@child/team"]
  - id: non-adj-warn
    level: hard
`;
    const childPath = path.join(tmp, "child.yml");
    fs.writeFileSync(childPath, childPolicy);

    const result = loadRulesFile(childPath);

    // Check non-adj-hard: loosening ignored, remains hard
    const rule1 = result.rules.find(r => r.id === "non-adj-hard");
    assert.ok(rule1);
    assert.equal(rule1.level, "hard");
    assert.ok(result.warnings.some(w => w.ruleId === "non-adj-hard" && w.message.includes("cannot be loosened")));

    // Check adj-soft: loosening allowed, becomes advisory
    const rule2 = result.rules.find(r => r.id === "adj-soft");
    assert.ok(rule2);
    assert.equal(rule2.level, "advisory");
    assert.equal(rule2.message, "Overridden child message");
    assert.deepEqual(rule2.owners, ["@child/team"]);

    // Check non-adj-warn: tightening allowed, becomes hard
    const rule3 = result.rules.find(r => r.id === "non-adj-warn");
    assert.ok(rule3);
    assert.equal(rule3.level, "hard");

    // Extends built-in archtour:recommended
    const recommendedPolicy = `
version: 1
extends: [archtour:recommended]
rules:
  - id: service-image-changed
    level: hard
`;
    const recPath = path.join(tmp, "rec.yml");
    fs.writeFileSync(recPath, recommendedPolicy);
    const recResult = loadRulesFile(recPath);
    assert.equal(recResult.rules.length, RECOMMENDED_RULES.length);
    const tightenedImageRule = recResult.rules.find(r => r.id === "service-image-changed");
    assert.equal(tightenedImageRule.level, "hard");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 3. Each built-in rule fires on a minimal base/head pair (15 rules!)
test("each of the 15 built-in rules in archtour:recommended fires on a minimal base/head pair", () => {
  const rules = RECOMMENDED_RULES;
  // The pack grows as formats are added (SQL, Kubernetes, ...): check the 15 core rules are all present and every id is unique.
  const CORE_IDS = ["no-privileged-containers", "no-docker-socket-mount", "no-host-network", "no-all-interfaces-port-binding",
    "no-external-registry", "service-image-changed", "no-db-model-removed", "no-db-field-removed", "db-field-type-changed",
    "db-field-made-required", "no-api-route-removed", "no-api-param-required-added", "no-api-request-required-added",
    "no-api-security-removed", "service-dependency-added"];
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
  for (const id of CORE_IDS) assert.ok(ids.includes(id), `core rule ${id} missing`);
  assert.ok(rules.length >= 15, `Expected at least the 15 core rules, got ${rules.length}`);

  // Helper to extract, diff, and evaluate recommended rules
  function checkPair(baseFiles, headFiles) {
    const baseFacts = extractFacts(baseFiles);
    const headFacts = extractFacts(headFiles);
    const diff = diffFacts(baseFacts, headFacts);
    const { findings } = evaluateRules(rules, diff, baseFacts, headFacts);
    return { findings, diff };
  }

  // 1. no-privileged-containers
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n    privileged: true\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-privileged-containers");
    assert.ok(f, "no-privileged-containers did not fire");
    assert.equal(f.level, "hard");
    assert.equal(f.event.type, "service.privileged_enabled");
  }

  // 2. no-docker-socket-mount
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-docker-socket-mount");
    assert.ok(f, "no-docker-socket-mount did not fire");
    assert.equal(f.level, "hard");
  }

  // 3. no-host-network
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n    network_mode: host\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-host-network");
    assert.ok(f, "no-host-network did not fire");
    assert.equal(f.level, "soft");
  }

  // 4. no-all-interfaces-port-binding
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx\n    ports:\n      - '8080:80'\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-all-interfaces-port-binding");
    assert.ok(f, "no-all-interfaces-port-binding did not fire");
    assert.equal(f.level, "soft");
  }

  // 5. no-external-registry
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: myapp:1.0\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: ghcr.io/myapp:1.0\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-external-registry");
    assert.ok(f, "no-external-registry did not fire");
    assert.equal(f.level, "warn");
  }

  // 6. service-image-changed
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx:1.20\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: nginx:1.21\n" }]
    );
    const f = findings.find(x => x.ruleId === "service-image-changed");
    assert.ok(f, "service-image-changed did not fire");
    assert.equal(f.level, "advisory");
  }

  // 7. no-db-model-removed
  {
    const { findings } = checkPair(
      [{ path: "schema.prisma", content: "model Account {\n  id Int @id\n}\n" }],
      [{ path: "schema.prisma", content: "model Profile {\n  id Int @id\n}\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-db-model-removed");
    assert.ok(f, "no-db-model-removed did not fire");
    assert.equal(f.level, "soft");
  }

  // 8. no-db-field-removed
  {
    const { findings } = checkPair(
      [{ path: "schema.prisma", content: "model User {\n  id Int @id\n  nickname String?\n}\n" }],
      [{ path: "schema.prisma", content: "model User {\n  id Int @id\n}\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-db-field-removed");
    assert.ok(f, "no-db-field-removed did not fire");
    assert.equal(f.level, "soft");
  }

  // 9. db-field-type-changed
  {
    const { findings } = checkPair(
      [{ path: "schema.prisma", content: "model User {\n  id Int @id\n  score Int\n}\n" }],
      [{ path: "schema.prisma", content: "model User {\n  id Int @id\n  score BigInt\n}\n" }]
    );
    const f = findings.find(x => x.ruleId === "db-field-type-changed");
    assert.ok(f, "db-field-type-changed did not fire");
    assert.equal(f.level, "warn");
  }

  // 10. db-field-made-required
  {
    const { findings } = checkPair(
      [{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio String?\n}\n" }],
      [{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio String\n}\n" }]
    );
    const f = findings.find(x => x.ruleId === "db-field-made-required");
    assert.ok(f, "db-field-made-required did not fire");
    assert.equal(f.level, "warn");
  }

  // 11. no-api-route-removed
  {
    const { findings } = checkPair(
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /items:\n    get:\n      operationId: getItems\n" }],
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths: {}\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-api-route-removed");
    assert.ok(f, "no-api-route-removed did not fire");
    assert.equal(f.level, "soft");
  }

  // 12. no-api-param-required-added
  {
    const { findings } = checkPair(
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /items:\n    get:\n      operationId: getItems\n" }],
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /items:\n    get:\n      operationId: getItems\n      parameters:\n        - name: q\n          in: query\n          required: true\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-api-param-required-added");
    assert.ok(f, "no-api-param-required-added did not fire");
    assert.equal(f.level, "warn");
  }

  // 13. no-api-request-required-added
  {
    const { findings } = checkPair(
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /items:\n    post:\n      operationId: createItem\n      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              required: [title]\n" }],
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /items:\n    post:\n      operationId: createItem\n      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              required: [title, sku]\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-api-request-required-added");
    assert.ok(f, "no-api-request-required-added did not fire");
    assert.equal(f.level, "warn");
  }

  // 14. no-api-security-removed
  {
    const { findings } = checkPair(
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /admin:\n    get:\n      operationId: admin\n      security:\n        - ApiKey: []\n" }],
      [{ path: "openapi.yaml", content: "openapi: '3.0.0'\ninfo:\n  title: API\n  version: '1.0'\npaths:\n  /admin:\n    get:\n      operationId: admin\n      security: []\n" }]
    );
    const f = findings.find(x => x.ruleId === "no-api-security-removed");
    assert.ok(f, "no-api-security-removed did not fire");
    assert.equal(f.level, "hard");
  }

  // 15. service-dependency-added
  {
    const { findings } = checkPair(
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: node:20\n  redis:\n    image: redis\n" }],
      [{ path: "docker-compose.yml", content: "services:\n  app:\n    image: node:20\n    depends_on:\n      - redis\n  redis:\n    image: redis\n" }]
    );
    const f = findings.find(x => x.ruleId === "service-dependency-added");
    assert.ok(f, "service-dependency-added did not fire");
    assert.equal(f.level, "advisory");
  }
});

// 4. `where` globs
test("`where` glob matchers properly filter rule evaluation", () => {
  const customRules = [
    {
      id: "no-privileged-non-dev",
      on: "service.privileged_enabled",
      where: { name: "!*-dev" },
      level: "hard"
    },
    {
      id: "no-prod-ports",
      on: "service.port_published",
      where: { name: "prod-*" },
      level: "soft"
    },
    {
      id: "services-dir-only",
      on: "service.image_changed",
      where: { file: "**/services/**" },
      level: "warn"
    }
  ];

  // Base setup
  const baseFiles = [
    { path: "services/web.yml", content: "services:\n  api-dev:\n    image: node:18\n  api-prod:\n    image: node:18\n  prod-gateway:\n    image: envoy:v1\n" },
    { path: "infra/gateway.yml", content: "services:\n  ext-gw:\n    image: proxy:1\n" }
  ];

  // Head setup
  const headFiles = [
    { path: "services/web.yml", content: "services:\n  api-dev:\n    image: node:18\n    privileged: true\n  api-prod:\n    image: node:20\n    privileged: true\n  prod-gateway:\n    image: envoy:v1\n    ports:\n      - '443:443'\n" },
    { path: "infra/gateway.yml", content: "services:\n  ext-gw:\n    image: proxy:2\n" }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  const { findings } = evaluateRules(customRules, diff, baseFacts, headFacts);

  // 1. api-dev should be skipped because of where: { name: "!*-dev" }
  const devPrivileged = findings.find(f => f.ruleId === "no-privileged-non-dev" && f.event.entityId === "service:api-dev");
  assert.equal(devPrivileged, undefined, "api-dev should have been filtered out by !*-dev");

  // 2. api-prod should fire
  const prodPrivileged = findings.find(f => f.ruleId === "no-privileged-non-dev" && f.event.entityId === "service:api-prod");
  assert.ok(prodPrivileged, "api-prod should have triggered no-privileged-non-dev");

  // 3. prod-gateway should fire no-prod-ports
  const prodPort = findings.find(f => f.ruleId === "no-prod-ports" && f.event.entityId === "service:prod-gateway");
  assert.ok(prodPort, "prod-gateway should have triggered no-prod-ports");

  // 4. ext-gw image changed is in infra/, not services/, so services-dir-only should NOT fire on ext-gw
  const extGwFinding = findings.find(f => f.ruleId === "services-dir-only" && f.event.entityId === "service:ext-gw");
  assert.equal(extGwFinding, undefined, "ext-gw in infra/ should be filtered out by **/services/**");

  // 5. api-prod image changed IS in services/, so services-dir-only SHOULD fire on api-prod
  const apiProdImg = findings.find(f => f.ruleId === "services-dir-only" && f.event.entityId === "service:api-prod");
  assert.ok(apiProdImg, "api-prod in services/ should have triggered services-dir-only");
});

// 5. CLI Exit codes 0, 1, 2, 3
test("CLI check returns proper exit codes: 0 (clean/advisory/warn), 2 (soft only), 1 (any hard), 3 (config error)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-exit-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-exit-head-"));
  try {
    // Write base file
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: node:18\n"
    );

    // --- Case 0: Clean (or only advisory/warn) -> Exit code 0
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: node:19\n" // produces service.image_changed (advisory)
    );
    const r0 = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r0.status, 0, `Expected exit 0, got ${r0.status}: ${r0.stderr}`);
    const parsed0 = JSON.parse(r0.stdout);
    assert.equal(parsed0.exitCode, 0);
    assert.equal(parsed0.verdict, "passed");

    // --- Case 2: Soft findings only -> Exit code 2
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: node:18\n    network_mode: host\n" // produces service.host_network_enabled (soft)
    );
    const r2 = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r2.status, 2, `Expected exit 2, got ${r2.status}: ${r2.stderr}`);
    const parsed2 = JSON.parse(r2.stdout);
    assert.equal(parsed2.exitCode, 2);
    assert.equal(parsed2.verdict, "warning");

    // --- Case 1: Any hard finding -> Exit code 1
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: node:18\n    privileged: true\n    network_mode: host\n" // privileged is hard
    );
    const r1 = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r1.status, 1, `Expected exit 1, got ${r1.status}: ${r1.stderr}`);
    const parsed1 = JSON.parse(r1.stdout);
    assert.equal(parsed1.exitCode, 1);
    assert.equal(parsed1.verdict, "failed");

    // --- Case 3: Configuration error (e.g. invalid rules schema or missing directory) -> Exit code 3
    const badRulesFile = path.join(tmpHead, "bad-rules.yml");
    fs.writeFileSync(badRulesFile, "version: 99\nrules: []\n"); // invalid version
    const r3Config = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--rules", badRulesFile], { encoding: "utf8" });
    assert.equal(r3Config.status, 3, `Expected exit 3 for bad config, got ${r3Config.status}`);

    // Missing head input (bare `check` with no paths runs the renderer self-check for backward compatibility)
    const r3Missing = spawnSync(process.execPath, [CLI, "check", tmpBase], { encoding: "utf8" });
    assert.equal(r3Missing.status, 3, `Expected exit 3 for missing inputs, got ${r3Missing.status}`);

    // Non-existent directory
    const r3NonExist = spawnSync(process.execPath, [CLI, "check", "non_existent_base_dir", tmpHead], { encoding: "utf8" });
    assert.equal(r3NonExist.status, 3, `Expected exit 3 for missing directory, got ${r3NonExist.status}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 6. Markdown escaping of a hostile service name
test("markdown escaping neutralises hostile service names, HTML tags, and @mentions", () => {
  const hostileServiceName = "<script>alert('xss')</script> **bold** @everyone [click](javascript:void)";
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-hostile-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-hostile-head-"));
  const reportPath = path.join(tmpHead, "report.md");
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      `services:\n  "${hostileServiceName}":\n    image: alpine\n`
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      `services:\n  "${hostileServiceName}":\n    image: alpine\n    privileged: true\n`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--md", reportPath], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit code 1, got ${r.status}. Stderr: ${r.stderr}`);

    const mdContent = fs.readFileSync(reportPath, "utf8");

    // 1. No raw HTML tags
    assert.equal(mdContent.includes("<script>"), false, "Raw <script> tag found in markdown");
    // Outside code spans tags are HTML-escaped; inside code spans (entity, file) a zero-width space breaks the tag instead
    assert.ok(mdContent.includes("&lt;script&gt;") || mdContent.includes("<\u200Bscript>"), "Script tag was not neutralised");

    // 2. @mentions are neutralised with zero-width space
    assert.equal(mdContent.includes("@everyone"), false, "Raw @everyone mention found in markdown");
    assert.ok(mdContent.includes("@\u200Beveryone"), "Mention was not neutralised");

    // 3. Header verdict line present
    assert.ok(mdContent.includes("## ⛔ Architecture Guardrails: Failed"));

    // 4. Markdown links/brackets escaped
    assert.ok(mdContent.includes("\\[click\\]") || mdContent.includes("&lt;"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 7. A run over 2,000 entities completes in < 3 s
test("a run over 2,000 entities completes in < 3 s", () => {
  const modelLines = [];
  for (let i = 1; i <= 500; i++) {
    modelLines.push(`model Entity${i} {
  id Int @id
  name String
  status String
  count Int
}`);
  }

  // Base setup: model 200 has optional status
  const baseLines = [...modelLines];
  baseLines[200] = baseLines[200].replace("status String", "status String?");

  // Head setup:
  // - model 100: field type changed Int -> BigInt (warn)
  // - model 200: status String (optional in base -> required in head) (warn)
  const headLines = [...modelLines];
  headLines[100] = headLines[100].replace("count Int", "count BigInt");

  const t0 = performance.now();

  const baseFacts = extractFacts([{ path: "schema.prisma", content: baseLines.join("\n\n") }]);
  const headFacts = extractFacts([{ path: "schema.prisma", content: headLines.join("\n\n") }]);

  // 500 models * 5 entities each (1 model + 4 fields) = 2500 entities
  assert.equal(baseFacts.entities.length, 2500);
  assert.equal(headFacts.entities.length, 2500);

  const diff = diffFacts(baseFacts, headFacts);
  const { findings } = evaluateRules(RECOMMENDED_RULES, diff, baseFacts, headFacts);
  const exitCode = getExitCode(findings);
  const report = formatMarkdownReport(findings);

  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  assert.ok(elapsedMs < 3000, `Expected run over 2,000 entities in < 3000 ms, took ${elapsedMs.toFixed(1)} ms`);
  assert.ok(findings.some(f => f.ruleId === "db-field-type-changed"));
  assert.ok(findings.some(f => f.ruleId === "db-field-made-required"));
  assert.equal(exitCode, 0, "Warn-only findings should result in exitCode 0");
  assert.ok(report.includes("✅"));
});

// 8. Existing violations do not fail a PR
test("existing violations do not fail a PR (new-only judging)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-exist-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-exist-head-"));
  try {
    const composeContent = "services:\n  legacy-service:\n    image: redis:6\n    privileged: true\n    network_mode: host\n";
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), composeContent);
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), composeContent);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for unchanged existing violations, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.equal(parsed.summary.blocking, 0);
    assert.equal(parsed.summary.total, 0);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 9. archtour check --state evaluates current facts for violations (informational exit 0 unless --strict)
test("archtour check --state evaluates current facts for violations (exit 0 unless --strict)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-state-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n    privileged: true\n    network_mode: host\n"
    );

    // State check without --strict: reports violations, exits 0 (informational for dashboards)
    const rInfo = spawnSync(process.execPath, [CLI, "check", "--state", tmpDir, "--json"], { encoding: "utf8" });
    assert.equal(rInfo.status, 0, `Expected exit 0 for state check without --strict, got ${rInfo.status}: ${rInfo.stderr}`);
    const parsedInfo = JSON.parse(rInfo.stdout);
    assert.equal(parsedInfo.exitCode, 0);
    assert.equal(parsedInfo.summary.hard, 1, "Expected 1 hard violation (privileged)");
    assert.equal(parsedInfo.summary.soft, 1, "Expected 1 soft violation (host network)");
    assert.ok(parsedInfo.findings.some(f => f.ruleId === "no-privileged-containers"));
    assert.ok(parsedInfo.findings.some(f => f.ruleId === "no-host-network"));

    // State check with --strict: exits with failure code (1 for hard finding)
    const rStrict = spawnSync(process.execPath, [CLI, "check", "--state", tmpDir, "--strict", "--json"], { encoding: "utf8" });
    assert.equal(rStrict.status, 1, `Expected exit 1 for state check with --strict, got ${rStrict.status}`);
    const parsedStrict = JSON.parse(rStrict.stdout);
    assert.equal(parsedStrict.exitCode, 1);
    assert.equal(parsedStrict.verdict, "failed");

    // Also verify archtour check <dir> --state syntax
    const rAlt = spawnSync(process.execPath, [CLI, "check", tmpDir, "--state", "--json"], { encoding: "utf8" });
    assert.equal(rAlt.status, 0);
    const parsedAlt = JSON.parse(rAlt.stdout);
    assert.equal(parsedAlt.summary.hard, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 10. Baseline ratchet: baseline command writes counts; check detects count UP and count DOWN
test("baseline ratchet: baseline command writes counts, check reports count up (finding) and count down (celebration)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-ratchet-test-"));
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-ratchet-base-"));
  const tmpHeadUp = fs.mkdtempSync(path.join(os.tmpdir(), "check-ratchet-head-up-"));
  const tmpHeadDown = fs.mkdtempSync(path.join(os.tmpdir(), "check-ratchet-head-down-"));

  try {
    // 1. Write initial compose file with 1 host-network service
    fs.writeFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app1:\n    image: node:18\n    network_mode: host\n"
    );

    // 2. Run archtour baseline
    const rBase = spawnSync(process.execPath, [CLI, "baseline", tmpDir], { encoding: "utf8" });
    assert.equal(rBase.status, 0, `Baseline command failed: ${rBase.stderr}`);
    const baselineFile = path.join(tmpDir, ".archtour", "baseline.json");
    assert.ok(fs.existsSync(baselineFile), "Baseline file was not created");
    const baselineCounts = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    assert.equal(baselineCounts["no-host-network"], 1);

    // Copy baseline file to base and head test directories
    fs.mkdirSync(path.join(tmpBase, ".archtour"), { recursive: true });
    fs.copyFileSync(baselineFile, path.join(tmpBase, ".archtour", "baseline.json"));
    fs.mkdirSync(path.join(tmpHeadUp, ".archtour"), { recursive: true });
    fs.copyFileSync(baselineFile, path.join(tmpHeadUp, ".archtour", "baseline.json"));
    fs.mkdirSync(path.join(tmpHeadDown, ".archtour"), { recursive: true });
    fs.copyFileSync(baselineFile, path.join(tmpHeadDown, ".archtour", "baseline.json"));

    // Base directory for PR
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app1:\n    image: node:18\n    network_mode: host\n"
    );

    // --- Case UP: Head introduces a second host_network service (count goes 1 -> 2)
    fs.writeFileSync(
      path.join(tmpHeadUp, "docker-compose.yml"),
      "services:\n  app1:\n    image: node:18\n    network_mode: host\n  app2:\n    image: node:18\n    network_mode: host\n"
    );
    const rUp = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHeadUp, "--json"], { encoding: "utf8" });
    assert.equal(rUp.status, 2, `Expected exit 2 for ratchet increase on soft rule, got ${rUp.status}: ${rUp.stderr}`);
    const parsedUp = JSON.parse(rUp.stdout);
    const ratchetFinding = parsedUp.findings.find(f => f.ruleId === "no-host-network" && f.message.includes("ratchet: no-host-network 1 -> 2"));
    assert.ok(ratchetFinding, "Ratchet finding not emitted when count went UP");
    assert.equal(ratchetFinding.level, "soft");

    // --- Case DOWN: Head removes host_network (count goes 1 -> 0)
    fs.writeFileSync(
      path.join(tmpHeadDown, "docker-compose.yml"),
      "services:\n  app1:\n    image: node:18\n"
    );
    const rDown = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHeadDown], { encoding: "utf8" });
    assert.equal(rDown.status, 0, `Expected exit 0 for count decrease, got ${rDown.status}`);
    assert.ok(rDown.stdout.includes("ratchet: no-host-network dropped from 1 to 0"), "Celebration line missing for count decrease");
    assert.ok(rDown.stdout.includes("archtour baseline"), "Hint to run archtour baseline missing");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHeadUp, { recursive: true, force: true });
    fs.rmSync(tmpHeadDown, { recursive: true, force: true });
  }
});

// 11. Exceptions: matching unexpired exception turns finding into excepted; expired exception reported as warn and does not suppress
test("exceptions: matching unexpired exception suppresses, expired exception reported as warn and does not suppress", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-ex-base-"));
  const tmpHeadValid = fs.mkdtempSync(path.join(os.tmpdir(), "check-ex-head-valid-"));
  const tmpHeadExpired = fs.mkdtempSync(path.join(os.tmpdir(), "check-ex-head-expired-"));

  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  worker:\n    image: alpine\n"
    );

    // --- Case 1: Unexpired matching exception -> turns into excepted, exits 0
    fs.writeFileSync(
      path.join(tmpHeadValid, "docker-compose.yml"),
      "services:\n  worker:\n    image: alpine\n    network_mode: host\n"
    );
    fs.mkdirSync(path.join(tmpHeadValid, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHeadValid, ".archtour", "exceptions.yml"),
      `
- rule: no-host-network
  target: "service:worker"
  reason: "Required for high performance metric collector"
  owner: "@infra-core"
  expires: "2027-06-01"
`
    );

    const rValid = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHeadValid, "--policy-from", "head", "--now", "2026-11-14", "--json"], { encoding: "utf8" });
    assert.equal(rValid.status, 0, `Expected exit 0 for excepted finding, got ${rValid.status}: ${rValid.stderr}`);
    const parsedValid = JSON.parse(rValid.stdout);
    assert.equal(parsedValid.summary.excepted, 1);
    assert.equal(parsedValid.summary.blocking, 0);
    const exceptedF = parsedValid.findings.find(f => f.ruleId === "no-host-network");
    assert.ok(exceptedF.excepted, "Finding should be marked as excepted");

    // Also check Markdown report shows Excepted section
    const rMd = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHeadValid, "--policy-from", "head", "--now", "2026-11-14"], { encoding: "utf8" });
    assert.ok(rMd.stdout.includes("### 🛡️ Excepted"));
    assert.ok(rMd.stdout.includes("Required for high performance metric collector"));

    // --- Case 2: Expired exception -> emitted as warn finding, does not suppress violation
    fs.writeFileSync(
      path.join(tmpHeadExpired, "docker-compose.yml"),
      "services:\n  worker:\n    image: alpine\n    network_mode: host\n"
    );
    fs.mkdirSync(path.join(tmpHeadExpired, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHeadExpired, ".archtour", "exceptions.yml"),
      `
- rule: no-host-network
  target: "service:worker"
  reason: "Temporary migration exception"
  owner: "@infra-core"
  expires: "2025-01-01"
`
    );

    const rExpired = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHeadExpired, "--policy-from", "head", "--now", "2026-11-14", "--json"], { encoding: "utf8" });
    assert.equal(rExpired.status, 2, `Expected exit 2 because expired exception must not suppress soft finding, got ${rExpired.status}`);
    const parsedExpired = JSON.parse(rExpired.stdout);
    assert.equal(parsedExpired.summary.excepted, 0);
    const expiredF = parsedExpired.findings.find(f => f.ruleId === "exception-expired");
    assert.ok(expiredF, "Expected exception-expired finding");
    assert.equal(expiredF.level, "warn");
    assert.ok(expiredF.message.includes("expired on 2025-01-01"));

    const unsuppressedF = parsedExpired.findings.find(f => f.ruleId === "no-host-network");
    assert.ok(!unsuppressedF.excepted, "Soft finding should remain un-excepted");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHeadValid, { recursive: true, force: true });
    fs.rmSync(tmpHeadExpired, { recursive: true, force: true });
  }
});

// 12. Exceptions validation errors: missing reason -> exit 3, expires > 365 days -> exit 3
test("exceptions schema validation: missing reason -> exit 3 with line, expires > 365 days -> exit 3 with line", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-ex-err-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-ex-err-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });

    // Missing reason
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "exceptions.yml"),
      `
- rule: no-host-network
  target: "*"
  owner: "@platform"
  expires: "2027-01-01"
`
    );
    const rMissingReason = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(rMissingReason.status, 3, `Expected exit 3 for missing reason, got ${rMissingReason.status}`);
    assert.ok(rMissingReason.stderr.includes('missing or empty required field "reason"'));
    assert.ok(rMissingReason.stderr.includes("line"), "Stderr should report the line number");

    // Expires > 365 days ahead
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "exceptions.yml"),
      `
- rule: no-host-network
  target: "*"
  reason: "Valid reason"
  owner: "@platform"
  expires: "2030-01-01"
`
    );
    const rMaxDays = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--now", "2026-11-14"], { encoding: "utf8" });
    assert.equal(rMaxDays.status, 3, `Expected exit 3 for expires > 365 days, got ${rMaxDays.status}`);
    assert.ok(rMaxDays.stderr.includes("365 days"));
    assert.ok(rMaxDays.stderr.includes("line"), "Stderr should report the line number");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 13. enforce_from before/after (inject now)
test("enforce_from: before date reports as warn with transition notice, on/after reports at configured level", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-enforce-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-enforce-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");

    const rulesFile = path.join(tmpHead, "rollout-rules.yml");
    fs.writeFileSync(
      rulesFile,
      `
version: 1
rules:
  - id: rollout-privileged
    on: service.privileged_enabled
    level: hard
    enforce_from: "2027-01-01"
    message: "Privileged mode is forbidden."
`
    );

    // Before date: reports as warn with (becomes hard on 2027-01-01), exit code 0
    const rBefore = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--rules", rulesFile, "--now", "2026-11-14", "--json"], { encoding: "utf8" });
    assert.equal(rBefore.status, 0, `Expected exit 0 before enforce_from date, got ${rBefore.status}: ${rBefore.stderr}`);
    const parsedBefore = JSON.parse(rBefore.stdout);
    assert.equal(parsedBefore.exitCode, 0);
    assert.equal(parsedBefore.summary.hard, 0);
    assert.equal(parsedBefore.summary.warn, 1);
    const fBefore = parsedBefore.findings.find(f => f.ruleId === "rollout-privileged");
    assert.ok(fBefore);
    assert.equal(fBefore.level, "warn");
    assert.ok(fBefore.message.includes("(becomes hard on 2027-01-01)"));

    // After date: reports as hard, exit code 1
    const rAfter = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--rules", rulesFile, "--now", "2027-02-01", "--json"], { encoding: "utf8" });
    assert.equal(rAfter.status, 1, `Expected exit 1 after enforce_from date, got ${rAfter.status}`);
    const parsedAfter = JSON.parse(rAfter.stdout);
    assert.equal(parsedAfter.exitCode, 1);
    assert.equal(parsedAfter.summary.hard, 1);
    const fAfter = parsedAfter.findings.find(f => f.ruleId === "rollout-privileged");
    assert.equal(fAfter.level, "hard");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 14. Overrides: soft by owner works, by non-owner refused; hard never overridable; JSON audit entries
test("overrides: soft by owner works, by non-owner refused, hard never overridable; JSON audit entries", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n    network_mode: host\n"
    );

    const rulesFile = path.join(tmpHead, "override-rules.yml");
    fs.writeFileSync(
      rulesFile,
      `
version: 1
rules:
  - id: custom-host-network
    on: service.host_network_enabled
    level: soft
    owners: ["alice", "@acme/core-infra"]
    message: "No host network."
  - id: custom-privileged
    on: service.privileged_enabled
    level: hard
    owners: ["alice"]
    message: "No privileged."
`
    );

    // 1. Soft override by direct owner login ("alice") works -> exit 0
    const rOwner = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--rules", rulesFile,
        "--override", "custom-host-network",
        "--override-by", "alice",
        "--override-reason", "Incident mitigation approved",
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(rOwner.status, 0, `Expected exit 0 for valid override, got ${rOwner.status}: ${rOwner.stderr}`);
    const parsedOwner = JSON.parse(rOwner.stdout);
    assert.equal(parsedOwner.exitCode, 0);
    assert.equal(parsedOwner.summary.overridden, 1);
    assert.equal(parsedOwner.summary.blocking, 0);
    assert.equal(parsedOwner.overrides.length, 1);
    assert.equal(parsedOwner.overrides[0].ruleId, "custom-host-network");
    assert.equal(parsedOwner.overrides[0].overriddenBy, "alice");
    assert.equal(parsedOwner.overrides[0].reason, "Incident mitigation approved");
    assert.ok(parsedOwner.overrides[0].timestamp);

    // Check Markdown output format for overridden findings
    const rMd = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--rules", rulesFile,
        "--override", "custom-host-network",
        "--override-by", "alice",
        "--override-reason", "Incident mitigation approved"
      ],
      { encoding: "utf8" }
    );
    assert.ok(rMd.stdout.includes("### 🔓 Overridden"));
    assert.ok(rMd.stdout.includes("overridden by alice: Incident mitigation approved"));

    // 2. Soft override by team member via --owner-teams works -> exit 0
    const rTeam = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--rules", rulesFile,
        "--override", "custom-host-network",
        "--override-by", "bob",
        "--owner-teams", "@acme/core-infra",
        "--override-reason", "Platform team ticket #404",
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(rTeam.status, 0, `Expected exit 0 for team override, got ${rTeam.status}: ${rTeam.stderr}`);
    const parsedTeam = JSON.parse(rTeam.stdout);
    assert.equal(parsedTeam.summary.overridden, 1);

    // 3. Override by non-owner refused -> remains soft, exit 2
    const rNonOwner = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--rules", rulesFile,
        "--override", "custom-host-network",
        "--override-by", "charlie",
        "--override-reason", "Trying to override",
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(rNonOwner.status, 2, `Expected exit 2 for non-owner override, got ${rNonOwner.status}`);
    assert.ok(rNonOwner.stderr.includes('refused: "charlie" is not an owner'));
    const parsedNonOwner = JSON.parse(rNonOwner.stdout);
    assert.equal(parsedNonOwner.summary.overridden, 0);
    assert.equal(parsedNonOwner.summary.soft, 1);

    // 4. Hard rule can never be overridden -> exit 1
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n    privileged: true\n"
    );
    const rHard = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--rules", rulesFile,
        "--override", "custom-privileged",
        "--override-by", "alice",
        "--override-reason", "Emergency"
      ],
      { encoding: "utf8" }
    );
    assert.equal(rHard.status, 1, `Expected exit 1 for hard rule override attempt, got ${rHard.status}`);
    assert.ok(rHard.stderr.includes('hard rule "custom-privileged" can never be overridden'));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 15. PR policy guardrails: base-side policy, policy-changed findings, and tightening escape valves
test("PR cannot approve itself: policy read from base, policy changes as findings, tightening allowed, bootstrap notice, --policy-from head", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-policy-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-policy-head-"));

  try {
    // 15.1: a PR adding privileged + its own exception -> exit 1 (hard finding stands) and a policy-changed finding
    {
      const base1 = path.join(tmpBase, "t1");
      const head1 = path.join(tmpHead, "t1");
      fs.mkdirSync(path.join(base1, ".archtour"), { recursive: true });
      fs.mkdirSync(path.join(head1, ".archtour"), { recursive: true });

      // Base has rules extending recommended
      fs.writeFileSync(path.join(base1, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
      fs.writeFileSync(path.join(base1, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");

      // Head adds privileged mode AND its own exception
      fs.writeFileSync(path.join(head1, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
      fs.writeFileSync(path.join(head1, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");
      fs.writeFileSync(
        path.join(head1, ".archtour", "exceptions.yml"),
        `- rule: no-privileged-containers\n  target: "service:app"\n  reason: "Need privileged"\n  owner: "@dev"\n  expires: "2027-01-01"\n`
      );

      const r1 = spawnSync(process.execPath, [CLI, "check", base1, head1, "--now", "2026-11-14", "--json"], { encoding: "utf8" });
      assert.equal(r1.status, 1, `Expected exit 1 (hard finding stands), got ${r1.status}: ${r1.stderr}`);
      const p1 = JSON.parse(r1.stdout);
      assert.equal(p1.exitCode, 1);
      assert.equal(p1.summary.hard, 1);

      const privFinding = p1.findings.find(f => f.ruleId === "no-privileged-containers");
      assert.ok(privFinding, "Hard finding no-privileged-containers must be present");
      assert.equal(privFinding.excepted, undefined, "Hard finding must NOT be excepted by PR's own exception");

      const policyFinding = p1.findings.find(f => f.ruleId === "policy-changed");
      assert.ok(policyFinding, "policy-changed finding must be present");
      assert.equal(policyFinding.level, "soft");

      // Verify Markdown output includes Policy changes section
      const r1Md = spawnSync(process.execPath, [CLI, "check", base1, head1, "--now", "2026-11-14"], { encoding: "utf8" });
      assert.ok(r1Md.stdout.includes("### Policy changes in this PR (apply after merge)"));
    }

    // 15.2: a PR deleting a repo hard rule while adding a violation -> blocked
    {
      const base2 = path.join(tmpBase, "t2");
      const head2 = path.join(tmpHead, "t2");
      fs.mkdirSync(path.join(base2, ".archtour"), { recursive: true });
      fs.mkdirSync(path.join(head2, ".archtour"), { recursive: true });

      // Base defines custom hard rule
      fs.writeFileSync(
        path.join(base2, ".archtour", "rules.yml"),
        `version: 1\nrules:\n  - id: custom-hard-rule\n    on: service.host_network_enabled\n    level: hard\n    owners: ["@security-team"]\n    message: "Host network forbidden"\n`
      );
      fs.writeFileSync(path.join(base2, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");

      // Head deletes the hard rule from rules.yml and introduces host_network
      fs.writeFileSync(path.join(head2, ".archtour", "rules.yml"), "version: 1\nrules: []\n");
      fs.writeFileSync(path.join(head2, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    network_mode: host\n");

      const r2 = spawnSync(process.execPath, [CLI, "check", base2, head2, "--json"], { encoding: "utf8" });
      assert.equal(r2.status, 1, `Expected exit 1 (blocked by base-defined hard rule), got ${r2.status}: ${r2.stderr}`);
      const p2 = JSON.parse(r2.stdout);
      assert.equal(p2.exitCode, 1);
      assert.ok(p2.findings.some(f => f.ruleId === "custom-hard-rule" && f.level === "hard"));
      const pChange = p2.findings.find(f => f.ruleId === "policy-changed");
      assert.ok(pChange, "policy-changed finding must be present for deleted rule");
      assert.deepEqual(pChange.owners, ["@security-team"]);
    }

    // 15.3: tightening (new rule, shorter expiry, removed exception) -> no policy finding
    {
      const base3 = path.join(tmpBase, "t3");
      const head3 = path.join(tmpHead, "t3");
      fs.mkdirSync(path.join(base3, ".archtour"), { recursive: true });
      fs.mkdirSync(path.join(head3, ".archtour"), { recursive: true });

      fs.writeFileSync(
        path.join(base3, ".archtour", "rules.yml"),
        `version: 1\nrules:\n  - id: existing-soft\n    on: service.image_changed\n    level: soft\n`
      );
      fs.writeFileSync(
        path.join(base3, ".archtour", "exceptions.yml"),
        `- rule: no-host-network\n  target: "service:a"\n  reason: "A"\n  owner: "@infra"\n  expires: "2027-06-01"\n- rule: no-host-network\n  target: "service:b"\n  reason: "B"\n  owner: "@infra"\n  expires: "2027-06-01"\n`
      );
      fs.writeFileSync(path.join(base3, ".archtour", "baseline.json"), JSON.stringify({ "no-host-network": 5 }));
      fs.writeFileSync(path.join(base3, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

      // Head: adds new rule (tightening), shortens expiry of service:a (tightening), removes service:b exception (tightening), lowers baseline (tightening)
      fs.writeFileSync(
        path.join(head3, ".archtour", "rules.yml"),
        `version: 1\nrules:\n  - id: existing-soft\n    on: service.image_changed\n    level: soft\n  - id: new-hard-rule\n    on: service.docker_socket_mounted\n    level: hard\n`
      );
      fs.writeFileSync(
        path.join(head3, ".archtour", "exceptions.yml"),
        `- rule: no-host-network\n  target: "service:a"\n  reason: "A"\n  owner: "@infra"\n  expires: "2026-12-01"\n`
      );
      fs.writeFileSync(path.join(head3, ".archtour", "baseline.json"), JSON.stringify({ "no-host-network": 3 }));
      fs.writeFileSync(path.join(head3, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

      const r3 = spawnSync(process.execPath, [CLI, "check", base3, head3, "--now", "2026-11-14", "--json"], { encoding: "utf8" });
      assert.equal(r3.status, 0, `Expected exit 0 for tightening changes, got ${r3.status}: ${r3.stderr}`);
      const p3 = JSON.parse(r3.stdout);
      assert.equal(p3.exitCode, 0);
      assert.equal(p3.findings.filter(f => f.ruleId === "policy-changed").length, 0, "No policy-changed finding should be generated for tightening");

      // Verify Markdown output includes Policy changes section
      const r3Md = spawnSync(process.execPath, [CLI, "check", base3, head3, "--now", "2026-11-14"], { encoding: "utf8" });
      assert.ok(r3Md.stdout.includes("### Policy changes in this PR (apply after merge)"));
      assert.ok(r3Md.stdout.includes("Rule \"new-hard-rule\" added"));
      assert.ok(r3Md.stdout.includes("Exception expiry shortened"));
      assert.ok(r3Md.stdout.includes("Exception removed"));
      assert.ok(r3Md.stdout.includes("Baseline count lowered"));
    }

    // 15.4: bootstrap (no base policy) -> recommended rules + policy-changed finding
    {
      const base4 = path.join(tmpBase, "t4");
      const head4 = path.join(tmpHead, "t4");
      fs.mkdirSync(base4, { recursive: true });
      fs.mkdirSync(path.join(head4, ".archtour"), { recursive: true });

      // Base has NO .archtour directory
      fs.writeFileSync(path.join(base4, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

      // Head defines a custom hard rule
      fs.writeFileSync(
        path.join(head4, ".archtour", "rules.yml"),
        `version: 1\nrules:\n  - id: bootstrap-rule\n    on: service.image_changed\n    level: hard\n    message: "Image changes strictly blocked"\n`
      );
      fs.writeFileSync(path.join(head4, "docker-compose.yml"), "services:\n  app:\n    image: nginx:2.0\n");

      const r4 = spawnSync(process.execPath, [CLI, "check", base4, head4, "--json"], { encoding: "utf8" });
      assert.equal(r4.status, 2, `Expected exit 2 (built-in recommended rules + soft policy-changed), got ${r4.status}: ${r4.stderr}`);
      const p4 = JSON.parse(r4.stdout);
      assert.ok(!p4.findings.some(f => f.ruleId === "bootstrap-rule"), "Head custom rule bootstrap-rule must not govern PR");
      assert.ok(p4.findings.some(f => f.ruleId === "policy-changed"), "policy-changed finding must be present");
      assert.ok(p4.findings.some(f => f.ruleId === "service-image-changed"), "service-image-changed finding from recommended rules must be present");
      assert.ok(r4.stderr.includes("notice: base has no .archtour/, using the built-in recommended rules (a new policy applies after merge)"), "Bootstrap notice should be printed to stderr");
    }

    // 15.5: --policy-from head reproduces the old behaviour
    {
      const base5 = path.join(tmpBase, "t5");
      const head5 = path.join(tmpHead, "t5");
      fs.mkdirSync(path.join(base5, ".archtour"), { recursive: true });
      fs.mkdirSync(path.join(head5, ".archtour"), { recursive: true });

      fs.writeFileSync(path.join(base5, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
      fs.writeFileSync(path.join(base5, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");

      // Head adds privileged mode and exception
      fs.writeFileSync(path.join(head5, ".archtour", "rules.yml"), "version: 1\nextends: [archtour:recommended]\n");
      fs.writeFileSync(path.join(head5, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");
      fs.writeFileSync(
        path.join(head5, ".archtour", "exceptions.yml"),
        `- rule: no-privileged-containers\n  target: "service:app"\n  reason: "Test exception"\n  owner: "@dev"\n  expires: "2027-01-01"\n`
      );

      // Running with --policy-from head
      const r5 = spawnSync(process.execPath, [CLI, "check", base5, head5, "--policy-from", "head", "--now", "2026-11-14", "--json"], { encoding: "utf8" });
      assert.equal(r5.status, 0, `Expected exit 0 when using head policy with valid exception, got ${r5.status}: ${r5.stderr}`);
      const p5 = JSON.parse(r5.stdout);
      assert.equal(p5.summary.hard, 0);
      assert.equal(p5.summary.excepted, 1);
      const exceptedF = p5.findings.find(f => f.ruleId === "no-privileged-containers");
      assert.ok(exceptedF && exceptedF.excepted, "Finding should be excepted under --policy-from head");
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 16. Docs validation: the built-in table in docs/GUARDRAILS.md lists every id in RECOMMENDED_RULES
test("docs/GUARDRAILS.md built-in pack table lists every id in RECOMMENDED_RULES", () => {
  const docsPath = path.resolve("docs/GUARDRAILS.md");
  assert.ok(fs.existsSync(docsPath), "docs/GUARDRAILS.md must exist");
  const docsContent = fs.readFileSync(docsPath, "utf8");

  // Read RECOMMENDED_RULES
  assert.ok(RECOMMENDED_RULES && RECOMMENDED_RULES.length > 0, "RECOMMENDED_RULES must not be empty");

  // Locate the Built-in Pack table in section 3
  const section3Match = docsContent.match(/## 3\.\s+Built-in Pack[\s\S]*?(?=\n## \d|\n---\n##|$)/);
  assert.ok(section3Match, "Section 3 (Built-in Pack) must exist in docs/GUARDRAILS.md");
  const section3Text = section3Match[0];

  const missingIds = [];
  for (const rule of RECOMMENDED_RULES) {
    // Check that each rule ID is present as a code block in the table, e.g. `rule-id`
    const idPattern = new RegExp(`\`${rule.id}\``);
    if (!idPattern.test(section3Text)) {
      missingIds.push(rule.id);
    }
  }

  assert.deepEqual(
    missingIds,
    [],
    `The following rule ids from RECOMMENDED_RULES are missing in docs/GUARDRAILS.md Section 3 table:\n${missingIds.join("\n")}`
  );
});

// 17. New Compose service with privileged + host network + docker socket + 0.0.0.0 port -> 4 findings, exit 1
test("new Compose service with privileged + host network + docker socket + 0.0.0.0 port produces 4 findings, exit 1", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-new-compose-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-new-compose-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  existing:\n    image: alpine\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      `services:
  existing:
    image: alpine
  evil:
    image: alpine
    privileged: true
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "0.0.0.0:2375:2375"
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.verdict, "failed");

    const evilFindings = parsed.findings.filter(f => f.event && f.event.entityId === "service:evil");
    const ruleIds = evilFindings.map(f => f.ruleId);
    assert.ok(ruleIds.includes("no-privileged-containers"), "Expected no-privileged-containers finding");
    assert.ok(ruleIds.includes("no-docker-socket-mount"), "Expected no-docker-socket-mount finding");
    assert.ok(ruleIds.includes("no-host-network"), "Expected no-host-network finding");
    assert.ok(ruleIds.includes("no-all-interfaces-port-binding"), "Expected no-all-interfaces-port-binding finding");
    assert.equal(evilFindings.length, 4, `Expected exactly 4 findings on service:evil, got ${evilFindings.length}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 18. New k8s Deployment with hostNetwork + hostPath -> findings
test("new k8s Deployment with hostNetwork + hostPath produces findings", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-new-k8s-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-new-k8s-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "deployment.yaml"),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: safe-app
spec:
  template:
    spec:
      containers:
        - name: safe
          image: alpine
`
    );
    fs.writeFileSync(
      path.join(tmpHead, "deployment.yaml"),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: safe-app
spec:
  template:
    spec:
      containers:
        - name: safe
          image: alpine
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: risky-app
spec:
  template:
    spec:
      hostNetwork: true
      volumes:
        - name: host-vol
          hostPath:
            path: /etc
      containers:
        - name: app
          image: alpine
          resources:
            limits:
              cpu: 500m
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(r.stdout);
    const hostNetworkF = parsed.findings.find(f => f.ruleId === "no-k8s-host-network-or-pid");
    assert.ok(hostNetworkF, "Expected no-k8s-host-network-or-pid finding for new Deployment");
    const hostPathF = parsed.findings.find(f => f.ruleId === "no-k8s-host-path-mount");
    assert.ok(hostPathF, "Expected no-k8s-host-path-mount finding for new Deployment");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 19. New API route without security -> api-new-route-public fires (warn, exit 0)
test("new API route without security fires api-new-route-public rule (warn, exit 0)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-new-api-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-new-api-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "openapi.yaml"),
      `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths:
  /users:
    get:
      security:
        - bearerAuth: []
      responses:
        '200':
          description: ok
`
    );
    fs.writeFileSync(
      path.join(tmpHead, "openapi.yaml"),
      `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths:
  /users:
    get:
      security:
        - bearerAuth: []
      responses:
        '200':
          description: ok
  /insecure:
    post:
      responses:
        '200':
          description: ok
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 (warn rule api-new-route-public), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const secFinding = parsed.findings.find(f => f.ruleId === "api-new-route-public" && f.event && f.event.entityId.toLowerCase() === "api.route:post /insecure");
    assert.ok(secFinding, "Expected api-new-route-public finding for new route without security");
    assert.equal(secFinding.level, "warn");
    assert.equal(secFinding.event.before, null);
    assert.equal(secFinding.event.new, true);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 20. Malformed head compose file that parsed in base -> exit 2 with parse-error-head, never "Passed"
test("malformed head compose file that parsed in base exits 2 with parse-error-head, never Passed", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-bad-yaml-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-bad-yaml-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: alpine\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: alpine:\n    bad [[ yaml :::"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for soft finding parse-error-head, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    assert.notEqual(parsed.verdict, "passed", "Verdict must never be 'passed'");
    assert.equal(parsed.verdict, "warning");

    const parseFinding = parsed.findings.find(f => f.ruleId === "parse-error-head");
    assert.ok(parseFinding, "Expected parse-error-head finding");
    assert.equal(parseFinding.level, "soft");
    assert.ok(parseFinding.message.includes("failed to parse in head"));

    // Also test markdown output
    const rMd = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.ok(rMd.stdout.includes("parse-error-head"));
    assert.ok(!rMd.stdout.includes("## ✅ Architecture Guardrails: Passed"));
    assert.ok(rMd.stdout.includes("## ⚠️ Architecture Guardrails: Blocked (soft)"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 21. Advisory finding shown in markdown on a passed run
test("advisory finding is shown in markdown on a passed run and counted in header", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-advisory-md-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-advisory-md-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx:1.20\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx:1.21\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for advisory change, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes("## ✅ Architecture Guardrails: Passed"), "Should have Passed header");
    assert.ok(r.stdout.includes("1 advisory"), "Header verdict line should count advisory findings");
    assert.ok(r.stdout.includes("### ℹ️ Advisory (1)"), "Markdown should have Advisory section");
    assert.ok(r.stdout.includes("service-image-changed"), "Markdown should list the advisory rule");
    assert.ok(!r.stdout.includes("No architecture rule violations detected"), "Should not say no violations detected when advisory findings exist");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 22. New file parse error (soft -> exit 2) and unchanged parse error (warn -> exit 0)
test("new file parse error produces parse-error-new-file (soft), unchanged produces parse-error-unchanged (warn)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-parse-errs-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-parse-errs-head-"));
  try {
    // New unparsable file in head
    fs.writeFileSync(
      path.join(tmpHead, "broken.yaml"),
      "apiVersion: apps/v1\nkind: Deployment:\nbroken ::: [[[yaml"
    );
    const rNew = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(rNew.status, 2, `Expected exit 2 for parse-error-new-file, got ${rNew.status}`);
    const parsedNew = JSON.parse(rNew.stdout);
    assert.ok(parsedNew.findings.some(f => f.ruleId === "parse-error-new-file"));

    // File broken on both sides -> warn
    fs.writeFileSync(
      path.join(tmpBase, "broken.yaml"),
      "apiVersion: apps/v1\nkind: Deployment:\nbroken ::: [[[yaml"
    );
    const rUnchanged = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(rUnchanged.status, 0, `Expected exit 0 for unchanged parse error, got ${rUnchanged.status}`);
    const parsedUnchanged = JSON.parse(rUnchanged.stdout);
    assert.ok(parsedUnchanged.findings.some(f => f.ruleId === "parse-error-unchanged"));
    assert.equal(parsedUnchanged.findings.find(f => f.ruleId === "parse-error-unchanged").level, "warn");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

function hasGit() {
  try {
    const r = spawnSync("git", ["--version"]);
    return r.status === 0;
  } catch {
    return false;
  }
}

// 23. Changed-only results equal full-scan results on a small fixture (same findings)
test("changed-only results equal full-scan results on a small fixture", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-changed-equal-"));
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-changed-base-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    // Base state
    const composeBase = "services:\n  web:\n    image: nginx:1.20\n";
    const prismaBase = "model User {\n  id Int @id\n}\n";
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), composeBase);
    fs.writeFileSync(path.join(tmpRepo, "schema.prisma"), prismaBase);
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), composeBase);
    fs.writeFileSync(path.join(tmpBase, "schema.prisma"), prismaBase);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base commit"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Head state: modify compose, add api route
    const composeHead = "services:\n  web:\n    image: nginx:1.21\n    privileged: true\n";
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), composeHead);
    const apiHead = "openapi: 3.0.0\ninfo:\n  title: API\n  version: 1\npaths:\n  /users:\n    get:\n      operationId: listUsers\n      responses:\n        '200':\n          description: ok\n";
    fs.writeFileSync(path.join(tmpRepo, "openapi.yaml"), apiHead);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "head commit"], { cwd: tmpRepo });

    // Run full scan (baseDir vs headDir)
    const rFull = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(rFull.status, 1, `Full scan expected exit 1, got ${rFull.status}: ${rFull.stderr}`);
    const parsedFull = JSON.parse(rFull.stdout);

    // Run changed-only (--changed-from)
    const rChanged = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(rChanged.status, 1, `Changed-only expected exit 1, got ${rChanged.status}: ${rChanged.stderr}`);
    const parsedChanged = JSON.parse(rChanged.stdout);

    // Findings must match
    assert.equal(parsedChanged.verdict, parsedFull.verdict);
    assert.equal(parsedChanged.exitCode, parsedFull.exitCode);
    assert.equal(parsedChanged.summary.hard, parsedFull.summary.hard);
    assert.equal(parsedChanged.summary.warn, parsedFull.summary.warn);
    assert.equal(parsedChanged.summary.advisory, parsedFull.summary.advisory);

    const fullRuleIds = parsedFull.findings.map(f => f.ruleId).sort();
    const changedRuleIds = parsedChanged.findings.map(f => f.ruleId).sort();
    assert.deepEqual(changedRuleIds, fullRuleIds, "Findings rules should match between full scan and changed-only");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// 24. Renamed file handled as removed+added without false blocking when content identical (same facts -> no events)
test("renamed file handled as removed+added without false blocking when content identical", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-rename-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.mkdirSync(path.join(tmpRepo, "models"), { recursive: true });
    const content = "model User {\n  id Int @id\n}\n";
    fs.writeFileSync(path.join(tmpRepo, "models", "user.prisma"), content);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Rename to account.prisma with identical content
    fs.unlinkSync(path.join(tmpRepo, "models", "user.prisma"));
    fs.writeFileSync(path.join(tmpRepo, "models", "account.prisma"), content);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "rename model file"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for identical content rename, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, "passed");
    assert.equal(parsed.findings.length, 0, "Renaming a file with identical content should produce zero findings");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 25. Paths with spaces and unicode handled correctly via -z parsing
test("paths with spaces and unicode handled correctly via -z parsing", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-unicode-spaces-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.mkdirSync(path.join(tmpRepo, "services"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "modèles"), { recursive: true });

    const composePath = path.join(tmpRepo, "services", "mon service.yml");
    const prismaPath = path.join(tmpRepo, "modèles", "données.prisma");

    fs.writeFileSync(composePath, "services:\n  app:\n    image: redis:6.0\n");
    fs.writeFileSync(prismaPath, "model Data {\n  id Int @id\n}\n");

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Modify image in compose file with space
    fs.writeFileSync(composePath, "services:\n  app:\n    image: redis:7.0\n");

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "update redis"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for advisory change on space path, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, "passed");

    const imageFinding = parsed.findings.find(f => f.ruleId === "service-image-changed");
    assert.ok(imageFinding, "Expected service-image-changed finding");
    assert.ok(imageFinding.source.file.includes("mon service.yml"), "File path with spaces must be preserved");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 26. SQL migrations cumulative: base has 001 (create table with col x), head adds 002 (drop col x)
test("SQL migrations cumulative: base has 001 CREATE and head adds 002 DROP COLUMN, changed-only reports same finding", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-cumul-"));
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-base-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });

    const mig001 = "CREATE TABLE users (\n  id INT PRIMARY KEY,\n  x TEXT\n);\n";
    fs.writeFileSync(path.join(tmpRepo, "migrations", "001_create.sql"), mig001);
    fs.writeFileSync(path.join(tmpBase, "migrations", "001_create.sql"), mig001);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base with 001"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Head adds 002 DROP COLUMN x
    const mig002 = "ALTER TABLE users DROP COLUMN x;\n";
    fs.writeFileSync(path.join(tmpRepo, "migrations", "002_drop.sql"), mig002);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "head adds 002"], { cwd: tmpRepo });

    // Full scan
    const rFull = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(rFull.status, 2, `Expected exit 2 for soft drop column in full scan, got ${rFull.status}`);
    const parsedFull = JSON.parse(rFull.stdout);
    assert.ok(parsedFull.findings.some(f => f.ruleId === "sql-no-drop-column"));

    // Changed-only
    const rChanged = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(rChanged.status, 2, `Expected exit 2 for soft drop column in changed-only, got ${rChanged.status}`);
    const parsedChanged = JSON.parse(rChanged.stdout);
    assert.ok(parsedChanged.findings.some(f => f.ruleId === "sql-no-drop-column"), "Changed-only must detect sql-no-drop-column");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// 27. Fail-closed: changed file that fails in head produces parse-error-head, new unparsable produces parse-error-new-file
test("fail closed: changed file produces parse-error-head, new unparsable produces parse-error-new-file in changed-only mode", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-fail-closed-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  app:\n    image: alpine\n");

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Break docker-compose.yml in head and add new broken file
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  app:\n    image: alpine:\n    bad [[ yaml :::");
    fs.writeFileSync(path.join(tmpRepo, "broken-new.yaml"), "apiVersion: apps/v1\nkind: Deployment:\nbroken ::: [[[yaml");

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "break files"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for soft parse errors, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, "warning");
    assert.ok(parsed.findings.some(f => f.ruleId === "parse-error-head"), "Should emit parse-error-head for modified file");
    assert.ok(parsed.findings.some(f => f.ruleId === "parse-error-new-file"), "Should emit parse-error-new-file for new candidate");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 28. Non-git directory falls back to full scan with notice
test("non-git directory falls back to full scan with notice", () => {
  const tmpNonGit = fs.mkdtempSync(path.join(os.tmpdir(), "check-non-git-"));
  try {
    fs.writeFileSync(path.join(tmpNonGit, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.20\n");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", "main", tmpNonGit, "--json"], { encoding: "utf8" });
    assert.ok(r.stderr.includes("notice: not in a git repository; falling back to full scan") ||
              r.stdout.includes("notice: not in a git repository; falling back to full scan"),
              "Should print notice when not in a git repo");
  } finally {
    fs.rmSync(tmpNonGit, { recursive: true, force: true });
  }
});

// 29. Performance test: 20,000 files fixture with 3 changed sources finishes check in < 2 s
test("performance: 20,000 files fixture with 3 changed sources finishes check in < 2 s", { timeout: 120000 }, (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-perf-"));
  try {
    spawnSync("git", ["init"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "perf@example.com"], { cwd: tmp });
    spawnSync("git", ["config", "user.name", "Perf Test"], { cwd: tmp });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmp });

    // Generate 20,000 files
    const numDirs = 20;
    const filesPerDir = 1000;
    for (let d = 0; d < numDirs; d++) {
      const dirPath = path.join(tmp, `pkg_${d}`);
      fs.mkdirSync(dirPath, { recursive: true });
      for (let f = 0; f < filesPerDir; f++) {
        fs.writeFileSync(path.join(dirPath, `code_${f}.js`), "");
      }
    }

    // 3 candidate architecture files in base
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: node:18\n");
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model User {\n  id Int @id\n}\n");
    fs.writeFileSync(path.join(tmp, "openapi.json"), '{"openapi":"3.0.0","info":{"title":"API","version":"1"},"security":[{"apiKey":[]}],"paths":{}}');

    spawnSync("git", ["add", "-A"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "base commit"], { cwd: tmp });

    // Modify the 3 candidate files in head
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  app:\n    image: node:20\n");
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model User {\n  id Int @id\n  bio String?\n}\n");
    fs.writeFileSync(path.join(tmp, "openapi.json"), '{"openapi":"3.0.0","info":{"title":"API","version":"1"},"security":[{"apiKey":[]}],"paths":{"/users":{"get":{"operationId":"getUsers","responses":{"200":{"description":"ok"}}}}}}');

    spawnSync("git", ["add", "-A"], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "head commit"], { cwd: tmp });

    // Measure check execution time
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", "HEAD~1", tmp, "--json"], {
      encoding: "utf8"
    });
    const elapsed = performance.now() - t0;

    assert.equal(r.status, 0, `check failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, "passed");
    assert.ok(elapsed < 2000, `Expected check to finish in < 2000 ms, took ${elapsed.toFixed(1)} ms`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("changed-only mode through a symlinked folder still checks the files (macOS /var -> /private/var, Windows short names)", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-changed-linked-"));
  try {
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    const git = (...args) => spawnSync("git", args, { cwd: real, encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    git("config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(real, "docker-compose.yml"), "services:\n  api:\n    image: nginx:1.25\n");
    git("add", "-A");
    git("commit", "-m", "base");
    fs.writeFileSync(path.join(real, "docker-compose.yml"), "services:\n  api:\n    image: nginx:1.25\n    privileged: true\n");
    git("commit", "-am", "head");

    const link = path.join(tmp, "link");
    try {
      fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      if (t?.skip) t.skip(`cannot create a directory link: ${err.code}`);
      return;
    }
    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", "HEAD~1", link, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `a privileged container behind a linked folder must fail the check, got ${r.status}: ${r.stderr}`);
    assert.ok(JSON.parse(r.stdout).findings.some((f) => f.ruleId === "no-privileged-containers"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 30. Bootstrap bypass: base without .archtour/, head adds .archtour/rules.yml with empty rules and privileged container
test("bootstrap bypass: base without .archtour/ judges PR using recommended rules and emits policy-changed finding", (t) => {
  // Test 1: Two-dir path
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-bootstrap-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-bootstrap-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpHead, ".archtour", "rules.yml"), "version: 1\nrules: []\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 (hard no-privileged-containers stands), got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.ok(parsed.findings.some(f => f.ruleId === "no-privileged-containers" && f.level === "hard"), "Expected no-privileged-containers hard finding");
    assert.ok(parsed.findings.some(f => f.ruleId === "policy-changed" && f.level === "soft"), "Expected policy-changed soft finding");
    assert.ok(r.stderr.includes("notice: base has no .archtour/, using the built-in recommended rules (a new policy applies after merge)"), "Expected bootstrap notice");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }

  // Test 2: --changed-from mode
  if (!hasGit()) {
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-bootstrap-git-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base without archtour"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), "version: 1\nrules: []\n");
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "head adds empty policy and privileged"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 in --changed-from mode, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.ok(parsed.findings.some(f => f.ruleId === "no-privileged-containers" && f.level === "hard"), "Expected no-privileged-containers hard finding in --changed-from");
    assert.ok(parsed.findings.some(f => f.ruleId === "policy-changed" && f.level === "soft"), "Expected policy-changed soft finding in --changed-from");
    assert.ok(r.stderr.includes("notice: base has no .archtour/, using the built-in recommended rules (a new policy applies after merge)"), "Expected bootstrap notice in --changed-from");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 31. Helm {{ template detection and file-not-checked advisory
test("helm template detection: ordinary {{ in comments/strings parsed normally; real chart skipped with file-not-checked advisory", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-helm-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-helm-head-"));
  try {
    // 1. A k8s Deployment with a "# docs: see {{ wiki }}" comment that turns on privileged: true -> exit 1
    fs.writeFileSync(path.join(tmpBase, "k8s-deploy.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: doc-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx
          securityContext:
            privileged: false
`);
    fs.writeFileSync(path.join(tmpHead, "k8s-deploy.yaml"), `
# docs: see {{ wiki }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: doc-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx
          securityContext:
            privileged: true
`);

    const r1 = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r1.status, 1, `Expected exit 1 for k8s deployment with {{ comment, got ${r1.status}: ${r1.stderr}`);
    const p1 = JSON.parse(r1.stdout);
    assert.ok(p1.findings.some(f => f.level === "hard" && f.ruleId.includes("privileged")), "Hard privileged finding should fire despite {{ comment");

    // 2. A real chart (chart/Chart.yaml + chart/templates/deploy.yaml with {{ .Values.x }}) -> skipped with file-not-checked advisory, exit 0
    const chartBase = path.join(tmpBase, "chart-fixture");
    const chartHead = path.join(tmpHead, "chart-fixture");
    fs.mkdirSync(path.join(chartHead, "chart", "templates"), { recursive: true });
    fs.mkdirSync(chartBase, { recursive: true });
    fs.writeFileSync(path.join(chartHead, "chart", "Chart.yaml"), "name: my-chart\nversion: 0.1.0\n");
    fs.writeFileSync(path.join(chartHead, "chart", "templates", "deploy.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.appName }}
spec:
  template:
    spec:
      containers:
        - name: app
          image: {{ .Values.image }}
`);

    const r2 = spawnSync(process.execPath, [CLI, "check", chartBase, chartHead, "--json"], { encoding: "utf8" });
    assert.equal(r2.status, 2, `Expected exit 2 for a new, unreadable Helm chart template, got ${r2.status}: ${r2.stderr}`);
    const p2 = JSON.parse(r2.stdout);
    const advisory = p2.findings.find(f => f.ruleId === "changed-file-not-checked");
    assert.ok(advisory, "changed-file-not-checked finding must be present");
    assert.equal(advisory.level, "soft");
    assert.ok(advisory.message.includes("chart/templates/deploy.yaml") || advisory.message.includes("deploy.yaml"), "Finding message should name the file");
    assert.ok(advisory.message.includes("Helm template"), "Finding message should name Helm template reason");

    // 3. An OpenAPI YAML with description: "use {{token}}" that removes security -> the security finding still fires
    const apiBase = path.join(tmpBase, "api-fixture");
    const apiHead = path.join(tmpHead, "api-fixture");
    fs.mkdirSync(apiBase, { recursive: true });
    fs.mkdirSync(apiHead, { recursive: true });
    fs.writeFileSync(path.join(apiBase, "openapi.yaml"), `
openapi: 3.0.0
info:
  title: API
  version: 1.0.0
paths:
  /secure:
    get:
      operationId: getSecure
      security:
        - apiKey: []
      responses:
        '200':
          description: ok
`);
    fs.writeFileSync(path.join(apiHead, "openapi.yaml"), `
openapi: 3.0.0
info:
  title: API
  version: 1.0.0
paths:
  /secure:
    get:
      operationId: getSecure
      description: "use {{token}} to authenticate"
      responses:
        '200':
          description: ok
`);

    const r3 = spawnSync(process.execPath, [CLI, "check", apiBase, apiHead, "--json"], { encoding: "utf8" });
    assert.equal(r3.status, 1, `Expected exit 1 for removing API security (hard finding), got ${r3.status}: ${r3.stderr}`);
    const p3 = JSON.parse(r3.stdout);
    assert.ok(p3.findings.some(f => f.ruleId === "no-api-security-removed"), "Expected no-api-security-removed finding to fire");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 32. Terraform detection: real field order with resource_changes after byte 10,000, 50MB cap, non-plans ignored
test("terraform plan detection: real field order with resource_changes > 10KB detected in two-dir and --changed-from; package.json ignored", (t) => {
  const padding = "x".repeat(12000);
  const planData = {
    format_version: "1.2",
    terraform_version: "1.9.0",
    variables: {
      pad: { value: padding }
    },
    planned_values: {
      root_module: {
        resources: []
      }
    },
    resource_changes: [
      {
        address: "aws_db_instance.main",
        type: "aws_db_instance",
        name: "main",
        change: {
          actions: ["delete"]
        }
      }
    ]
  };
  const planJson = JSON.stringify(planData, null, 2);
  const rcPos = planJson.indexOf('"resource_changes"');
  assert.ok(rcPos > 10000, `resource_changes must be past byte 10000, was at ${rcPos}`);

  // Test 1: Two-dir mode
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-tf-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-tf-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "empty.txt"), "");
    fs.writeFileSync(path.join(tmpHead, "tfplan.json"), planJson);

    // Also add package.json and app JSON with format_version but no terraform_version (should NOT be detected as plans)
    fs.writeFileSync(path.join(tmpHead, "package.json"), JSON.stringify({ name: "my-app", version: "1.0.0", format_version: "1.0" }));
    fs.writeFileSync(path.join(tmpHead, "config.json"), JSON.stringify({ format_version: "1.0", app: "settings" }));

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 for stateful delete in terraform plan, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    const tfFinding = parsed.findings.find(f => f.ruleId === "tf-stateful-resource-deleted");
    assert.ok(tfFinding, "Expected tf-stateful-resource-deleted finding");
    assert.equal(tfFinding.level, "hard");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }

  // Test 2: --changed-from mode
  if (!hasGit()) {
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-tf-git-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Init");
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    fs.writeFileSync(path.join(tmpRepo, "tfplan.json"), planJson);
    fs.writeFileSync(path.join(tmpRepo, "package.json"), JSON.stringify({ name: "app", format_version: "1.0" }));
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "add plan"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 in --changed-from mode for TF plan, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.ok(parsed.findings.some(f => f.ruleId === "tf-stateful-resource-deleted"), "Expected tf-stateful-resource-deleted in --changed-from");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 33. Empty-args fail-open: check "" "" and bare check exit 3 with message; selftest is distinct
test("empty-args fail-open: check '' '' and bare check exit 3 with message; selftest is distinct", () => {
  const t0 = performance.now();
  const r1 = spawnSync(process.execPath, [CLI, "check"], { encoding: "utf8" });
  const t1 = performance.now();
  assert.equal(r1.status, 3, `Expected bare check to exit 3, got ${r1.status}`);
  assert.ok(r1.stderr.includes("check needs <base> <head>, --changed-from <ref> or --state <dir>"), "Expected usage message on stderr");
  assert.ok((t1 - t0) < 3000, `Expected check to exit quickly, took ${(t1 - t0).toFixed(1)} ms`);

  const r2 = spawnSync(process.execPath, [CLI, "check", "", ""], { encoding: "utf8" });
  assert.equal(r2.status, 3, `Expected check '' '' to exit 3, got ${r2.status}`);
  assert.ok(r2.stderr.includes("check needs <base> <head>, --changed-from <ref> or --state <dir>"));

  const r3 = spawnSync(process.execPath, [CLI, "check", "  ", "  "], { encoding: "utf8" });
  assert.equal(r3.status, 3, `Expected check '  ' '  ' to exit 3, got ${r3.status}`);
  assert.ok(r3.stderr.includes("check needs <base> <head>, --changed-from <ref> or --state <dir>"));
});

// 34. Fail-closed: file parsed in base and skipped in head produces parse-error-head, not reported as removed
test("fail closed: file parsed in base and skipped in head produces parse-error-head, not removed", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-failclosed-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-failclosed-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.20\n");
    // Head docker-compose.yml exceeds 5 MB cap -> skipped
    const largePad = "# " + "x".repeat(6 * 1024 * 1024) + "\n";
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.20\n" + largePad);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for soft parse-error-head, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    assert.ok(parsed.findings.some(f => f.ruleId === "parse-error-head"), "Expected parse-error-head finding");
    assert.ok(parsed.findings.some(f => f.ruleId === "file-not-checked"), "Expected file-not-checked finding");
    assert.ok(!parsed.findings.some(f => f.event?.type === "entity.removed" || f.event?.type?.endsWith("_removed")), "Service must not be reported as removed");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("a {{ comment in a multi-document k8s file does not hide a privileged container", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "helm-multidoc-base-"));
  const head = fs.mkdtempSync(path.join(os.tmpdir(), "helm-multidoc-head-"));
  try {
    const doc = (privileged) => [
      "# docs: see {{ wiki }}",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          image: ghcr.io/acme/api:1.0",
      "          securityContext:",
      `            privileged: ${privileged}`,
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: api",
      "spec:",
      "  type: ClusterIP",
      "  ports: [{ port: 80 }]",
      ""
    ].join("\n");
    fs.mkdirSync(path.join(base, "k8s"));
    fs.mkdirSync(path.join(head, "k8s"));
    fs.writeFileSync(path.join(base, "k8s", "api.yaml"), doc(false));
    fs.writeFileSync(path.join(head, "k8s", "api.yaml"), doc(true));
    const r = spawnSync(process.execPath, [CLI, "check", base, head, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(JSON.parse(r.stdout).findings.some((f) => f.ruleId === "no-k8s-privileged-containers"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(head, { recursive: true, force: true });
  }
});

test("adding a Chart.yaml does not hide a plain manifest under templates/", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "helm-chart-trick-base-"));
  const head = fs.mkdtempSync(path.join(os.tmpdir(), "helm-chart-trick-head-"));
  try {
    fs.mkdirSync(path.join(head, "deploy", "templates"), { recursive: true });
    fs.writeFileSync(path.join(head, "deploy", "Chart.yaml"), ["apiVersion: v2", "name: x", "version: 0.1.0", ""].join("\n"));
    fs.writeFileSync(path.join(head, "deploy", "templates", "agent.yaml"), [
      "apiVersion: apps/v1",
      "kind: DaemonSet",
      "metadata:",
      "  name: agent",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: agent",
      "          image: busybox",
      "          securityContext:",
      "            privileged: true",
      ""
    ].join("\n"));
    const r = spawnSync(process.execPath, [CLI, "check", base, head, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(head, { recursive: true, force: true });
  }
});

test("an unchanged Helm template is not reported on every PR; a changed one is", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "helm-unchanged-base-"));
  const head = fs.mkdtempSync(path.join(os.tmpdir(), "helm-unchanged-head-"));
  try {
    const tpl = (replicas) => [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: {{ .Release.Name }}",
      "spec:",
      `  replicas: {{ .Values.replicas | default ${replicas} }}`,
      ""
    ].join("\n");
    for (const dir of [base, head]) {
      fs.mkdirSync(path.join(dir, "chart", "templates"), { recursive: true });
      fs.writeFileSync(path.join(dir, "chart", "Chart.yaml"), ["apiVersion: v2", "name: app", "version: 0.1.0", ""].join("\n"));
      fs.writeFileSync(path.join(dir, "chart", "templates", "deploy.yaml"), tpl(1));
    }
    fs.writeFileSync(path.join(base, "docker-compose.yml"), ["services:", "  api:", "    image: nginx:1.25", ""].join("\n"));
    fs.writeFileSync(path.join(head, "docker-compose.yml"), ["services:", "  api:", "    image: nginx:1.26", ""].join("\n"));

    const run = () => JSON.parse(spawnSync(process.execPath, [CLI, "check", base, head, "--json"], { encoding: "utf8" }).stdout);
    assert.ok(!run().findings.some((f) => f.ruleId === "file-not-checked" || f.ruleId === "changed-file-not-checked"), "unchanged template must not be reported");

    fs.writeFileSync(path.join(head, "chart", "templates", "deploy.yaml"), tpl(3));
    assert.ok(run().findings.some((f) => f.ruleId === "changed-file-not-checked"), "changed template must be reported as not checked");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(head, { recursive: true, force: true });
  }
});

// 35. Precision & Override Improvements (Sections 3b B5, B6, B7, B8, B10, B13)

// B13: Fast path compose file git mv with no content change -> exit 0 in --changed-from mode (no false findings)
test("compose file git mv with no content change exits 0 in --changed-from mode", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-compose-rename-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.mkdirSync(path.join(tmpRepo, "services"), { recursive: true });
    const content = "services:\n  web:\n    image: nginx:1.25\n    ports:\n      - '8080:8080'\n";
    fs.writeFileSync(path.join(tmpRepo, "services", "docker-compose.yml"), content);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Rename compose file to deploy/docker-compose.yml with git mv (identical content)
    fs.mkdirSync(path.join(tmpRepo, "deploy"), { recursive: true });
    spawnSync("git", ["mv", "services/docker-compose.yml", "deploy/docker-compose.yml"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "rename compose file"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for renamed compose file with identical content, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.verdict, "passed");
    assert.equal(parsed.findings.length, 0, "Renamed compose file with identical content must produce 0 findings");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// B5: Compose port binding precision: 127.0.0.1:9000:9000 new service -> no port binding finding
test("new service with 127.0.0.1:9000:9000 does not trigger no-all-interfaces-port-binding", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-port-loopback-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-port-loopback-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  existing:\n    image: alpine\n");
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  existing:\n    image: alpine\n  app:\n    image: node:20\n    ports:\n      - '127.0.0.1:9000:9000'\n      - 'localhost:9001:9001'\n      - '[::1]:9002:9002'\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for loopback ports, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const portFinding = parsed.findings.find(f => f.ruleId === "no-all-interfaces-port-binding");
    assert.equal(portFinding, undefined, "Loopback bindings must not trigger no-all-interfaces-port-binding");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B6: Port exposure on existing services: 127.0.0.1:8080:8080 -> 0.0.0.0:8080:8080 emits compose.port_exposed and exits 2
test("existing service port changed from 127.0.0.1:8080:8080 to 0.0.0.0:8080:8080 emits compose.port_exposed and exits 2", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-port-exposed-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-port-exposed-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: node:20\n    ports:\n      - '127.0.0.1:8080:8080'\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: node:20\n    ports:\n      - '0.0.0.0:8080:8080'\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for exposed port, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const finding = parsed.findings.find(f => f.ruleId === "no-all-interfaces-port-binding");
    assert.ok(finding, "Expected no-all-interfaces-port-binding finding");
    assert.equal(finding.level, "soft");
    assert.equal(finding.event.type, "compose.port_exposed");
    assert.equal(finding.event.entityId, "service:app");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B7: OpenAPI route security precision: new /health route with security: [] fires api-new-route-public (warn, exit 0)
test("new /health route with security: [] fires api-new-route-public (warn, exit 0)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-route-sec-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-route-sec-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "openapi.yaml"),
      `openapi: 3.0.0
info:
  title: API
  version: 1.0.0
security:
  - bearerAuth: []
paths:
  /users:
    get:
      responses:
        '200':
          description: ok
`
    );
    fs.writeFileSync(
      path.join(tmpHead, "openapi.yaml"),
      `openapi: 3.0.0
info:
  title: API
  version: 1.0.0
security:
  - bearerAuth: []
paths:
  /users:
    get:
      responses:
        '200':
          description: ok
  /health:
    get:
      security: []
      responses:
        '200':
          description: ok
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for warn rule api-new-route-public, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const routeFinding = parsed.findings.find(f => f.ruleId === "api-new-route-public" && f.event?.entityId?.toLowerCase()?.includes("/health"));
    assert.ok(routeFinding, "Expected api-new-route-public finding for /health with security: []");
    assert.equal(routeFinding.level, "warn");
    assert.equal(routeFinding.event.type, "api.route_public");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B8: Override permission check: write permission accepts override on rule with empty owners
test("override with empty owners by a write user (--override-permission write) is accepted (exit 0)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-perm-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-perm-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n    network_mode: host\n"
    );

    // Rule no-host-network has owners: []. Caller has 'write' permission -> accepted (exit 0)
    const r = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--override", "no-host-network",
        "--override-by", "dev-user",
        "--override-permission", "write",
        "--override-reason", "Emergency network triage",
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, `Expected exit 0 for write-permission override, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.summary.overridden, 1);
    assert.equal(parsed.summary.soft, 0);
    assert.equal(parsed.overrides[0].ruleId, "no-host-network");
    assert.equal(parsed.overrides[0].overriddenBy, "dev-user");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B8: Override permission check: read permission refuses override on rule with empty owners
test("override with empty owners by a read user (--override-permission read) is refused (exit 2)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-refused-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-refused-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n    network_mode: host\n"
    );

    // Rule no-host-network has owners: []. Caller only has 'read' permission -> refused (exit 2)
    const r = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--override", "no-host-network",
        "--override-by", "readonly-user",
        "--override-permission", "read",
        "--override-reason", "Unauthorized attempt",
        "--json"
      ],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2 for refused override on soft rule, got ${r.status}`);
    assert.ok(r.stderr.includes('refused: "readonly-user" is not an owner'));
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    assert.equal(parsed.summary.overridden, 0);
    assert.equal(parsed.summary.soft, 1);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B10: SQL migration edits: applied migration deleted -> exit 1 (sql-no-migration-edited with 'deleted')
test("applied migration deleted exits 1 with sql-no-migration-edited ('deleted')", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-del-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-del-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

    fs.writeFileSync(path.join(tmpBase, "migrations", "001_init.sql"), "CREATE TABLE users (id INT PRIMARY KEY);\n");
    fs.writeFileSync(path.join(tmpBase, "migrations", "002_posts.sql"), "CREATE TABLE posts (id INT PRIMARY KEY, user_id INT);\n");

    // Head deleted 002_posts.sql
    fs.writeFileSync(path.join(tmpHead, "migrations", "001_init.sql"), "CREATE TABLE users (id INT PRIMARY KEY);\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 for deleted migration, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    const migFinding = parsed.findings.find(f => f.ruleId === "sql-no-migration-edited");
    assert.ok(migFinding, "Expected sql-no-migration-edited finding for deleted migration");
    assert.equal(migFinding.level, "hard");
    assert.ok(migFinding.message.includes("deleted"), `Expected 'deleted' in finding message: ${migFinding.message}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B10: SQL migration edits: applied migration renamed in two-dir mode -> exit 1 (sql-no-migration-edited with 'renamed from')
test("applied migration renamed exits 1 with sql-no-migration-edited ('renamed from')", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-ren-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-ren-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

    const sqlContent = "CREATE TABLE users (id INT PRIMARY KEY);\n";
    fs.writeFileSync(path.join(tmpBase, "migrations", "001_init.sql"), sqlContent);

    // Head renamed 001_init.sql to 001_init_users.sql (same content)
    fs.writeFileSync(path.join(tmpHead, "migrations", "001_init_users.sql"), sqlContent);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 for renamed migration, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    const migFinding = parsed.findings.find(f => f.ruleId === "sql-no-migration-edited");
    assert.ok(migFinding, "Expected sql-no-migration-edited finding for renamed migration");
    assert.equal(migFinding.level, "hard");
    assert.ok(migFinding.message.includes("renamed from"), `Expected 'renamed from' in finding message: ${migFinding.message}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// B10: SQL migration edits: applied migration renamed via git mv in --changed-from mode -> exit 1
test("applied migration renamed via git mv exits 1 in --changed-from mode", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-git-ren-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    const sqlContent = "CREATE TABLE users (id INT PRIMARY KEY);\n";
    fs.writeFileSync(path.join(tmpRepo, "migrations", "001_init.sql"), sqlContent);

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base migration"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    spawnSync("git", ["mv", "migrations/001_init.sql", "migrations/001_init_users.sql"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "rename migration"], { cwd: tmpRepo });

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 for renamed migration in git repo, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    const migFinding = parsed.findings.find(f => f.ruleId === "sql-no-migration-edited");
    assert.ok(migFinding, "Expected sql-no-migration-edited finding for renamed migration in --changed-from");
    assert.equal(migFinding.level, "hard");
    assert.ok(migFinding.message.includes("renamed from"), `Expected 'renamed from' in finding message: ${migFinding.message}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// B10: SQL migration edits: applied migration CRLF-only conversion -> exit 0
test("applied migration with only CRLF line ending conversion exits 0", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-crlf-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-crlf-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

    fs.writeFileSync(path.join(tmpBase, "migrations", "001_init.sql"), "CREATE TABLE users (\n  id INT PRIMARY KEY\n);\n");
    // Head has CRLF line endings
    fs.writeFileSync(path.join(tmpHead, "migrations", "001_init.sql"), "CREATE TABLE users (\r\n  id INT PRIMARY KEY\r\n);\r\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for CRLF line ending conversion, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const migFinding = parsed.findings.find(f => f.ruleId === "sql-no-migration-edited");
    assert.equal(migFinding, undefined, "CRLF line ending conversion must not trigger sql-no-migration-edited");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});


test("override with empty owners by the PR author is refused even with write permission (a PR cannot approve itself)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-self-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-self-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    network_mode: host\n");
    const run = (author) => spawnSync(process.execPath, [
      CLI, "check", tmpBase, tmpHead,
      "--override", "no-host-network",
      "--override-by", "dev-user",
      "--override-permission", "write",
      "--override-reason", "Emergency network triage",
      "--pr-author", author,
      "--json"
    ], { encoding: "utf8" });
    assert.equal(run("Dev-User").status, 2, "the PR author cannot override an owner-less rule on their own PR");
    assert.equal(run("someone-else").status, 0, "another writer can");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("owner who is the PR author cannot override even when explicitly listed in rule owners", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-owner-author-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-override-owner-author-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, ".archtour"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: custom-soft-owner\n    on: service.host_network_enabled\n    level: soft\n    owners: ["alice", "bob"]\n`
    );
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: custom-soft-owner\n    on: service.host_network_enabled\n    level: soft\n    owners: ["alice", "bob"]\n`
    );
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    network_mode: host\n");

    const run = (by, author) => spawnSync(process.execPath, [
      CLI, "check", tmpBase, tmpHead,
      "--override", "custom-soft-owner",
      "--override-by", by,
      "--override-reason", "Approved for staging test",
      "--pr-author", author,
      "--json"
    ], { encoding: "utf8" });

    // Alice is in owners: ["alice", "bob"], but is the PR author -> cannot override
    const rAlice = run("alice", "alice");
    assert.equal(rAlice.status, 2, "PR author alice cannot override her own PR even when listed as owner");
    const pAlice = JSON.parse(rAlice.stdout);
    assert.equal(pAlice.exitCode, 2);

    // Bob is another owner and not the author -> can override
    const rBob = run("bob", "alice");
    assert.equal(rBob.status, 0, "another owner bob can override");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("policy diff: changing owners produces policy-changed finding with base owners (exit 2)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-owners-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-owners-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, ".archtour"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: guarded-rule\n    on: service.image_changed\n    level: soft\n    owners: ["@acme/platform"]\n`
    );
    // Head changes owners to alice
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: guarded-rule\n    on: service.image_changed\n    level: soft\n    owners: ["alice"]\n`
    );
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for owners change, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const polFinding = parsed.findings.find(f => f.ruleId === "policy-changed");
    assert.ok(polFinding, "policy-changed finding must be present");
    assert.ok(polFinding.message.includes("guarded-rule") && polFinding.message.includes("owners"));
    assert.deepEqual(polFinding.owners, ["@acme/platform"], "Owners must be base owners");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("policy diff: adding where matcher produces policy-changed finding (exit 2)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-where-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-where-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, ".archtour"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: sample-rule\n    on: service.image_changed\n    level: soft\n    owners: ["@security"]\n`
    );
    // Head adds where: { name: "zzz-*" }
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: sample-rule\n    on: service.image_changed\n    level: soft\n    where: { name: "zzz-*" }\n    owners: ["@security"]\n`
    );
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for adding where, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const polFinding = parsed.findings.find(f => f.ruleId === "policy-changed");
    assert.ok(polFinding, "policy-changed finding must be present");
    assert.ok(polFinding.message.includes("sample-rule") && polFinding.message.includes("where"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("policy diff: enforce_from 2099 produces policy-changed finding (exit 2)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-enforce-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-enforce-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, ".archtour"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: delayed-rule\n    on: service.image_changed\n    level: soft\n`
    );
    // Head adds enforce_from: "2099-01-01"
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: delayed-rule\n    on: service.image_changed\n    level: soft\n    enforce_from: "2099-01-01"\n`
    );
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for enforce_from 2099, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const polFinding = parsed.findings.find(f => f.ruleId === "policy-changed");
    assert.ok(polFinding, "policy-changed finding must be present");
    assert.ok(polFinding.message.includes("delayed-rule") && polFinding.message.includes("enforce_from"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("policy diff: level raised only (pure tightening) produces no policy-changed finding (exit 0)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-tighten-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-pol-tighten-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, ".archtour"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: tightened-rule\n    on: service.image_changed\n    level: warn\n`
    );
    // Head raises level from warn to soft with no other changes
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "rules.yml"),
      `version: 1\nrules:\n  - id: tightened-rule\n    on: service.image_changed\n    level: soft\n`
    );
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  app:\n    image: nginx:1.0\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for pure level tightening, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.findings.filter(f => f.ruleId === "policy-changed").length, 0);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("new candidate file skipped for size gives soft file-not-checked for SQL and non-SQL candidate files, while Helm stays advisory inside a chart", () => {
  const skippedSqlFile = {
    file: "migrations/0002_big_seed.sql",
    reason: "File size exceeds 5 MB limit (6.5 MB)"
  };
  const headFacts = {
    entities: [],
    skipped: [skippedSqlFile],
    errors: []
  };
  const baseFacts = {
    entities: [],
    sources: []
  };
  const rules = [
    { id: "file-not-checked", level: "advisory" }
  ];

  const evalRes = evaluateRules(rules, { events: [] }, baseFacts, headFacts);
  const finding = evalRes.findings.find(f => f.ruleId === "changed-file-not-checked");
  assert.ok(finding, "changed-file-not-checked finding must be emitted");
  assert.equal(finding.level, "soft", "new SQL migration skipped for size must be soft, not advisory");

  // Non-SQL candidate file skipped for size is also soft
  const skippedCompose = {
    file: "docker-compose.yml",
    reason: "File size exceeds 5 MB limit (6.5 MB)"
  };
  const evalRes2 = evaluateRules(rules, { events: [] }, baseFacts, { entities: [], skipped: [skippedCompose] });
  const finding2 = evalRes2.findings.find(f => f.ruleId === "changed-file-not-checked");
  assert.equal(finding2.level, "soft", "new non-SQL candidate file skipped for size is soft");

  // A NEW file skipped as a Helm template is soft even inside a real chart (0.2.9: changed unreadable files block by default)
  const skippedHelm = {
    file: "charts/mychart/templates/deployment.yaml",
    reason: "Helm template: render with `helm template` and scan the output",
    helmChart: true
  };
  const evalRes3 = evaluateRules(rules, { events: [] }, baseFacts, { entities: [], skipped: [skippedHelm] });
  const finding3 = evalRes3.findings.find(f => f.ruleId === "changed-file-not-checked");
  assert.equal(finding3.level, "soft", "a new Helm template inside a real chart is soft by default");

  // A NEW file skipped as Helm outside any chart must be soft, not advisory
  const skippedHelmOutside = {
    file: "deploy/pod.yaml",
    reason: "Helm template: render with `helm template` and scan the output"
  };
  const evalRes4 = evaluateRules(rules, { events: [] }, baseFacts, { entities: [], skipped: [skippedHelmOutside] });
  const finding4 = evalRes4.findings.find(f => f.ruleId === "changed-file-not-checked");
  assert.equal(finding4.level, "soft", "Helm-skipped new file outside a chart must be soft");
});

test("new 6 MB compose with privileged -> exit 2 (soft file-not-checked)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "big-compose-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "big-compose-head-"));
  try {
    const padding = "# comment line padding\n".repeat(280000); // > 5 MB
    const bigCompose = `services:\n  app:\n    image: nginx\n    privileged: true\n${padding}`;
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), bigCompose);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for new 6 MB compose with privileged, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    const f = parsed.findings.find(x => x.ruleId === "changed-file-not-checked");
    assert.ok(f, "Expected changed-file-not-checked finding");
    assert.equal(f.level, "soft");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("repo rules.yml adding where to no-privileged-containers (adjustable: false) -> exit 3", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adj-where-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "adj-where-head-"));
  try {
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "rules.yml"),
      `version: 1
extends: [archtour:recommended]
rules:
  - id: no-privileged-containers
    level: hard
    where: { name: "!*-dev" }
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(r.status, 3, `Expected exit 3 when adding where to non-adjustable rule, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes("no-privileged-containers"));
    assert.ok(r.stderr.includes("where"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("exception rule: '*' -> exit 3", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exc-star-rule-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "exc-star-rule-head-"));
  try {
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "exceptions.yml"),
      `- rule: "*"
  target: "service:app"
  reason: "Wildcard rule exception"
  owner: "@dev"
  expires: "2027-01-01"
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--now", "2026-11-14"], { encoding: "utf8" });
    assert.equal(r.status, 3, `Expected exit 3 for exception with rule: "*", got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes('cannot be "*"') || r.stderr.includes("*"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("hard-rule exception with target: '*' -> exit 3", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exc-star-target-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "exc-star-target-head-"));
  try {
    fs.mkdirSync(path.join(tmpHead, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHead, ".archtour", "exceptions.yml"),
      `- rule: no-privileged-containers
  target: "*"
  reason: "Blanket exception for hard rule"
  owner: "@dev"
  expires: "2027-01-01"
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--now", "2026-11-14"], { encoding: "utf8" });
    assert.equal(r.status, 3, `Expected exit 3 for hard rule exception with target: "*", got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes("hard rule") || r.stderr.includes("no-privileged-containers"));
    assert.ok(r.stderr.includes("*"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("Flyway migrations cannot hide a drop behind a .down.sql name or a migrate:down comment", () => {
  const cases = [
    ["V2__drop.down.sql", "ALTER TABLE users DROP COLUMN plan;\n"],
    ["V2__x.sql", "-- migrate:down\nALTER TABLE users DROP COLUMN plan;\n"]
  ];
  for (const [name, sql] of cases) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-trick-base-"));
    const head = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-trick-head-"));
    try {
      for (const dir of [base, head]) {
        fs.mkdirSync(path.join(dir, "db", "migration"), { recursive: true });
        fs.writeFileSync(path.join(dir, "db", "migration", "V1__init.sql"), "CREATE TABLE users (id int, plan text);\n");
      }
      fs.writeFileSync(path.join(head, "db", "migration", name), sql);
      const r = spawnSync(process.execPath, [CLI, "check", base, head, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 2, `${name}: ${r.stderr}`);
      assert.ok(JSON.parse(r.stdout).findings.some((f) => f.ruleId === "sql-no-drop-column"), name);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(head, { recursive: true, force: true });
    }
  }
});

// 45. Code-span escaping: paths, entity ids, and rule ids with _ or * render without backslashes
test("code-span path, entity id, and rule id with _ render without backslash in markdown report", () => {
  const findings = [
    {
      ruleId: "sql_no_drop_column",
      level: "soft",
      message: "Column dropped",
      event: { entityId: "db.column:users_table.email_address", kind: "db.column" },
      source: { file: "migrations/0002_drop_email.sql", line: 1 },
      owners: ["@team_data"]
    }
  ];

  const report = formatMarkdownReport(findings, { headSha: "1234567890abcdef" });
  assert.ok(report.includes("`migrations/0002_drop_email.sql:1`"), "File path should be in code span without backslashes");
  assert.ok(!report.includes("0002\\_drop\\_email.sql"), "Should not contain backslash-escaped underscores in path");
  assert.ok(report.includes("`db.column:users_table.email_address`"), "Entity ID should be in code span without backslashes");
  assert.ok(!report.includes("users\\_table"), "Should not contain backslash-escaped underscores in entity id");
  assert.ok(report.includes("`sql_no_drop_column`"), "Rule ID should be in code span without backslashes");
  assert.ok(!report.includes("sql\\_no\\_drop"), "Should not contain backslash-escaped underscores in rule id");
  assert.ok(report.includes("/archtour override sql_no_drop_column 1234567890abcdef <reason>"), "Override snippet should include full head SHA");
});

// 46. .graphqls file checked
test(".graphqls file extension is checked for breaking changes", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-graphqls-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-graphqls-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "schema.graphqls"),
      "type Query {\n  users: [User!]!\n}\ntype User {\n  id: ID!\n  email: String!\n}\n"
    );
    // Head drops email field
    fs.writeFileSync(
      path.join(tmpHead, "schema.graphqls"),
      "type Query {\n  users: [User!]!\n}\ntype User {\n  id: ID!\n}\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for breaking change in .graphqls, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    assert.ok(parsed.findings.some(f => f.ruleId === "gql-breaking"), "Expected gql-breaking finding for removed field in .graphqls");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 47. No candidate files changed -> title "No architecture files changed", exit 0
test("no candidate files changed outputs 'No architecture files changed' and exits 0", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-no-candidates-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-no-candidates-head-"));
  try {
    fs.writeFileSync(path.join(tmpBase, "README.md"), "# Hello\n");
    fs.writeFileSync(path.join(tmpHead, "README.md"), "# Hello World\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for no candidate files, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes("No architecture files changed"), "Output should contain 'No architecture files changed'");
    assert.ok(!r.stdout.includes("## ✅ Architecture Guardrails: Passed"), "Should not say 'Passed' when zero candidate files changed");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 48. Exit-2 title text is "Blocked (soft)"
test("exit 2 title text is 'Blocked (soft)'", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-exit2-title-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-exit2-title-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx\n    network_mode: host\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for soft finding, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes("## ⚠️ Architecture Guardrails: Blocked (soft)"), "Title should be 'Blocked (soft)'");
    assert.ok(!r.stdout.includes("Soft Warning"), "Title must not say 'Soft Warning'");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 49. check --help exits 0 and prints usage with required flags
test("check --help, check -h, and check help exit 0 and list all required flags", () => {
  const flags = [
    "--changed-from",
    "--state",
    "--json",
    "--md",
    "--rules",
    "--include-untracked",
    "--cache-dir",
    "--override",
    "--pr-author",
    "--policy-from"
  ];

  for (const arg of ["--help", "-h", "help"]) {
    const r = spawnSync(process.execPath, [CLI, "check", arg], { encoding: "utf8" });
    assert.equal(r.status, 0, `archtour check ${arg} should exit 0, got status ${r.status}: ${r.stderr}`);
    for (const flag of flags) {
      assert.ok(r.stdout.includes(flag), `archtour check ${arg} output should list flag ${flag}`);
    }
  }

  // Also test archtour help check
  const rHelpCheck = spawnSync(process.execPath, [CLI, "help", "check"], { encoding: "utf8" });
  assert.equal(rHelpCheck.status, 0, `archtour help check should exit 0, got status ${rHelpCheck.status}: ${rHelpCheck.stderr}`);
  for (const flag of flags) {
    assert.ok(rHelpCheck.stdout.includes(flag), `archtour help check output should list flag ${flag}`);
  }
});

// 50. Two-dir check with 600 files passes with default 20000, and fails closed with scan-truncated on --max-files 100
test("two-dir check with 600 files passes with default 20000, and fails closed with scan-truncated on --max-files 100", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-600-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-600-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "migrations"), { recursive: true });

    for (let i = 1; i <= 600; i++) {
      const content = `CREATE TABLE t_${i} (id INT PRIMARY KEY);\n`;
      fs.writeFileSync(path.join(tmpBase, "db", "migrations", `V${i}__t.sql`), content);
      fs.writeFileSync(path.join(tmpHead, "db", "migrations", `V${i}__t.sql`), content);
    }

    // 1. Passes under default 20,000 cap
    const rDefault = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(rDefault.status, 0, `Expected exit 0 under default 20k cap: ${rDefault.stderr}`);
    const parsedDefault = JSON.parse(rDefault.stdout);
    assert.equal(parsedDefault.exitCode, 0);
    assert.equal(parsedDefault.findings.length, 0);

    // 2. Fails closed with scan-truncated on --max-files 100
    const rTrunc = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--max-files", "100", "--json"], { encoding: "utf8" });
    assert.equal(rTrunc.status, 1, `Expected exit 1 when scan truncated: ${rTrunc.stderr}`);
    assert.ok(rTrunc.stderr.includes("candidate files were not checked; raise --max-files"));
    const parsedTrunc = JSON.parse(rTrunc.stdout);
    assert.equal(parsedTrunc.exitCode, 1);
    const truncFinding = parsedTrunc.findings.find(f => f.ruleId === "scan-truncated");
    assert.ok(truncFinding, "scan-truncated finding must be present");
    assert.equal(truncFinding.level, "hard");
    assert.ok(truncFinding.message.includes("candidate files were not checked; raise --max-files"));

    // Verify report does not say "Passed"
    const rTruncMd = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--max-files", "100"], { encoding: "utf8" });
    assert.ok(!rTruncMd.stdout.includes("## ✅ Architecture Guardrails: Passed"), "Truncated scan must never report 'Passed'");
    assert.ok(rTruncMd.stdout.includes("⛔ Architecture Guardrails: Failed") || rTruncMd.stdout.includes("Blocked (hard)") || rTruncMd.stdout.includes("Architecture Guardrails: Failed"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 51. baseline over the candidate cap exits 3 and prevents recording partial scan
test("baseline over the candidate cap exits 3 and prevents recording partial scan", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-cap-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "db", "migrations"), { recursive: true });
    for (let i = 1; i <= 25; i++) {
      fs.writeFileSync(path.join(tmpDir, "db", "migrations", `V${i}__t.sql`), `CREATE TABLE t_${i} (id INT);\n`);
    }

    const r = spawnSync(process.execPath, [CLI, "baseline", tmpDir, "--max-files", "10"], { encoding: "utf8" });
    assert.equal(r.status, 3, `Expected exit 3 when baseline hits cap, got ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stderr.includes("15 candidate files were not checked; raise --max-files"),
      `Stderr should report unexamined files count: ${r.stderr}`
    );
    assert.equal(fs.existsSync(path.join(tmpDir, ".archtour", "baseline.json")), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 52. --help and -h on all subcommands exit 0 and write no files in cwd
test("--help and -h on all subcommands exit 0 and write no files in cwd", () => {
  const subcommands = ["baseline", "init", "check", "facts", "changes", "audit-history", "selftest", "doctor"];
  for (const cmd of subcommands) {
    for (const flag of ["--help", "-h"]) {
      const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), `help-nowrite-${cmd}-`));
      try {
        const r = spawnSync(process.execPath, [CLI, cmd, flag], { cwd: emptyCwd, encoding: "utf8" });
        assert.equal(r.status, 0, `${cmd} ${flag} should exit 0, got ${r.status}: ${r.stderr}`);
        const filesCreated = fs.readdirSync(emptyCwd);
        assert.equal(
          filesCreated.length,
          0,
          `${cmd} ${flag} must not create files in cwd, but found: ${filesCreated.join(", ")}`
        );
      } finally {
        fs.rmSync(emptyCwd, { recursive: true, force: true });
      }
    }
  }
});

// 53. PR comment size is capped under 60000 chars and caps rule findings at 20 with ... and N more line
test("PR comment size is capped under 60000 chars and caps rule findings at 20 with ... and N more line", () => {
  const findings = [];
  for (let i = 1; i <= 50; i++) {
    findings.push({
      ruleId: "sql-no-drop-column",
      level: "soft",
      entityId: `db.column:users.col_${i}`,
      message: `Column 'users.col_${i}' was dropped with detailed warning explanation and context text for item ${i}`,
      source: { file: `db/migrations/V${i}__drop.sql`, line: 10 }
    });
  }

  const md = formatMarkdownReport(findings, { sources: [], rules: RECOMMENDED_RULES });
  assert.ok(md.length < 60000, `Report length ${md.length} should be under 60,000 characters`);
  assert.ok(
    md.includes("- ... and 30 more `sql-no-drop-column` findings (see the job log)"),
    `Report should contain ellipsis notice with remaining count: ${md}`
  );
  // Verify 20 detailed bullet lines are present
  // One finding = one "Entity:" line (the report's own format)
  const bulletMatches = md.match(/  - Entity: `db\.column:users\.col_\d+`/g) || [];
  assert.equal(bulletMatches.length, 20, `Expected 20 displayed findings, got ${bulletMatches.length}`);
});

// 54. batchCatFile on 300 migration files produces identical results to sequential git show
test("batchCatFile on 300 migration files produces identical results to sequential git show", async (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "batch-cat-test-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    const migrationsDir = path.join(tmpRepo, "db", "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });

    const relPaths = [];
    for (let i = 1; i <= 300; i++) {
      const relPath = `db/migrations/V${String(i).padStart(4, "0")}__test.sql`;
      const content = `-- Migration ${i}\nCREATE TABLE tbl_${i} (\n  id SERIAL PRIMARY KEY,\n  val_${i} VARCHAR(255) DEFAULT 'val_${i}'\n);\n`;
      fs.writeFileSync(path.join(tmpRepo, relPath), content);
      relPaths.push(relPath);
    }

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "add 300 migrations"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    const queries = relPaths.map(p => `${baseCommit}:${p}`);

    // 1. Batched read via git cat-file --batch
    const batchedMap = await batchCatFile(tmpRepo, queries);
    assert.equal(batchedMap.size, 300, `Expected 300 files in batched map, got ${batchedMap.size}`);

    // 2. Sequential read via git show
    for (const q of queries) {
      const seqRes = spawnSync("git", ["show", q], {
        cwd: tmpRepo,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });
      assert.equal(seqRes.status, 0, `git show ${q} failed: ${seqRes.stderr}`);
      const batchResult = batchedMap.get(q);
      assert.ok(batchResult, `Query ${q} should exist in batch results`);
      assert.equal(
        batchResult.content,
        seqRes.stdout,
        `Content mismatch for ${q} between batchCatFile and git show`
      );
    }
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// 55. batchCatFile with newline in path uses per-file fallback and still reads correctly
test("batchCatFile with newline in path uses per-file fallback", async () => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  // Creating files with literal newlines in their names is not reliable on Windows CI.
  if (os.platform() === "win32") {
    return;
  }

  // Create a repo with a file whose name contains a newline
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "batch-newline-test-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    const migrationsDir = path.join(tmpRepo, "db", "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });

    // Create a file with newline in its name (works on POSIX filesystems)
    const newlinePath = path.join(migrationsDir, "V0001__test\nwithnewline.sql");
    fs.writeFileSync(newlinePath, "CREATE TABLE t (id INT PRIMARY KEY);\n");

    // Also create a normal file
    fs.writeFileSync(path.join(migrationsDir, "V0002__normal.sql"), "CREATE TABLE t2 (id INT);\n");

    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "add migrations"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    const newlineRelPath = "db/migrations/V0001__test\nwithnewline.sql";
    const normalRelPath = "db/migrations/V0002__normal.sql";
    const queries = [
      `${baseCommit}:${newlineRelPath}`,
      `${baseCommit}:${normalRelPath}`
    ];

    // batchCatFile should handle the newline path via fallback
    const batchedMap = await batchCatFile(tmpRepo, queries);
    assert.equal(batchedMap.size, 2, `Expected 2 files in batched map, got ${batchedMap.size}`);

    const newlineResult = batchedMap.get(queries[0]);
    assert.ok(newlineResult, "Newline path should be readable via fallback");
    assert.ok(newlineResult.content.includes("CREATE TABLE t"), "Content should match");

    const normalResult = batchedMap.get(queries[1]);
    assert.ok(normalResult, "Normal path should be readable via batch");
    assert.ok(normalResult.content.includes("CREATE TABLE t2"), "Content should match");
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// 56. .graphqls files are detected in changed-from mode
test("graphql .graphqls files are detected in changed-from mode", async () => {
  // Test that isGraphQLFile accepts *.graphqls
  const { isGraphQLFile } = await import("../tools/facts-graphql.mjs");
  assert.equal(isGraphQLFile("graph/users.graphqls"), true, ".graphqls should be detected");
  assert.equal(isGraphQLFile("graph/schema.graphqls"), true, "schema.graphqls should be detected");
  assert.equal(isGraphQLFile("graph/type.graphql"), true, ".graphql should be detected");
  assert.equal(isGraphQLFile("graph/type.gql"), true, ".gql should be detected");
  assert.equal(isGraphQLFile("graph/readme.txt"), false, "Non-graphql files should not be detected");
});

// 57. Full findings are printed to stdout when markdown is capped (50 findings, 20 per rule cap)
test("full findings printed to stdout when markdown capped with 50 findings", () => {
  const findings = [];
  for (let i = 1; i <= 50; i++) {
    findings.push({
      ruleId: "sql-no-drop-column",
      level: "soft",
      entityId: `db.column:users.col_${i}`,
      message: `Column 'users.col_${i}' was dropped`,
      source: { file: `db/migrations/V${i}__drop.sql`, line: 10 }
    });
  }

  const md = formatMarkdownReport(findings, { sources: [], rules: RECOMMENDED_RULES });
  assert.ok(md.length < 60000, `Report length ${md.length} should be under 60,000 characters`);
  assert.ok(
    md.includes("- ... and 30 more `sql-no-drop-column` findings (see the job log)"),
    `Report should contain ellipsis notice: ${md}`
  );
  // Verify 20 detailed bullet lines are present
  const bulletMatches = md.match(/  - Entity: `db\.column:users\.col_\d+`/g) || [];
  assert.equal(bulletMatches.length, 20, `Expected 20 displayed findings, got ${bulletMatches.length}`);

  // Verify full findings are printed as job log lines
  const logLines = formatJobLogLines(findings);
  assert.equal(logLines.length, 50, `Expected 50 log lines, got ${logLines.length}`);
  assert.ok(logLines[0].startsWith("soft sql-no-drop-column"), "Log line should start with level and ruleId");
});

// 58. Hard findings are never capped in the comment
test("hard findings are never capped in the comment", () => {
  const findings = [];
  for (let i = 1; i <= 25; i++) {
    findings.push({
      ruleId: "no-privileged-containers",
      level: "hard",
      entityId: `service.privileged_container_${i}`,
      message: `Privileged container detected in service ${i}`,
      source: { file: `compose${i}.yaml`, line: 5 }
    });
  }

  const md = formatMarkdownReport(findings, { sources: [], rules: RECOMMENDED_RULES });
  // All 25 hard findings should be listed (no capping for hard findings)
  const bulletMatches = md.match(/  - Entity: `service\.privileged_container_\d+`/g) || [];
  assert.equal(bulletMatches.length, 25, `Expected all 25 hard findings displayed, got ${bulletMatches.length}`);
  assert.ok(!md.includes("... and more"), "Hard findings should not be capped");
});

// 59. formatJobLogLines includes all findings, including those beyond the 20-per-rule cap
test("formatJobLogLines includes all findings", () => {
  const findings = [];
  for (let i = 1; i <= 30; i++) {
    findings.push({
      ruleId: "sql-no-drop-column",
      level: "soft",
      entityId: `db.column:users.col_${i}`,
      message: `Column dropped`,
      source: { file: `db/migrations/V${i}__drop.sql`, line: 10 }
    });
  }
  // Add a hard finding too
  findings.push({
    ruleId: "no-privileged-containers",
    level: "hard",
    entityId: `service.privileged`,
    message: `Privileged container`,
    source: { file: `compose.yaml`, line: 5 }
  });

  const logLines = formatJobLogLines(findings);
  assert.equal(logLines.length, 31, `Expected 31 log lines (30 soft + 1 hard), got ${logLines.length}`);
  // Verify format: <level> <ruleId> <entity> <file:line> <message>
  assert.ok(
    logLines[0].match(/^soft sql-no-drop-column db\.column:/),
    `Log line format incorrect: ${logLines[0]}`
  );
});

// 60. scan-truncated is now hard level
test("scan-truncated finding has hard level", async () => {
  const mod = await import("../tools/rules-recommended.mjs");
  const rules = mod.RECOMMENDED_RULES;
  const scanTruncatedRule = rules.find(r => r.id === "scan-truncated");
  assert.ok(scanTruncatedRule, "scan-truncated rule should exist");
  assert.equal(scanTruncatedRule.level, "hard", "scan-truncated should be hard level");
  assert.equal(scanTruncatedRule.adjustable, false, "scan-truncated should not be adjustable");
});

// 61. getRulesForOverride finds rules in paths: slice policies
test("getRulesForOverride finds rules in paths slice", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "override-paths-test-"));
  try {
    // Create root .archtour with no rules
    fs.mkdirSync(path.join(tmpDir, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".archtour", "rules.yml"),
      "version: 1\nrules: []\n"
    );

    // Create a paths slice with rules
    const sliceDir = path.join(tmpDir, "services", "api");
    fs.mkdirSync(path.join(sliceDir, ".archtour"), { recursive: true });
    fs.writeFileSync(
      path.join(sliceDir, ".archtour", "rules.yml"),
      "version: 1\nrules:\n  - id: api-breaking\n    on: api.route_public\n    level: hard\n    owners: [\"@acme/api-team\"]\n"
    );

    // Change to tmpDir so the relative path resolution works
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const mod = await import("../tools/override.mjs");
      const rules = mod.getRulesForOverride(null, null, "services/api");
      assert.ok(rules, "Should find rules from paths slice");
      assert.ok(Array.isArray(rules) && rules.length > 0, "Should return non-empty rules array");
      const apiRule = rules.find(r => r.id === "api-breaking");
      assert.ok(apiRule, "Should find api-breaking rule from slice");
      assert.equal(apiRule.owners.join(","), "@acme/api-team", "Should have correct owners");
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// T-093b follow-up: fail-closed batch reads, job-log output, .graphqls end to end, scan-truncated override.
// ---------------------------------------------------------------------------------------------------------------

const LEVEL_LINE = /^(?:hard|soft|warn|advisory) [a-z0-9-]+ /;

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

// 62. cat-file batch output parsing fails closed instead of trusting a short stream
// (the pre-T-093b code filled the gap with "missing", which turned an edited migration into a new one)
test("parseCatFileBatchOutput fails closed on a short, malformed or extra-answer stream", () => {
  const ok = parseCatFileBatchOutput(
    ["r:a", "r:b"],
    Buffer.from("aaaa blob 3\nabc\nbbbb blob 2\nde\n")
  );
  assert.equal(ok.size, 2);
  assert.equal(ok.get("r:a").content, "abc");
  assert.equal(ok.get("r:b").content, "de");

  // A "missing" answer is a real answer: one entry per query, value null.
  const missing = parseCatFileBatchOutput(["r:a", "r:b"], Buffer.from("aaaa blob 3\nabc\nbbbb missing\n"));
  assert.equal(missing.get("r:a").content, "abc");
  assert.equal(missing.get("r:b"), null);

  assert.throws(
    () => parseCatFileBatchOutput(["r:a", "r:b"], Buffer.from("aaaa blob 3\nabc\n")),
    /returned 1 objects for 2 requested/,
    "A short stream must throw, not fake a missing object"
  );
  assert.throws(
    () => parseCatFileBatchOutput(["r:a"], Buffer.from("aaaa blob 3\nabc\nbbbb blob 2\nde\n")),
    /more answers than requested/,
    "Extra answers mean a query was split, so every later answer may belong to another file"
  );
  assert.throws(
    () => parseCatFileBatchOutput(["r:a"], Buffer.from("aaaa blob 30\nabc\n")),
    /malformed answer/,
    "A size past the end of the stream must throw"
  );
});

// 63. Newline path read through git plumbing (portable: no file with a newline is ever created on disk)
test("batchCatFile reads a committed path containing a newline (git plumbing)", async (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "batch-newline-plumb-"));
  try {
    gitInitRepo(tmpRepo);

    const newlineRel = "db/migrations/V0001__test\nwithnewline.sql";
    const normalRel = "db/migrations/V0002__normal.sql";
    const blob = (content) => {
      const r = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: tmpRepo, input: content, encoding: "utf8" });
      assert.equal(r.status, 0, `git hash-object failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const newlineSha = blob("CREATE TABLE t1 (id INT PRIMARY KEY);\n");
    const normalSha = blob("CREATE TABLE t2 (id INT);\n");

    // core.protectNTFS refuses control characters in a path on Windows. The path never touches the filesystem here
    // (it is written straight into the object database), so the protection is disabled for these plumbing commands.
    for (const [sha, rel] of [[newlineSha, newlineRel], [normalSha, normalRel]]) {
      const r = spawnSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${sha},${rel}`], {
        cwd: tmpRepo,
        encoding: "utf8"
      });
      assert.equal(r.status, 0, `git update-index failed for ${JSON.stringify(rel)}: ${r.stderr}`);
    }

    const treeRes = spawnSync("git", ["-c", "core.protectNTFS=false", "write-tree"], { cwd: tmpRepo, encoding: "utf8" });
    assert.equal(treeRes.status, 0, `git write-tree failed: ${treeRes.stderr}`);
    const tree = treeRes.stdout.trim();

    const commitRes = spawnSync("git", ["commit-tree", tree, "-m", "base"], { cwd: tmpRepo, encoding: "utf8" });
    assert.equal(commitRes.status, 0, `git commit-tree failed: ${commitRes.stderr}`);
    const commit = commitRes.stdout.trim();
    assert.match(commit, /^[0-9a-f]{40}$/, "commit-tree must return a commit sha");

    const refRes = spawnSync("git", ["update-ref", "refs/heads/main", commit], { cwd: tmpRepo, encoding: "utf8" });
    assert.equal(refRes.status, 0, `git update-ref failed: ${refRes.stderr}`);

    const queries = [`${commit}:${newlineRel}`, `${commit}:${normalRel}`];
    const results = await batchCatFile(tmpRepo, queries);
    assert.equal(results.size, 2, `Expected 2 answers, got ${results.size}`);

    assert.ok(results.get(queries[0]), "The newline path must be readable");
    assert.ok(
      results.get(queries[0]).content.includes("CREATE TABLE t1"),
      `Newline path content wrong: ${JSON.stringify(results.get(queries[0]).content)}`
    );
    assert.ok(results.get(queries[1]), "The normal path must be readable");
    assert.ok(
      results.get(queries[1]).content.includes("CREATE TABLE t2"),
      `Normal path content wrong: ${JSON.stringify(results.get(queries[1]).content)}`
    );
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// 64. Repeated queries are de-duplicated so the answer count still matches the request count
test("batchCatFile de-duplicates repeated queries", async (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "batch-dedupe-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "db", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "db", "migrations", "V1__a.sql"), "CREATE TABLE a (id INT);\n");
    fs.writeFileSync(path.join(tmpRepo, "db", "migrations", "V2__b.sql"), "CREATE TABLE b (id INT);\n");
    const commit = gitCommitAll(tmpRepo, "base");

    const q1 = `${commit}:db/migrations/V1__a.sql`;
    const q2 = `${commit}:db/migrations/V2__b.sql`;
    const results = await batchCatFile(tmpRepo, [q1, q1, q2, q1]);
    assert.equal(results.size, 2, `Expected 2 distinct answers, got ${results.size}`);
    assert.ok(results.get(q1).content.includes("CREATE TABLE a"));
    assert.ok(results.get(q2).content.includes("CREATE TABLE b"));

    // A path missing from the revision is still one answer with a null value (not a hole in the map).
    const missingQuery = `${commit}:db/migrations/V9__missing.sql`;
    const withMissing = await batchCatFile(tmpRepo, [q1, missingQuery]);
    assert.equal(withMissing.size, 2);
    assert.equal(withMissing.get(missingQuery), null);
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

// 65. .graphqls in a sub-folder through the PR path (--changed-from)
test("graphqls in a sub-folder reports gql-breaking with --changed-from", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "graphqls-changed-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "graph", "users.graphqls"),
      "type Query {\n  users: [User!]!\n}\ntype User {\n  id: ID!\n  email: String!\n}\n"
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.writeFileSync(
      path.join(tmpRepo, "graph", "users.graphqls"),
      "type Query {\n  users: [User!]!\n}\ntype User {\n  id: ID!\n}\n"
    );
    gitCommitAll(tmpRepo, "remove User.email");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, "."], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for removed GraphQL field, got ${r.status}: ${r.stderr}`);
    assert.ok(!r.stdout.includes("Architecture Guardrails: Passed"), `Must not report Passed: ${r.stdout}`);
    assert.ok(r.stdout.includes("gql-breaking"), `Expected gql-breaking finding: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 66. .graphqls in a sub-folder in two-directory mode
test("graphqls in a sub-folder reports gql-breaking in two-directory mode", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "graphqls-2dir-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "graphqls-2dir-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "graph"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpBase, "graph", "users.graphqls"),
      "type Query {\n  users: [User!]!\n}\ntype User {\n  id: ID!\n  email: String!\n}\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "graph", "users.graphqls"),
      "type Query {\n  users: [User!]!\n}\ntype User {\n  id: ID!\n}\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for removed GraphQL field, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "gql-breaking"),
      `Expected gql-breaking finding: ${r.stdout}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 66b. Deleting a GraphQL schema passes (gql-breaking on the removed schema)
test("git rm graph/schema.graphql reports gql-breaking with --changed-from", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-delete-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "graph", "schema.graphql"),
      "type User {\n  id: ID!\n  email: String\n}\ntype Query {\n  me: User\n}\n"
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    spawnSync("git", ["rm", "graph/schema.graphql"], { cwd: tmpRepo, encoding: "utf8" });
    gitCommitAll(tmpRepo, "delete schema");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for deleted GraphQL schema, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes("gql-breaking"), `Expected gql-breaking finding: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 66c. Moving a GraphQL schema with no content change passes (no gql finding)
test("git mv graph/schema.graphql api/schema.graphql with no content change exits 0", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-move-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "graph", "schema.graphql"),
      "type User {\n  id: ID!\n  email: String\n}\ntype Query {\n  me: User\n}\n"
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    spawnSync("git", ["mv", "graph/schema.graphql", "api/schema.graphql"], { cwd: tmpRepo, encoding: "utf8" });
    gitCommitAll(tmpRepo, "move schema");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 0, `Expected exit 0 for moved GraphQL schema with no change, got ${r.status}: ${r.stderr}`);
    assert.ok(!r.stdout.includes("gql-breaking"), `Must not report gql-breaking: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 66d. Moving a GraphQL schema and removing a field reports gql-breaking
test("git mv graph/schema.graphql api/schema.graphql plus removing email reports gql-breaking", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-move-edit-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "graph"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "graph", "schema.graphql"),
      "type User {\n  id: ID!\n  email: String\n}\ntype Query {\n  me: User\n}\n"
    );
    const baseCommit = gitCommitAll(tmpRepo, "base schema");

    fs.mkdirSync(path.join(tmpRepo, "api"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "api", "schema.graphql"),
      "type User {\n  id: ID!\n}\ntype Query {\n  me: User\n}\n"
    );
    spawnSync("git", ["rm", "graph/schema.graphql"], { cwd: tmpRepo, encoding: "utf8" });
    gitCommitAll(tmpRepo, "move schema and remove email");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], {
      cwd: tmpRepo,
      encoding: "utf8"
    });
    assert.equal(r.status, 2, `Expected exit 2 for moved GraphQL schema with removed field, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes("gql-breaking"), `Expected gql-breaking finding: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 67. Capped markdown: JSON on stdout stays valid and every finding reaches stderr (the job log)
test("capped markdown keeps valid JSON on stdout and prints all 50 findings to stderr", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "joblog-cap-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "joblog-cap-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "migrations"), { recursive: true });

    const cols = Array.from({ length: 50 }, (_, i) => `  c${i + 1} INT`).join(",\n");
    const createSql = `CREATE TABLE users (\n  id INT PRIMARY KEY,\n${cols}\n);\n`;
    fs.writeFileSync(path.join(tmpBase, "db", "migrations", "0001_init.sql"), createSql);
    fs.writeFileSync(path.join(tmpHead, "db", "migrations", "0001_init.sql"), createSql);

    const drops = Array.from({ length: 50 }, (_, i) => `ALTER TABLE users DROP COLUMN c${i + 1};`).join("\n");
    fs.writeFileSync(path.join(tmpHead, "db", "migrations", "0002_drop.sql"), drops + "\n");

    const r = spawnSync(
      process.execPath,
      [CLI, "check", tmpBase, tmpHead, "--json", "--md", path.join(tmpHead, "report.md")],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 2, `Expected exit 2 for 50 soft drops, got ${r.status}: ${r.stderr}`);

    // stdout is untouched JSON: the full list is on stderr only.
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.findings.filter(f => f.ruleId === "sql-no-drop-column").length, 50);

    const report = fs.readFileSync(path.join(tmpHead, "report.md"), "utf8");
    assert.ok(report.includes("(see the job log"), "The markdown must be capped so the log fallback is exercised");

    const plainLines = r.stderr.split(/\r?\n/).filter(line => LEVEL_LINE.test(line));
    assert.equal(plainLines.length, 50, `Expected 50 plain finding lines on stderr, got ${plainLines.length}: ${r.stderr}`);
    for (let i = 1; i <= 50; i++) {
      assert.ok(
        r.stderr.includes(`db.column:users.c${i}`),
        `stderr must list users.c${i} (the capped comment does not)`
      );
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 68/69. --log-all prints every finding to stderr; without capping or --log-all nothing is printed
function makeTwoSoftDropDirs() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "joblog-two-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "joblog-two-head-"));
  fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
  fs.mkdirSync(path.join(tmpHead, "db", "migrations"), { recursive: true });
  const createSql = "CREATE TABLE orders (\n  id INT PRIMARY KEY,\n  a INT,\n  b INT\n);\n";
  fs.writeFileSync(path.join(tmpBase, "db", "migrations", "0001_init.sql"), createSql);
  fs.writeFileSync(path.join(tmpHead, "db", "migrations", "0001_init.sql"), createSql);
  fs.writeFileSync(
    path.join(tmpHead, "db", "migrations", "0002_drop.sql"),
    "ALTER TABLE orders DROP COLUMN a;\nALTER TABLE orders DROP COLUMN b;\n"
  );
  return { tmpBase, tmpHead };
}

test("--log-all prints one plain line per finding to stderr", () => {
  const { tmpBase, tmpHead } = makeTwoSoftDropDirs();
  try {
    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--log-all"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}: ${r.stderr}`);
    const plainLines = r.stderr.split(/\r?\n/).filter(line => LEVEL_LINE.test(line));
    assert.equal(plainLines.length, 2, `Expected 2 plain lines, got ${plainLines.length}: ${r.stderr}`);
    assert.ok(plainLines.every(line => line.includes("sql-no-drop-column")), `Wrong lines: ${plainLines.join(" | ")}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("no capping and no --log-all prints no plain finding lines", () => {
  const { tmpBase, tmpHead } = makeTwoSoftDropDirs();
  try {
    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}: ${r.stderr}`);
    const plainLines = r.stderr.split(/\r?\n/).filter(line => LEVEL_LINE.test(line));
    assert.equal(plainLines.length, 0, `Expected no plain lines, got: ${plainLines.join(" | ")}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 70b. `check --help` documents --log-all
test("check --help documents --log-all", () => {
  const r = spawnSync(process.execPath, [CLI, "check", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, `check --help should exit 0: ${r.stderr}`);
  assert.ok(r.stdout.includes("--log-all"), `check --help must list --log-all: ${r.stdout}`);
});

// 70. A truncated scan cannot be overridden back to green
test("scan-truncated cannot be overridden: check still exits 1", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "scan-trunc-override-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "scan-trunc-override-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "migrations"), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      const content = `CREATE TABLE t_${i} (id INT PRIMARY KEY);\n`;
      fs.writeFileSync(path.join(tmpBase, "db", "migrations", `V${i}__t.sql`), content);
      fs.writeFileSync(path.join(tmpHead, "db", "migrations", `V${i}__t.sql`), content);
    }

    const r = spawnSync(
      process.execPath,
      [
        CLI, "check", tmpBase, tmpHead,
        "--max-files", "2",
        "--override", "scan-truncated",
        "--override-by", "bob",
        "--override-permission", "write",
        "--pr-author", "alice",
        "--override-reason", "please"
      ],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 1, `A truncated scan must stay a hard failure, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes("can never be overridden"), `Override must be refused: ${r.stderr}`);
    assert.ok(!r.stdout.includes("Architecture Guardrails: Passed"), `Must not report Passed: ${r.stdout}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 71. Override values that look like help are not help requests (B1)
test("override value equal to help or -h is not a help request: exact Action argv still fails with JSON", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-help-argv-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-help-out-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.20\n");
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.20\n    privileged: true\n");
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "head"], { cwd: tmpRepo });
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // The exact CHECK_ARGS shape the Action builds (override values in --flag=value form).
    const checkArgs = [
      CLI, "check",
      "--changed-from", baseCommit,
      tmpRepo,
      "--include-untracked",
      "--policy-from", "base",
      "--json",
      "--md", path.join(outDir, "guardrails.md"),
      "--head-sha", headSha
    ];

    // 1. rule id equal to "help"
    const r1 = spawnSync(
      process.execPath,
      [
        ...checkArgs,
        "--override=help",
        `--override-sha=${headSha}`,
        "--override-by=bob",
        "--override-permission=write",
        "--pr-author=alice",
        "--override-reason=ship it"
      ],
      { encoding: "utf8" }
    );
    assert.equal(r1.status, 1, `Override value 'help' must not turn a failing check green, got ${r1.status}: ${r1.stderr}`);
    assert.ok(!r1.stdout.includes("usage: archtour check"), `Must not print usage: ${r1.stdout}`);
    const p1 = JSON.parse(r1.stdout);
    assert.equal(p1.exitCode, 1);
    assert.ok(p1.findings.some(f => f.ruleId === "no-privileged-containers" && f.level === "hard"));

    // 2. reason equal to "-h"
    const r2 = spawnSync(
      process.execPath,
      [
        ...checkArgs,
        "--override=no-privileged-containers",
        `--override-sha=${headSha}`,
        "--override-by=bob",
        "--override-permission=write",
        "--pr-author=alice",
        "--override-reason=-h"
      ],
      { encoding: "utf8" }
    );
    assert.equal(r2.status, 1, `Override reason '-h' must not turn a failing check green, got ${r2.status}: ${r2.stderr}`);
    assert.ok(!r2.stdout.includes("usage: archtour check"), `Must not print usage: ${r2.stdout}`);
    const p2 = JSON.parse(r2.stdout);
    assert.equal(p2.exitCode, 1);
    assert.ok(p2.findings.some(f => f.ruleId === "no-privileged-containers" && f.level === "hard"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// 72. Prisma per-folder migrations replay on the --changed-from path (B2)
test("Prisma per-folder migrations replay index and type narrowing in --changed-from and two-directory modes", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "check-prisma-mig-"));
  const baseCopy = fs.mkdtempSync(path.join(os.tmpdir(), "check-prisma-mig-base-"));
  try {
    spawnSync("git", ["init"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    spawnSync("git", ["config", "commit.gpgSign", "false"], { cwd: tmpRepo });

    const migDir = path.join(tmpRepo, "prisma", "migrations");
    const m1 = path.join(migDir, "20240101000000_init");
    fs.mkdirSync(m1, { recursive: true });
    fs.writeFileSync(path.join(migDir, "migration_lock.toml"), 'provider = "postgresql"\n');
    fs.writeFileSync(
      path.join(m1, "migration.sql"),
      [
        'CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "email" VARCHAR(255));',
        'CREATE TABLE "Booking" ("id" SERIAL PRIMARY KEY, "userId" INTEGER);',
        ""
      ].join("\n")
    );
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "base"], { cwd: tmpRepo });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    // Snapshot the base tree for two-directory mode
    fs.cpSync(path.join(tmpRepo, "prisma"), path.join(baseCopy, "prisma"), { recursive: true });

    const m2 = path.join(migDir, "20240202000000_add_index");
    fs.mkdirSync(m2, { recursive: true });
    fs.writeFileSync(
      path.join(m2, "migration.sql"),
      [
        'CREATE INDEX "b_idx" ON "Booking"("userId");',
        'ALTER TABLE "User" ALTER COLUMN "email" SET DATA TYPE VARCHAR(10);',
        ""
      ].join("\n")
    );
    spawnSync("git", ["add", "-A"], { cwd: tmpRepo });
    spawnSync("git", ["commit", "-m", "head"], { cwd: tmpRepo });

    const runChanged = spawnSync(
      process.execPath,
      [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(runChanged.status, 0, `Expected exit 0 (warn only), got ${runChanged.status}: ${runChanged.stderr}`);
    const pChanged = JSON.parse(runChanged.stdout);
    assert.ok(
      pChanged.findings.some(f => f.ruleId === "sql-index-without-concurrently"),
      `Expected sql-index-without-concurrently on the Prisma layout, got: ${pChanged.findings.map(f => f.ruleId).join(", ")}`
    );
    assert.ok(
      pChanged.findings.some(f => f.ruleId === "sql-type-narrowed"),
      `Expected sql-type-narrowed on the Prisma layout, got: ${pChanged.findings.map(f => f.ruleId).join(", ")}`
    );

    const runTwoDir = spawnSync(process.execPath, [CLI, "check", baseCopy, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(runTwoDir.status, 0, `Expected exit 0 (warn only), got ${runTwoDir.status}: ${runTwoDir.stderr}`);
    const pTwoDir = JSON.parse(runTwoDir.stdout);
    assert.ok(pTwoDir.findings.some(f => f.ruleId === "sql-index-without-concurrently"));
    assert.ok(pTwoDir.findings.some(f => f.ruleId === "sql-type-narrowed"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(baseCopy, { recursive: true, force: true });
  }
});

// 73. A NEW Helm-skipped manifest outside a chart is soft; inside a real chart it stays advisory (B3)
test("new privileged Pod with a {{ $labels }} annotation is soft outside a chart and advisory inside one", (t) => {
  const outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), "helm-b3-out-base-"));
  const outsideHead = fs.mkdtempSync(path.join(os.tmpdir(), "helm-b3-out-head-"));
  const chartBase = fs.mkdtempSync(path.join(os.tmpdir(), "helm-b3-chart-base-"));
  const chartHead = fs.mkdtempSync(path.join(os.tmpdir(), "helm-b3-chart-head-"));
  try {
    const pod = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      "  name: agent",
      "  annotations:",
      '    summary: "{{ $labels.instance }} down"',
      "spec:",
      "  containers:",
      "    - name: agent",
      "      image: busybox",
      "      securityContext:",
      "        privileged: true",
      ""
    ].join("\n");

    fs.mkdirSync(path.join(outsideHead, "deploy"), { recursive: true });
    fs.writeFileSync(path.join(outsideHead, "deploy", "pod.yaml"), pod);

    const rOutside = spawnSync(process.execPath, [CLI, "check", outsideBase, outsideHead, "--json"], { encoding: "utf8" });
    const pOutside = JSON.parse(rOutside.stdout);
    const fOutside = pOutside.findings.find(f => f.ruleId === "changed-file-not-checked");
    assert.ok(fOutside, "new Helm-skipped manifest outside a chart must produce changed-file-not-checked");
    assert.equal(fOutside.level, "soft", "outside a real chart the finding must be soft, not advisory");
    assert.notEqual(rOutside.status, 0, "a new privileged Pod skipped as Helm must not pass silently");

    fs.mkdirSync(path.join(chartHead, "chart", "templates"), { recursive: true });
    fs.writeFileSync(path.join(chartHead, "chart", "Chart.yaml"), "apiVersion: v2\nname: app\nversion: 0.1.0\n");
    fs.writeFileSync(path.join(chartHead, "chart", "templates", "pod.yaml"), pod);

    const rChart = spawnSync(process.execPath, [CLI, "check", chartBase, chartHead, "--json"], { encoding: "utf8" });
    const pChart = JSON.parse(rChart.stdout);
    const fChart = pChart.findings.find(f => f.ruleId === "changed-file-not-checked");
    assert.ok(fChart, "inside a real chart the skip must still be reported");
    assert.equal(fChart.level, "soft", "a new privileged template inside a chart is soft by default (0.2.9)");
    assert.equal(rChart.status, 2, `a new unreadable template blocks (soft) even inside a chart: ${rChart.stderr}`);
  } finally {
    for (const dir of [outsideBase, outsideHead, chartBase, chartHead]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// 74. Oversized BASE spec is reported, not silent (review-6 N6)
test("an oversized base spec that parses in head emits soft file-not-checked instead of nothing", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "big-base-spec-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "big-base-spec-head-"));
  try {
    const bigSpec = {
      openapi: "3.0.0",
      info: { title: "API", version: "1.0.0", "x-pad": "x".repeat(6 * 1024 * 1024) },
      paths: { "/users": { get: { operationId: "listUsers", responses: { 200: { description: "ok" } } } } }
    };
    fs.writeFileSync(path.join(tmpBase, "openapi.json"), JSON.stringify(bigSpec));
    const smallSpec = {
      openapi: "3.0.0",
      info: { title: "API", version: "1.0.0" },
      paths: { "/users": { get: { operationId: "listUsers", responses: { 200: { description: "ok" } } } } }
    };
    fs.writeFileSync(path.join(tmpHead, "openapi.json"), JSON.stringify(smallSpec));

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for a base version that was not checked, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.notEqual(parsed.verdict, "passed");
    const f = parsed.findings.find(x => x.ruleId === "file-not-checked");
    assert.ok(f, "Expected a file-not-checked finding for the oversized base spec");
    assert.equal(f.level, "soft");
    assert.ok(f.message.includes("removals cannot be detected"), `Message must explain the base was not checked: ${f.message}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 75. The 20-per-rule cap applies to warn and advisory findings too
test("the 20-per-rule comment cap applies to warn and advisory findings", () => {
  const make = (level, ruleId) => Array.from({ length: 25 }, (_, i) => ({
    ruleId,
    level,
    entityId: `${ruleId}:item_${i + 1}`,
    message: `Finding ${i + 1}`,
    source: { file: `config/${ruleId}.yml`, line: i + 1 }
  }));

  for (const [level, ruleId] of [["warn", "service-image-changed"], ["advisory", "service-image-changed"]]) {
    const md = formatMarkdownReport(make(level, ruleId), {});
    assert.ok(
      md.includes(`- ... and 5 more \`${ruleId}\` findings (see the job log)`),
      `${level} findings must be capped at 20: ${md}`
    );
    const bullets = md.match(/  - Entity: `service-image-changed:item_\d+`/g) || [];
    assert.equal(bullets.length, 20, `Expected 20 displayed ${level} findings, got ${bullets.length}`);
  }
});

// 76. Fix 1: Applied migration renamed or moved away should fail (--changed-from with renamed .sql migration to .bak)
test("renamed migration to .bak fails check with sql-no-migration-edited", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "migration-rename-bak-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "001_init.sql"), "CREATE TABLE users (id INT PRIMARY KEY, email TEXT);");
    fs.writeFileSync(path.join(tmpRepo, "migrations", "002_name.sql"), "ALTER TABLE users ADD COLUMN name TEXT;");
    gitCommitAll(tmpRepo, "base migrations");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    spawnSync("git", ["mv", "migrations/001_init.sql", "migrations/001_init.sql.bak"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "rename to bak");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 for renamed migration, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-migration-edited"), "Expected sql-no-migration-edited finding");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 77. Fix 1: Renamed migration to .txt should also fail
test("renamed migration to .txt fails check with sql-no-migration-edited", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "migration-rename-txt-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "001_init.sql"), "CREATE TABLE users (id INT PRIMARY KEY);");
    fs.writeFileSync(path.join(tmpRepo, "migrations", "002_name.sql"), "ALTER TABLE users ADD COLUMN name TEXT;");
    gitCommitAll(tmpRepo, "base");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    spawnSync("git", ["mv", "migrations/001_init.sql", "migrations/001_init.txt"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "rename to txt");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-migration-edited"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 78. Fix 1: Moved migration to docs/ should fail
test("migration moved to docs/ fails check with sql-no-migration-edited", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "migration-move-docs-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "001_init.sql"), "CREATE TABLE users (id INT);");
    fs.writeFileSync(path.join(tmpRepo, "migrations", "002_name.sql"), "ALTER TABLE users ADD COLUMN name TEXT;");
    gitCommitAll(tmpRepo, "base");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    fs.mkdirSync(path.join(tmpRepo, "docs"), { recursive: true });
    spawnSync("git", ["mv", "migrations/001_init.sql", "docs/001_init.sql"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "move to docs");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-migration-edited"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 79. Fix 1: Prisma migration renamed to .bak should fail
test("Prisma migration renamed to .bak fails check", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-rename-bak-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "prisma", "migrations", "20240101_init"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "prisma", "migrations", "20240101_init", "migration.sql"), "CREATE TABLE users (id INT);");
    fs.writeFileSync(path.join(tmpRepo, "prisma", "migration_lock.toml"), "provider = \"sqlite\"\n");
    gitCommitAll(tmpRepo, "base");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    spawnSync("git", ["mv", "prisma/migrations/20240101_init/migration.sql", "prisma/migrations/20240101_init/migration.sql.bak"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "rename prisma migration");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-migration-edited"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 80. Fix 1: Control - renaming to a different migration number keeps current behavior
test("renamed migration to different migration number behaves as expected", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "migration-rename-num-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "migrations", "001_init.sql"), "CREATE TABLE users (id INT);");
    fs.writeFileSync(path.join(tmpRepo, "migrations", "002_name.sql"), "ALTER TABLE users ADD COLUMN name TEXT;");
    gitCommitAll(tmpRepo, "base");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    spawnSync("git", ["mv", "migrations/002_name.sql", "migrations/003_name.sql"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "rename migration number");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    // The result should match what git rm would give for the same file
    assert.equal(r.status, 1, `Expected exit 1 for moved migration (deletion of cumulative), got ${r.status}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 81. Fix 2: Helm template trailing comment detection
test("YAML comment stripping: trailing comments in YAML parsed correctly", () => {
  // Trailing comment should not trigger template detection
  const content1 = "image: nginx  # {{ .Values.tag }}\n";
  assert.equal(isHelmTemplate("test.yaml", content1), false, "Trailing comment should not be template");

  // Template in value should trigger detection
  const content2 = "image: \"{{ .Values.image }}\"\n";
  assert.equal(isHelmTemplate("test.yaml", content2), true, "Template in quoted value should be detected");

  // Template in quoted string should not trigger detection if it's just in a comment
  const content3 = "image: nginx\n  # This contains {{ .Values.x }} but it's a comment\n";
  assert.equal(isHelmTemplate("test.yaml", content3), false, "Full-line comment should not be template");
});

// 82. Fix 2: Pod with template value and Chart.yaml added in same commit
test("Pod with template value and Chart.yaml added in same commit exits 2", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-chart-added-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "k8s"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".gitkeep"), "");
    gitCommitAll(tmpRepo, "init");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    const podContent = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test\nspec:\n  containers:\n  - name: app\n    image: \"{{ .Values.image }}\"\n";
    fs.writeFileSync(path.join(tmpRepo, "k8s", "pod.yaml"), podContent);
    fs.writeFileSync(path.join(tmpRepo, "Chart.yaml"), "apiVersion: v2\nname: test\n");
    gitCommitAll(tmpRepo, "add pod and chart");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 (soft) for added Chart.yaml, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "changed-file-not-checked"), "Expected changed-file-not-checked finding");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 83. Fix: A folder named Chart.yaml does not count as a chart (must be a file)
test("folder Chart.yaml/ with a Pod added in same commit exits 2 (file-not-checked)", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-chart-folder-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "k8s"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".gitkeep"), "");
    gitCommitAll(tmpRepo, "init");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    const podContent = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test\nspec:\n  containers:\n  - name: app\n    image: \"{{ .Values.image }}\"\n";
    fs.mkdirSync(path.join(tmpRepo, "Chart.yaml"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "Chart.yaml", "dummy.txt"), "not a chart\n");
    fs.writeFileSync(path.join(tmpRepo, "k8s", "pod.yaml"), podContent);
    gitCommitAll(tmpRepo, "add pod and Chart.yaml folder");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for Chart.yaml folder (not a file), got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "changed-file-not-checked"), "Expected changed-file-not-checked finding for folder trick");
    assert.ok(!parsed.findings.some(f => f.level === "advisory"), "Folder must not produce advisory");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 83b. Fix: A file named chart.yaml (lowercase) does not count as a chart
test("file chart.yaml (lowercase) with a Pod added in same commit exits 2 (file-not-checked)", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-chart-lowercase-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "k8s"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".gitkeep"), "");
    gitCommitAll(tmpRepo, "init");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    const podContent = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test\nspec:\n  containers:\n  - name: app\n    image: \"{{ .Values.image }}\"\n";
    fs.writeFileSync(path.join(tmpRepo, "chart.yaml"), "apiVersion: v2\nname: test\n");
    fs.writeFileSync(path.join(tmpRepo, "k8s", "pod.yaml"), podContent);
    gitCommitAll(tmpRepo, "add pod and chart.yaml (lowercase)");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for chart.yaml (lowercase, not a chart), got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "changed-file-not-checked"), "Expected changed-file-not-checked finding for lowercase chart.yaml");
    assert.ok(!parsed.findings.some(f => f.level === "advisory"), "Lowercase chart.yaml must not produce advisory");
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 84. Fix 2: Pod with template and Chart.yaml in base commit should not hide it (advisory)
test("Pod template edited inside a chart that exists in base: soft by default, advisory when the base policy lowers it", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-chart-base-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, "templates"), { recursive: true });

    const podContent = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test\nspec:\n  containers:\n  - name: app\n    image: \"{{ .Values.image }}\"\n";
    fs.writeFileSync(path.join(tmpRepo, "Chart.yaml"), "apiVersion: v2\nname: test\n");
    fs.writeFileSync(path.join(tmpRepo, "templates", "pod.yaml"), podContent);
    gitCommitAll(tmpRepo, "add chart and pod");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();

    fs.writeFileSync(path.join(tmpRepo, "templates", "pod.yaml"), podContent + "  # another change\n");
    gitCommitAll(tmpRepo, "modify pod");

    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json", "--render-helm", "off"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 (soft changed-file-not-checked) for an edited chart template, got ${r.status}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "changed-file-not-checked" && f.level === "soft"));

    // A team that renders charts elsewhere lowers the rule in the BASE branch policy -> the same edit passes.
    spawnSync("git", ["checkout", "-q", baseCommit], { cwd: tmpRepo });
    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"),
      "version: 1\nextends: archtour:recommended\nrules:\n  - id: changed-file-not-checked\n    level: advisory\n");
    spawnSync("git", ["checkout", "-q", "-b", "policy-base"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "base policy lowers changed-file-not-checked");
    const policyBase = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(tmpRepo, "templates", "pod.yaml"), podContent + "  # another change\n");
    gitCommitAll(tmpRepo, "modify pod again");
    const r2 = spawnSync(process.execPath, [CLI, "check", "--changed-from", policyBase, tmpRepo, "--json", "--render-helm", "off"], { encoding: "utf8" });
    assert.equal(r2.status, 0, `Expected exit 0 when the base policy lowers changed-file-not-checked, got ${r2.status}: ${r2.stderr}`);
    const parsed2 = JSON.parse(r2.stdout);
    assert.ok(parsed2.findings.some(f => f.ruleId === "changed-file-not-checked" && f.level === "advisory"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 0.2.9: a renamed file inherits base content only from a path the check reads
test("renaming an unchecked docker-compose.yml.dist to docker-compose.yml is checked as a new file", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "rename-dist-"));
  try {
    gitInitRepo(tmpRepo);
    const compose = "services:\n  api:\n    image: nginx\n    privileged: true\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n";
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml.dist"), compose);
    gitCommitAll(tmpRepo, "base");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["mv", "docker-compose.yml.dist", "docker-compose.yml"], { cwd: tmpRepo });
    gitCommitAll(tmpRepo, "rename");
    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 (hard) for a renamed-in privileged compose file, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.findings.some(f => f.ruleId === "no-privileged-containers"));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// 0.2.9: a changed candidate file in a folder skipped by default gets an advisory notice, not silence
test("a changed manifest under tests/ gets an advisory file-not-checked naming the folder", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skipped-folder-"));
  try {
    gitInitRepo(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "x\n");
    gitCommitAll(tmpRepo, "base");
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).stdout.trim();
    fs.mkdirSync(path.join(tmpRepo, "tests", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "tests", "fixtures", "docker-compose.yml"), "services:\n  api:\n    image: nginx\n    privileged: true\n");
    gitCommitAll(tmpRepo, "fixture");
    const r = spawnSync(process.execPath, [CLI, "check", "--changed-from", baseCommit, tmpRepo, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `a skipped-folder notice is advisory, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const f = parsed.findings.find(x => x.ruleId === "file-not-checked");
    assert.ok(f, "expected an advisory file-not-checked notice");
    assert.equal(f.level, "advisory");
    assert.ok(f.message.includes("tests/"), f.message);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// T-104.1: advisory file-not-checked collapses into a <details> block; other advisory stays
test("formatMarkdownReport collapses advisory file-not-checked into <details>, leaves other advisory rendered", () => {
  const paths = ["tests/fixtures/docker-compose.yml", "examples/app/deploy.yaml", "fixtures/schema.prisma"];
  const findings = [
    ...paths.map(p => ({
      ruleId: "file-not-checked",
      level: "advisory",
      message: `Candidate architecture file '${p}' was not checked: folder skipped by default`,
      event: { type: "file.not_checked", entityId: `file:${p}`, kind: "file" },
      source: { file: p, line: 1 }
    })),
    {
      ruleId: "service-image-changed",
      level: "advisory",
      message: "Image tag changed",
      event: { type: "service.image_changed", entityId: "service:app", kind: "service" },
      source: { file: "docker-compose.yml", line: 4 }
    }
  ];
  const md = formatMarkdownReport(findings);
  assert.ok(md.includes("<details>"), "report should contain a <details> block for collapsed notices");
  assert.ok(md.includes("3 changed files not checked"), "details summary should say 3 changed files not checked");
  for (const p of paths) {
    assert.ok(md.includes(p), "each skipped path should appear once");
  }
  assert.ok(md.includes("- **Image tag changed**"), "the other advisory finding must still render as a normal bullet");
});

test("formatMarkdownReport: 1 notice says '1 changed file not checked'; 60 notices show 50 lines and '... and 10 more'", () => {
  const one = [{
    ruleId: "file-not-checked",
    level: "advisory",
    message: "x",
    event: { type: "file.not_checked", entityId: "file:one", kind: "file" },
    source: { file: "just-one.yml", line: 1 }
  }];
  assert.ok(
    formatMarkdownReport(one).includes("1 changed file not checked"),
    "singular form expected for a single notice"
  );

  const paths = Array.from({ length: 60 }, (_, i) => `pkg/${String(i).padStart(2, "0")}/manifest.yaml`);
  const sixty = paths.map(p => ({
    ruleId: "file-not-checked",
    level: "advisory",
    message: `Candidate architecture file '${p}' was not checked: folder skipped by default`,
    event: { type: "file.not_checked", entityId: `file:${p}`, kind: "file" },
    source: { file: p, line: 1 }
  }));
  const md = formatMarkdownReport(sixty);
  assert.ok(md.includes("- ... and 10 more (see the job log)"), "tail should say ... and 10 more");
  assert.ok(md.includes("`pkg/00/manifest.yaml:1`") && md.includes("`pkg/49/manifest.yaml:1`"),
    "first 50 paths should be present in the capped details block");
  assert.ok(!md.includes("`pkg/50/manifest.yaml"), "the 51st path should be inside the '... and N more' tail only");
  assert.ok(md.includes("</details>"), "the collapsed block should be closed");
});

test("a SOFT file-not-checked finding is NOT collapsed into the advisory <details>", () => {
  const findings = [{
    ruleId: "changed-file-not-checked",
    level: "soft",
    message: `Candidate architecture file 'charts/x/templates/deploy.yaml' was not checked: Helm template`,
    event: { type: "file.not_checked", entityId: "file:charts/x/templates/deploy.yaml", kind: "file" },
    source: { file: "charts/x/templates/deploy.yaml", line: 1 }
  }];
  const md = formatMarkdownReport(findings);
  assert.ok(!md.includes("<details>"), "soft file-not-checked must not be inside a <details> block");
  assert.ok(md.includes("### ⚠️ Soft (1)"), "soft finding must render under its own Soft group");
});

// T-104.2: CLI says 'is a file, expected a directory' when given a file instead of a folder
test("check <dir> <file> exits 3 with 'head is a file, expected a directory' and no stack trace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-file-dir-"));
  const dir = path.join(tmp, "base");
  const file = path.join(tmp, "head.yml");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "services:\n  app:\n    image: nginx\n");

    const r = spawnSync(process.execPath, [CLI, "check", dir, file], {
      encoding: "utf8",
      env: { ...process.env, ARCHTOUR_DEBUG: "" }
    });
    assert.equal(r.status, 3, `Expected exit 3, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes("archtour:"), "stderr must prefix with archtour:");
    assert.ok(r.stderr.includes("head is a file, expected a directory"), `stderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes("    at "), "stderr must not contain a stack trace line");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("check with ARCHTOUR_DEBUG=1 prints a stack trace for the file-instead-of-directory error", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-file-dir-debug-"));
  const dir = path.join(tmp, "base");
  const file = path.join(tmp, "head.yml");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "services:\n  app:\n    image: nginx\n");

    const r = spawnSync(process.execPath, [CLI, "check", dir, file], {
      encoding: "utf8",
      env: { ...process.env, ARCHTOUR_DEBUG: "1" }
    });
    assert.equal(r.status, 3, `Expected exit 3, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes("    at "), "debug mode must include a stack trace line");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
