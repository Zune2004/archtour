// Regression tests for honest review 11 (2026-11-24): the command is the first argument, a value spelled like a
// command stays a value, and -v/--version after a command never skips the check.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve("tools/cli.mjs");
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-args-"));
  fs.mkdirSync(path.join(dir, "base"));
  fs.mkdirSync(path.join(dir, "head"));
  fs.writeFileSync(path.join(dir, "base", "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
  fs.writeFileSync(path.join(dir, "head", "docker-compose.yml"), "services:\n  app:\n    image: nginx\n    privileged: true\n");
  return dir;
}

for (const flag of ["-v", "--version"]) {
  test(`check base head ${flag} is a usage error (exit 3), not a version print that skips the check`, () => {
    const dir = fixture();
    try {
      const r = run(["check", "base", "head", flag], dir);
      assert.strictEqual(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stderr, /--version and -v must be the only argument/);
      assert.strictEqual(r.stdout, "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("check base head without -v still blocks the privileged container (exit 1)", () => {
  const dir = fixture();
  try {
    assert.strictEqual(run(["check", "base", "head"], dir).status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a value spelled like the command is kept: --md check writes the report to ./check", () => {
  const dir = fixture();
  try {
    const r = run(["check", "base", "head", "--md", "check"], dir);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(fs.statSync(path.join(dir, "check")).isFile(), "the markdown report was not written to ./check");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--version and -v as the first argument still print the version", () => {
  const { version } = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  for (const flag of ["--version", "-v", "version"]) {
    const r = run([flag]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), version);
  }
});
