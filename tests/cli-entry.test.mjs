import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const cliPath = resolve("tools/cli.mjs");
const diagramPath = resolve("tools/diagram.mjs");

test("a. node tools/cli.mjs --help exits 0 and prints usage: archtour", () => {
  let exitCode;
  let stdout;
  try {
    stdout = execFileSync("node", [cliPath, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    exitCode = 0;
  } catch (err) {
    stdout = err.stdout || "";
    exitCode = err.status || err.code;
  }
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("usage: archtour"));
});

test("b. node tools/diagram.mjs --help prints the same output as (a) and the help does NOT contain diff-repo", () => {
  let exitCode;
  let stdout;
  try {
    stdout = execFileSync("node", [diagramPath, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    exitCode = 0;
  } catch (err) {
    stdout = err.stdout || "";
    exitCode = err.status || err.code;
  }
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("usage: archtour"));

  // Compare with the output of (a) computed at test time so both use the same binary.
  const ref = execFileSync("node", [cliPath, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(stdout, ref);
  assert.ok(!stdout.includes("diff-repo"), "help output should not reference diff-repo");
});

test("c. node tools/cli.mjs diff-repo a b exits non-zero and its stderr contains usage: archtour", () => {
  let exitCode;
  let stderr;
  try {
    execFileSync("node", [cliPath, "diff-repo", "a", "b"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    exitCode = 0;
  } catch (err) {
    stderr = (err.stderr || "");
    exitCode = err.status || err.code;
  }
  assert.notEqual(exitCode, 0);
  assert.ok(stderr.includes("usage: archtour"));
});

test("d. package.json bin.archtour is tools/cli.mjs and that file starts with #!/usr/bin/env node", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.bin?.archtour, "tools/cli.mjs");
  const cliSource = readFileSync(cliPath, "utf8");
  assert.ok(cliSource.startsWith("#!/usr/bin/env node"));
});

test("e. static check: no .mjs file in tools/ except diff.mjs, diff-repo.mjs, dsl.mjs and mermaid.mjs contains ./diff.mjs, ./diff-repo.mjs, ./mermaid.mjs or ./dsl.mjs in an import, and action.yml, package.json and README.md do not contain tools/diagram.mjs", () => {
  const allowed = new Set(["diff.mjs", "diff-repo.mjs", "dsl.mjs", "mermaid.mjs"]);
  const importTargets = new Set(["./diff.mjs", "./diff-repo.mjs", "./mermaid.mjs", "./dsl.mjs"]);

  const toolsFiles = readdirSync("tools").filter(f => f.endsWith(".mjs"));
  assert.ok(toolsFiles.length > 10);
  for (const gone of allowed) assert.ok(!toolsFiles.includes(gone), `tools/${gone} was removed and must not come back`);
  for (const file of toolsFiles) {
    if (allowed.has(file)) continue;
    const src = readFileSync(`tools/${file}`, "utf8");
    for (const target of importTargets) {
      assert.ok(
        !src.includes(target),
        `${file} must not import ${target}`
      );
    }
  }

  for (const doc of ["action.yml", "package.json", "README.md"]) {
    const src = readFileSync(doc, "utf8");
    assert.ok(
      !src.includes("tools/diagram.mjs"),
      `${doc} must not reference tools/diagram.mjs`
    );
  }
});
