import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve("tools/diagram.mjs");

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function runTwoDir(baseFiles, headFiles) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "silent-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "silent-head-"));
  try {
    writeTree(tmpBase, baseFiles);
    writeTree(tmpHead, headFiles);
    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.ok(r.stdout, `check produced no stdout: ${r.stderr}`);
    return { parsed: JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
}

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

function hasGit() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function hasRule(parsed, ruleId) {
  return parsed.findings.some(f => f.ruleId === ruleId);
}

function runCheck(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, "check", ...args, "--json"], { cwd, encoding: "utf8" });
  assert.ok(r.stdout, `check produced no stdout: ${r.stderr}`);
  return { parsed: JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
}

const PRISMA_INIT = `CREATE TABLE "User" (
  "id" SERIAL PRIMARY KEY,
  "name" text
);
`;

// (a) Prisma runs the whole file, so a DROP COLUMN under -- migrate:down is still executed.
test("T-109a: a drop in a Prisma migration down section is reported", () => {
  const head = {
    "prisma/migrations/20240101000000_init/migration.sql": PRISMA_INIT,
    "prisma/migrations/20240201000000_x/migration.sql":
      `-- migrate:up\nSELECT 1;\n-- migrate:down\nALTER TABLE "User" DROP COLUMN "name";\n`
  };
  const { parsed } = runTwoDir(
    { "prisma/migrations/20240101000000_init/migration.sql": PRISMA_INIT },
    head
  );
  assert.ok(
    hasRule(parsed, "sql-no-drop-column"),
    `Expected sql-no-drop-column for a Prisma migration, got ${JSON.stringify(parsed.findings)}`
  );
});

// (b) dbmate only runs the up section, so the down-section drop stays ignored.
test("T-109b: a drop in a dbmate migration down section is still ignored", () => {
  const init = "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  name text\n);\n";
  const { parsed } = runTwoDir(
    { "migrations/001_init.sql": init },
    {
      "migrations/001_init.sql": init,
      "db/migrations/20240201_x.sql":
        `-- migrate:up\nSELECT 1;\n-- migrate:down\nALTER TABLE users DROP COLUMN name;\n`
    }
  );
  assert.ok(
    !hasRule(parsed, "sql-no-drop-column"),
    `A dbmate down section must stay ignored, got ${JSON.stringify(parsed.findings)}`
  );
});

