import assert from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/check-bans.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runScript(dir, env) {
  return spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makeFixture(content) {
  const dir = mkdtempSync(join(tmpdir(), "archtour-bans-"));
  writeFileSync(join(dir, "rules.mjs"), content);
  return dir;
}

function makeNamedFixture(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "archtour-bans-"));
  writeFileSync(join(dir, name), content);
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("a. real tools/ folder passes (exit 0, check-bans: ok)", () => {
  const result = runScript(join(ROOT, "tools"));
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /check-bans: ok \(\d+ files\)/);
});

test("b. import http from node:http -> exit 1, no-network, line contains ->", () => {
  const dir = makeFixture('import http from "node:http";\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /no-network/);
    assert.match(result.stdout, /->/);
  } finally {
    cleanup(dir);
  }
});

test("c1. await fetch(...) -> no-network", () => {
  const dir = makeFixture('await fetch("https://x");\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /no-network/);
  } finally {
    cleanup(dir);
  }
});

test("c2. fetch inside a // comment -> exit 0", () => {
  const dir = makeFixture('// await fetch("https://x")\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /check-bans: ok/);
  } finally {
    cleanup(dir);
  }
});

test("d. import { execSync } from child_process in changed.mjs -> no-shell", () => {
  const dir = makeNamedFixture("changed.mjs", 'import { execSync } from "node:child_process";\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /no-shell/);
  } finally {
    cleanup(dir);
  }
});

test("e. spawn with shell: true in history.mjs -> no-shell", () => {
  const dir = makeNamedFixture(
    "history.mjs",
    'import { spawn } from "node:child_process";\nspawn("git", [], { shell: true });\n',
  );
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /no-shell/);
  } finally {
    cleanup(dir);
  }
});

test("f. import { execFile } from child_process in rules.mjs -> process-owners naming allowed files", () => {
  const dir = makeFixture('import { execFile } from "node:child_process";\nconst a = 1;\nexecFile("git", ["status"]);\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /process-owners/);
    assert.strictEqual(result.stdout.match(/process-owners/g).length, 1, "one hit per file, on the import line");
    assert.match(result.stdout, /rules\.mjs:1: process-owners/);
    assert.match(result.stdout, /changed\.mjs/);
    assert.match(result.stdout, /history\.mjs/);
    assert.match(result.stdout, /helm-render\.mjs/);
  } finally {
    cleanup(dir);
  }
});

test("g1. fs.writeFileSync in rules.mjs -> fs-writers", () => {
  const dir = makeFixture('fs.writeFileSync("x", "y");\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /fs-writers/);
  } finally {
    cleanup(dir);
  }
});

test("g2. fs.writeFileSync in cli.mjs -> exit 0", () => {
  const dir = makeNamedFixture("cli.mjs", 'fs.writeFileSync("x", "y");\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /check-bans: ok/);
  } finally {
    cleanup(dir);
  }
});

test("h1. import assert from node:assert -> no-test-detection", () => {
  const dir = makeFixture('import assert from "node:assert";\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /no-test-detection/);
  } finally {
    cleanup(dir);
  }
});

test("h2. new Error().stack -> no-test-detection", () => {
  const dir = makeFixture('const s = new Error().stack;\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /no-test-detection/);
  } finally {
    cleanup(dir);
  }
});

test("i. output line format <file>:<line>: <ban id>: ... -> ... with hit on line 3", () => {
  const dir = makeFixture("line one\nline two\nimport http from \"node:http\";\n");
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /rules\.mjs:3: no-network:.*->/);
  } finally {
    cleanup(dir);
  }
});

test("j. runtime-deps: extra left-pad dependency via ARCHTOUR_BANS_PACKAGE", () => {
  const pkgDir = mkdtempSync(join(tmpdir(), "archtour-pkg-"));
  const pkgPath = join(pkgDir, "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify({ name: "x", version: "1.0.0", dependencies: { graphql: "^17.1.0", yaml: "^2.9.1", "left-pad": "^1.3.0" } }),
  );
  try {
    const result = runScript(join(ROOT, "tools"), { ARCHTOUR_BANS_PACKAGE: pkgPath });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /package\.json:1/);
    assert.match(result.stdout, /runtime-deps/);
    assert.match(result.stdout, /left-pad/);
  } finally {
    cleanup(pkgDir);
  }
});

test("k1. fetch inside /* block comment */ -> no hit", () => {
  const dir = makeFixture('/* fetch("x") */ const a = 1;\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /check-bans: ok/);
  } finally {
    cleanup(dir);
  }
});

test("k2. fetch after /* block comment */ on same line -> hit on that line", () => {
  const dir = makeFixture('/* note */ fetch("x");\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /rules\.mjs:1: no-network/);
    assert.match(result.stdout, /->/);
  } finally {
    cleanup(dir);
  }
});

test("k3. fetch inside multi-line block comment -> no hit", () => {
  const dir = makeFixture('/* line 1\n   line 2 */\nfetch("x");\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /rules\.mjs:3: no-network/);
    assert.match(result.stdout, /->/);
  } finally {
    cleanup(dir);
  }
});

test("k4. fetch inside string literal -> hit (current behaviour, no string parser)", () => {
  const dir = makeFixture('"see fetch() docs";\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /rules\.mjs:1: no-network/);
    assert.match(result.stdout, /->/);
  } finally {
    cleanup(dir);
  }
});

test("k5. fetch inside // line comment -> no hit", () => {
  const dir = makeFixture('// fetch("x");\n');
  try {
    const result = runScript(dir);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /check-bans: ok/);
  } finally {
    cleanup(dir);
  }
});
