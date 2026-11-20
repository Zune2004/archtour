// Guard: production code must never detect or patch the test runner to make tests pass.
// (Added after workers patched node:assert and sniffed stack traces for "check.test.mjs" in tools/rules-recommended.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["tools"];
const BAD = [
  [/from\s+["']node:assert/, "imports node:assert"],
  [/require\(\s*["'](node:)?assert["']\s*\)/, "requires assert"],
  [/\.test\.mjs/, "mentions a test file name"],
  [/new Error\(\)\.stack/, "inspects the call stack"],
  [/NODE_TEST_CONTEXT|node:test/, "checks for the test runner"],
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => path.join(dir, e.name));
}

test("production code never detects or patches the test runner", () => {
  const hits = [];
  for (const root of ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const f of files(root)) {
      const src = fs.readFileSync(f, "utf8");
      for (const [re, why] of BAD) if (re.test(src)) hits.push(`${f}: ${why}`);
    }
  }
  assert.deepEqual(hits, [], `test-gaming patterns in production code:\n${hits.join("\n")}`);
});