// (c) UTF-16 (SSMS / PowerShell 5.1) is not silently read as garbage.
test("T-109c: a UTF-16 migration is reported as not checked, not passed", () => {
  const init = "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  name text\n);\n";
  const text = "ALTER TABLE users DROP COLUMN name;\n";
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, "utf16le")]);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "silent-utf16-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "silent-utf16-head-"));
  try {
    writeTree(tmpBase, { "migrations/001_init.sql": init });
    writeTree(tmpHead, { "migrations/001_init.sql": init });
    fs.writeFileSync(path.join(tmpHead, "migrations", "002_drop.sql"), utf16);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.ok(r.stdout, `check produced no stdout: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      hasRule(parsed, "changed-file-not-checked"),
      `Expected changed-file-not-checked for a UTF-16 file, got ${JSON.stringify(parsed.findings)}`
    );
    assert.equal(r.status, 2, `A file that could not be read must block, got exit ${r.status}: ${r.stderr}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// (d) A UTF-8 BOM is not confused with UTF-16.
test("T-109d: a UTF-8 BOM migration is still parsed", () => {
  const init = "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  name text\n);\n";
  const text = "ALTER TABLE users DROP COLUMN name;\n";
  const utf8Bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, "utf8")]);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "silent-utf8-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "silent-utf8-head-"));
  try {
    writeTree(tmpBase, { "migrations/001_init.sql": init });
    writeTree(tmpHead, { "migrations/001_init.sql": init });
    fs.writeFileSync(path.join(tmpHead, "migrations", "002_drop.sql"), utf8Bom);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.ok(r.stdout, `check produced no stdout: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(
      hasRule(parsed, "sql-no-drop-column"),
      `A UTF-8 BOM file must be parsed, got ${JSON.stringify(parsed.findings)}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

const PRIVILEGED_LIST_YAML = `apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Pod
    metadata:
      name: dangerous-list
    spec:
      containers:
        - name: app
          image: nginx:1.25
          securityContext:
            privileged: true
`;

const PRIVILEGED_POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: dangerous-yaml
spec:
  containers:
    - name: app
      image: nginx:1.25
      securityContext:
        privileged: true
`;

const PRIVILEGED_POD_JSON = JSON.stringify({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "dangerous-json" },
  spec: {
    containers: [
      { name: "app", image: "nginx:1.25", securityContext: { privileged: true } }
    ]
  }
}, null, 2) + "\n";

// (e) kind: List wraps the Pod; each item is its own document.
test("T-109e: a privileged Pod inside kind: List is reported", () => {
  const { parsed } = runTwoDir(
    { "docker-compose.yml": "services:\n  app:\n    image: nginx\n" },
    { "docker-compose.yml": "services:\n  app:\n    image: nginx\n", "k8s/list.yaml": PRIVILEGED_LIST_YAML }
  );
  assert.ok(
    hasRule(parsed, "no-k8s-privileged-containers"),
    `Expected no-k8s-privileged-containers for kind: List, got ${JSON.stringify(parsed.findings)}`
  );
});

// (f) A JSON manifest must reach parseK8sFacts too (a changed .json file in --changed-from mode).
test("T-109f: a privileged Pod in a JSON manifest is reported", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "silent-json-k8s-"));
  try {
    gitInitRepo(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    const baseCommit = gitCommitAll(tmpRepo, "base");

    fs.mkdirSync(path.join(tmpRepo, "k8s"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "k8s", "pod.json"), PRIVILEGED_POD_JSON);
    gitCommitAll(tmpRepo, "add json pod");

    const { parsed } = runCheck(tmpRepo, ["--changed-from", baseCommit]);
    assert.ok(
      hasRule(parsed, "no-k8s-privileged-containers"),
      `Expected no-k8s-privileged-containers for a JSON Pod, got ${JSON.stringify(parsed.findings)}`
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// (g) Both new manifests in --changed-from mode.
test("T-109g: kind: List and JSON Pod are checked in --changed-from mode", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "silent-k8s-changed-"));
  try {
    gitInitRepo(tmpRepo);
    fs.writeFileSync(path.join(tmpRepo, "docker-compose.yml"), "services:\n  app:\n    image: nginx\n");
    const baseCommit = gitCommitAll(tmpRepo, "base");

    fs.mkdirSync(path.join(tmpRepo, "k8s"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "k8s", "list.yaml"), PRIVILEGED_LIST_YAML);
    fs.writeFileSync(path.join(tmpRepo, "k8s", "pod.json"), PRIVILEGED_POD_JSON);
    gitCommitAll(tmpRepo, "add k8s manifests");

    const { parsed } = runCheck(tmpRepo, ["--changed-from", baseCommit]);
    const findings = parsed.findings.filter(f => f.ruleId === "no-k8s-privileged-containers");
    assert.equal(
      findings.length, 2,
      `Expected one finding per manifest, got ${JSON.stringify(parsed.findings)}`
    );
    const files = findings.map(f => String(f.source?.file || f.event?.source?.file || "")).sort();
    assert.ok(files.some(f => f.endsWith("k8s/list.yaml")), `Expected list.yaml in ${JSON.stringify(files)}`);
    assert.ok(files.some(f => f.endsWith("k8s/pod.json")), `Expected pod.json in ${JSON.stringify(files)}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

const POLICY_HARD = `version: 1
extends: [archtour:recommended]
rules:
  - id: sql-no-drop-column
    level: hard
`;

const POLICY_OFF = `version: 1
extends: [archtour:recommended]
rules:
  - id: sql-no-drop-column
    level: off
`;

const BASE_SQL = "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  name text\n);\n";
const DROP_SQL = "ALTER TABLE users DROP COLUMN name;\n";

// (h) A subfolder scan must use the policy at the repo root, not the built-in levels.
test("T-109h: check --changed-from <ref> <subfolder> uses the root policy from the base", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "silent-subfolder-policy-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), POLICY_HARD);
    fs.mkdirSync(path.join(tmpRepo, "services", "api", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "services", "api", "migrations", "001.sql"), BASE_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base");

    fs.writeFileSync(path.join(tmpRepo, "services", "api", "migrations", "002.sql"), DROP_SQL);
    gitCommitAll(tmpRepo, "add dropping migration");

    const { parsed, stderr } = runCheck(tmpRepo, ["--changed-from", baseCommit, "services/api"]);
    const finding = parsed.findings.find(f => f.ruleId === "sql-no-drop-column");
    assert.ok(finding, `Expected sql-no-drop-column, got ${JSON.stringify(parsed.findings)}`);
    assert.equal(finding.level, "hard", `Expected the root policy level hard, got ${finding.level}`);
    assert.ok(
      stderr.includes("notice: using the policy in ./.archtour/ from the base branch"),
      `Expected the parent-policy notice, got: ${stderr}`
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// (i) The same lookup on the head side, and the PR cannot loosen its own rules.
test("T-109i: --policy-from head follows the parent policy, --policy-from base does not", (t) => {
  if (!hasGit()) {
    if (t?.skip) t.skip("git is unavailable");
    return;
  }
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "silent-subfolder-head-policy-"));
  try {
    gitInitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, ".archtour"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), POLICY_HARD);
    fs.mkdirSync(path.join(tmpRepo, "services", "api", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "services", "api", "migrations", "001.sql"), BASE_SQL);
    const baseCommit = gitCommitAll(tmpRepo, "base");

    fs.writeFileSync(path.join(tmpRepo, ".archtour", "rules.yml"), POLICY_OFF);
    fs.writeFileSync(path.join(tmpRepo, "services", "api", "migrations", "002.sql"), DROP_SQL);
    gitCommitAll(tmpRepo, "loosen the policy and add the dropping migration");

    const head = runCheck(tmpRepo, ["--changed-from", baseCommit, "services/api", "--policy-from", "head"]);
    assert.ok(
      !hasRule(head.parsed, "sql-no-drop-column"),
      `The head policy turns the rule off, got ${JSON.stringify(head.parsed.findings)}`
    );
    assert.ok(
      head.stderr.includes("notice: using the policy in ./.archtour/ from the PR (head)"),
      `Expected the head parent-policy notice, got: ${head.stderr}`
    );

    const base = runCheck(tmpRepo, ["--changed-from", baseCommit, "services/api", "--policy-from", "base"]);
    const finding = base.parsed.findings.find(f => f.ruleId === "sql-no-drop-column");
    assert.ok(finding, `Expected sql-no-drop-column from the base policy, got ${JSON.stringify(base.parsed.findings)}`);
    assert.equal(finding.level, "hard", `Expected the base policy level hard, got ${finding.level}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
