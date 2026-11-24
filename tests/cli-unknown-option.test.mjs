import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve("tools/cli.mjs");

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
  return { stdout: result.stdout || "", stderr: result.stderr || "", code: result.status };
}

describe("CLI unknown option test", () => {
  test("unknown option --password fails with exit 3 and proper error message (check command)", () => {
    const result = runCli(["check", "--changed-from", "HEAD~1", ".", "--password", "x"]);
    assert.strictEqual(result.code, 3);
    assert.match(result.stderr, /archtour: unknown option --password \(run 'archtour help check'\)/);
  });

  test("unknown option --password fails with exit 3 and proper error message (global position)", () => {
    const result = runCli(["--password", "x", "check", "--changed-from", "HEAD~1", "."]);
    assert.strictEqual(result.code, 3);
    assert.match(result.stderr, /archtour: unknown option --password \(run 'archtour help check'\)/);
  });

  test("unknown option --token fails with exit 3 and proper error message", () => {
    const result = runCli(["check", "--token", "x"]);
    assert.strictEqual(result.code, 3);
    assert.match(result.stderr, /archtour: unknown option --token \(run 'archtour help check'\)/);
  });

  test("unknown option --theme fails with exit 3 and proper error message", () => {
    const result = runCli(["scan", "--theme", "dark"]);
    assert.strictEqual(result.code, 3);
    assert.match(result.stderr, /archtour: unknown option --theme \(run 'archtour help scan'\)/);
  });

  test("unknown option --foo fails with exit 3 and proper error message (no command given)", () => {
    const result = runCli(["--foo"]);
    assert.strictEqual(result.code, 3);
    assert.match(result.stderr, /archtour: unknown option --foo \(run 'archtour help'\)/);
  });

  test("known option -o still works", () => {
    const result = runCli(["scan", "-o", "/tmp/test.json"]);
    assert.doesNotMatch(result.stderr, /unknown option/);
  });

  test("known option --out still works", () => {
    const result = runCli(["scan", "--out", "/tmp/test.json"]);
    assert.doesNotMatch(result.stderr, /unknown option/);
  });

  test("lone dash - is not rejected (stdin)", () => {
    const result = runCli(["check", "-"]);
    assert.doesNotMatch(result.stderr, /unknown option -/);
  });
});