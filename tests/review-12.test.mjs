// Regression tests for honest review 12 (2026-11-24): the default output keeps its order, agent output lists only
// active findings, CI workflow changes need a human, and the Action fails closed when the check does not finish.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "yaml";

const CLI = path.resolve("tools/cli.mjs");
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });

function repo(base, head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-rev12-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  const write = (files) => {
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), c);
    }
  };
  write(base);
  git("add", "-A");
  git("commit", "-qm", "base");
  write(head);
  git("add", "-A");
  git("commit", "-qm", "head");
  return dir;
}

const COMPOSE_BASE = "services:\n  zeta:\n    image: nginx\n  alpha:\n    image: redis\n";
const COMPOSE_HEAD = "services:\n  zeta:\n    image: nginx:1.27\n    network_mode: host\n  alpha:\n    image: redis\n    privileged: true\n";

test("default --json lists findings in the check's own order (as in 0.3.2), not sorted", () => {
  const dir = repo({ "docker-compose.yml": COMPOSE_BASE }, { "docker-compose.yml": COMPOSE_HEAD });
  try {
    const j = JSON.parse(run(["check", "--changed-from", "HEAD~1", ".", "--json"], dir).stdout);
    assert.deepEqual(j.findings.map((f) => f.ruleId), ["service-image-changed", "no-host-network", "no-privileged-containers"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--brief does not list an overridden finding, so the lines match the verdict counts", () => {
  const dir = repo({ "docker-compose.yml": COMPOSE_BASE }, { "docker-compose.yml": COMPOSE_HEAD });
  try {
    const r = run(["check", "--changed-from", "HEAD~1", ".", "--brief", "--override", "no-host-network", "--override-by", "rev",
      "--override-permission", "write", "--pr-author", "bot", "--override-reason", "ok"], dir);
    assert.deepEqual(r.stdout.trim().split("\n"), [
      "hard no-privileged-containers service:alpha docker-compose.yml:5",
      "advisory service-image-changed service:zeta docker-compose.yml:2",
      "verdict: failed (exit 1): 1 hard, 0 soft, 0 warn, 1 advisory"
    ]);
    assert.equal(r.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a PR that changes a CI workflow needs a human", () => {
  const wf = "on: pull_request\njobs: {}\n";
  const dir = repo({ ".github/workflows/ci.yml": wf, "README.md": "a\n" }, { ".github/workflows/ci.yml": wf + "# off\n" });
  try {
    const j = JSON.parse(run(["check", "--changed-from", "HEAD~1", ".", "--json"], dir).stdout);
    assert.deepEqual(j.needsHuman, { value: true, reasons: ["CI workflow change: .github/workflows/ci.yml"] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Action's output step, run as GitHub would run it: the node script from action.yml with the result file and the
// check's exit code.
function actionOutputs(resultText, exitCode) {
  const step = yaml.parse(fs.readFileSync(path.resolve("action.yml"), "utf8")).runs.steps.find((s) => s.id === "check");
  const from = step.run.indexOf("# needs-human outputs");
  assert.ok(from >= 0, "the needs-human output step was not found in action.yml");
  const m = step.run.slice(from).match(/node -e '([\s\S]*?)' "\$OUTPUT_DIR\/check-result\.json" "\$CHECK_EXIT"/);
  assert.ok(m, "the needs-human output script was not found in action.yml");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-action-out-"));
  try {
    const file = path.join(dir, "check-result.json");
    fs.writeFileSync(file, resultText);
    const r = spawnSync(process.execPath, ["-e", m[1], file, String(exitCode)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Action outputs fail closed when the check did not complete (exit 3, empty result)", () => {
  assert.deepEqual(actionOutputs("", 3), {
    "needs-human": "true",
    "needs-human-reasons": "check did not complete (exit 3)",
    verdict: "error"
  });
});

test("Action outputs pass the check's needsHuman and verdict through when it completed", () => {
  const result = JSON.stringify({ verdict: "passed", exitCode: 0, needsHuman: { value: false, reasons: [] } });
  assert.deepEqual(actionOutputs(result, 0), { "needs-human": "false", "needs-human-reasons": "", verdict: "passed" });
  const risky = JSON.stringify({ verdict: "failed", exitCode: 1, needsHuman: { value: true, reasons: ["a", "b"] } });
  assert.deepEqual(actionOutputs(risky, 1), { "needs-human": "true", "needs-human-reasons": "a; b", verdict: "failed" });
});
