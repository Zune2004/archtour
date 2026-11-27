import assert from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../tools/cli.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...opts.env },
  });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "archtour-cli-"));
  mkdirSync(join(dir, ".archtour"), { recursive: true });
  writeFileSync(join(dir, ".archtour", "rules.yml"), "rules: []\n");
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Orchestrator (2026-11-24): base/head folder pairs; the head adds a privileged container (hard, exit 1), so a run
// that really used the head folder can be told apart from one that did not.
const COMPOSE = "services:\n  app:\n    image: nginx\n";
const COMPOSE_PRIVILEGED = "services:\n  app:\n    image: nginx\n    privileged: true\n";

function folders(headName, headRel = "docker-compose.yml") {
  const dir = mkdtempSync(join(tmpdir(), "archtour-cli-"));
  mkdirSync(join(dir, "base"), { recursive: true });
  writeFileSync(join(dir, "base", "docker-compose.yml"), COMPOSE);
  mkdirSync(join(dir, headName, headRel, ".."), { recursive: true });
  writeFileSync(join(dir, headName, headRel), COMPOSE_PRIVILEGED);
  if (headRel !== "docker-compose.yml") writeFileSync(join(dir, headName, "docker-compose.yml"), COMPOSE);
  return dir;
}

test("cli-polish: -- ends options, folder starting with - is positional", () => {
  const dir = folders("-weird-head-folder");
  try {
    const result = runCli(["check", "base", "--", "-weird-head-folder", "--json"], { cwd: dir });
    assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
    // "--json" after -- is a positional too, so the output is the markdown report, not JSON
    assert.match(result.stdout, /^## ⛔ Architecture Guardrails: Failed \(1 blocking/);
  } finally {
    cleanup(dir);
  }
});

test("cli-polish: -- with nothing after behaves like without --", () => {
  const dir = folders("head");
  try {
    const result1 = runCli(["check", "base", "head"], { cwd: dir });
    const result2 = runCli(["check", "base", "head", "--"], { cwd: dir });
    assert.strictEqual(result1.status, 1);
    assert.strictEqual(result2.status, 1);
    assert.strictEqual(result2.stdout, result1.stdout);
  } finally {
    cleanup(dir);
  }
});

test("cli-polish: help check lists --ignore", () => {
  const result = runCli(["help", "check"]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /--ignore <glob>/);
});

test("cli-polish: help check lists --include-tests", () => {
  const result = runCli(["help", "check"]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /--include-tests/);
});

test("cli-polish: check --ignore skips a folder", () => {
  const dir = folders("head", "svc/docker-compose.yml");
  try {
    assert.strictEqual(runCli(["check", "base", "head"], { cwd: dir }).status, 1);
    assert.strictEqual(runCli(["check", "base", "head", "--ignore", "svc"], { cwd: dir }).status, 0);
  } finally {
    cleanup(dir);
  }
});

test("cli-polish: check --include-tests also checks example folders", () => {
  const dir = folders("head", "examples/docker-compose.yml");
  try {
    assert.strictEqual(runCli(["check", "base", "head"], { cwd: dir }).status, 0);
    assert.strictEqual(runCli(["check", "base", "head", "--include-tests"], { cwd: dir }).status, 1);
  } finally {
    cleanup(dir);
  }
});

test("cli-polish: exit 3 prints to stderr, nothing on stdout, also with --json", () => {
  const result = runCli(["check", "--invalid-option"], { env: { ARCHTOUR_DEBUG: "0" } });
  assert.strictEqual(result.status, 3);
  assert.strictEqual(result.stdout.trim(), "");
  assert.match(result.stderr, /archtour: unknown option/);
});

test("cli-polish: exit 3 with --json prints to stderr, nothing on stdout", () => {
  const result = runCli(["check", "--invalid-option", "--json"], { env: { ARCHTOUR_DEBUG: "0" } });
  assert.strictEqual(result.status, 3);
  assert.strictEqual(result.stdout.trim(), "");
  assert.match(result.stderr, /archtour: unknown option/);
});