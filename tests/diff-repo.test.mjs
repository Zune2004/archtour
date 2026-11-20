import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { diffRepo, formatRepoMarkdownDiff, createRepoVisualDiffSpec, truncateMarkdown } from "../tools/diff-repo.mjs";

const DIAGRAM_CLI = path.resolve("tools/diagram.mjs");

test("diff-repo on two folders: changed Prisma model -> markdown lists the field change", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-head-"));

  try {
    const basePrisma = path.join(tmpBase, "prisma");
    const headPrisma = path.join(tmpHead, "prisma");
    fs.mkdirSync(basePrisma, { recursive: true });
    fs.mkdirSync(headPrisma, { recursive: true });

    fs.writeFileSync(
      path.join(basePrisma, "schema.prisma"),
      `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
}
`
    );

    fs.writeFileSync(
      path.join(headPrisma, "schema.prisma"),
      `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  role  String
}
`
    );

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.hasChanges, true);
    assert.equal(result.modifiedSources.length, 1);
    assert.equal(result.modifiedSources[0].path, "prisma/schema.prisma");
    assert.ok(result.markdown.includes("+ role: String"), `Expected markdown to list "+ role: String", got:\n${result.markdown}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo on two folders: added compose file -> 'added source'", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-add-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-add-head-"));

  try {
    fs.writeFileSync(
      path.join(tmpBase, "schema.prisma"),
      "model Account { id Int @id }\n"
    );

    fs.writeFileSync(
      path.join(tmpHead, "schema.prisma"),
      "model Account { id Int @id }\n"
    );

    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      `services:
  web:
    image: nginx:alpine
  db:
    image: postgres:16
`
    );

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.hasChanges, true);
    assert.equal(result.addedSources.length, 1);
    assert.equal(result.addedSources[0].path, "docker-compose.yml");
    assert.ok(
      result.markdown.toLowerCase().includes("added source"),
      `Expected markdown to mention "added source", got:\n${result.markdown}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo on two folders: identical -> 'No architecture changes'", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-same-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-same-head-"));

  try {
    const schemaContent = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
}
`;
    fs.writeFileSync(path.join(tmpBase, "schema.prisma"), schemaContent);
    fs.writeFileSync(path.join(tmpHead, "schema.prisma"), schemaContent);

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.hasChanges, false);
    assert.equal(result.addedSources.length, 0);
    assert.equal(result.removedSources.length, 0);
    assert.equal(result.modifiedSources.length, 0);
    assert.ok(
      result.markdown.includes("No architecture changes"),
      `Expected markdown to say "No architecture changes", got:\n${result.markdown}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo reports removed sources", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-rem-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-rem-head-"));

  try {
    fs.writeFileSync(
      path.join(tmpBase, "schema.prisma"),
      "model User { id Int @id }\n"
    );
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: node:20\n"
    );

    fs.writeFileSync(
      path.join(tmpHead, "schema.prisma"),
      "model User { id Int @id }\n"
    );

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.hasChanges, true);
    assert.equal(result.removedSources.length, 1);
    assert.equal(result.removedSources[0].path, "docker-compose.yml");
    assert.ok(
      result.markdown.toLowerCase().includes("removed source"),
      `Expected markdown to mention "removed source", got:\n${result.markdown}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo respects ignore options for comma-separated string or array", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-ign-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-ign-head-"));

  try {
    const baseIgnored = path.join(tmpBase, "ignored-dir");
    const headIgnored = path.join(tmpHead, "ignored-dir");
    fs.mkdirSync(baseIgnored, { recursive: true });
    fs.mkdirSync(headIgnored, { recursive: true });

    fs.writeFileSync(path.join(baseIgnored, "schema.prisma"), "model Old { id Int @id }\n");
    fs.writeFileSync(path.join(headIgnored, "schema.prisma"), "model New { id Int @id }\n");

    const result = diffRepo(tmpBase, tmpHead, { ignore: "ignored-dir" });
    assert.equal(result.hasChanges, false);
    assert.ok(result.markdown.includes("No architecture changes"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo with temporary git repository, commits, and worktree", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-git-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-wt-"));

  try {
    const git = (args) => {
      const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
      }
      return res.stdout.trim();
    };

    git(["init"]);
    git(["config", "user.email", "tester@example.com"]);
    git(["config", "user.name", "Tester"]);

    // Initial commit (base): schema with User model
    fs.mkdirSync(path.join(repoDir, "prisma"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "prisma", "schema.prisma"),
      `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
}
`
    );
    git(["add", "."]);
    git(["commit", "-m", "initial schema"]);
    const baseCommit = git(["rev-parse", "HEAD"]);

    // Worktree for base
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    git(["worktree", "add", "--detach", worktreeDir, baseCommit]);

    // Make PR changes in head repo: add field to User and add docker-compose.yml
    fs.writeFileSync(
      path.join(repoDir, "prisma", "schema.prisma"),
      `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  status String  @default("active")
}
`
    );
    fs.writeFileSync(
      path.join(repoDir, "docker-compose.yml"),
      `services:
  api:
    image: node:22
`
    );
    git(["add", "."]);
    git(["commit", "-m", "update schema and add compose"]);

    const result = diffRepo(worktreeDir, repoDir, { format: "markdown" });

    assert.equal(result.hasChanges, true);
    assert.equal(result.modifiedSources.length, 1);
    assert.equal(result.addedSources.length, 1);

    // Verify changed Prisma model lists field change
    assert.ok(
      result.markdown.includes("+ status: String"),
      `Expected markdown to contain "+ status: String", got:\n${result.markdown}`
    );

    // Verify added compose file says added source
    assert.ok(
      result.markdown.toLowerCase().includes("added source"),
      `Expected markdown to mention "added source", got:\n${result.markdown}`
    );
    assert.ok(result.markdown.includes("docker-compose.yml"));

    // Cleanup worktree
    git(["worktree", "remove", "--force", worktreeDir]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("archtour diff-repo CLI command prints markdown and exits cleanly", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-cli-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-cli-head-"));

  try {
    fs.writeFileSync(path.join(tmpBase, "compose.yml"), "services:\n  app:\n    image: node:20\n");
    fs.writeFileSync(
      path.join(tmpHead, "compose.yml"),
      "services:\n  app:\n    image: node:22\n  redis:\n    image: redis:alpine\n"
    );

    const proc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--format", "markdown"],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0, `CLI failed with stderr:\n${proc.stderr}`);
    assert.ok(proc.stdout.includes("### 📊 Architecture Changes"));
    assert.ok(proc.stdout.includes("compose.yml"));

    // Test JSON format output
    const jsonProc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--format", "json"],
      { encoding: "utf8" }
    );
    assert.equal(jsonProc.status, 0);
    const parsed = JSON.parse(jsonProc.stdout);
    assert.equal(parsed.hasChanges, true);
    assert.equal(parsed.modifiedSources.length, 1);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("truncateMarkdown returns text unchanged when length <= max", () => {
  const shortText = "### Architecture Changes\n\nNo changes";
  assert.equal(truncateMarkdown(shortText, 100), shortText);
  assert.equal(truncateMarkdown(shortText, 60000), shortText);
  assert.equal(truncateMarkdown("", 100), "");
  assert.equal(truncateMarkdown(null, 100), null);
});

test("truncateMarkdown cuts at line boundary and appends truncation note when length > max", () => {
  const lines = [
    "### 📊 Architecture Changes",
    "- 🟢 Added Source A: src/components/Header.tsx",
    "- 🟢 Added Source B: src/components/Footer.tsx",
    "- 🟢 Added Source C: src/components/Sidebar.tsx",
    "- 🔴 Removed Source D: src/legacy/OldView.tsx",
  ];
  const md = lines.join("\n");

  const truncated = truncateMarkdown(md, 150);
  assert.ok(truncated.length <= 150, `Expected length <= 150, got ${truncated.length}`);
  assert.ok(
    truncated.endsWith("_Truncated: the full diff is in the workflow artifact._"),
    `Expected truncation suffix at end, got:\n${truncated}`
  );
  assert.ok(truncated.includes(lines[0]));
  assert.ok(truncated.includes(lines[1]));
  // Verify it cuts cleanly at a line boundary
  assert.ok(!truncated.includes(lines[2]));
});

test("truncateMarkdown handles single long line without newlines", () => {
  const longLine = "A".repeat(100);
  const truncated = truncateMarkdown(longLine, 70);
  assert.ok(truncated.length <= 70);
  assert.ok(truncated.endsWith("_Truncated: the full diff is in the workflow artifact._"));
});

test("diffRepo truncates markdown when exceeding custom maxMarkdownLength", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-trunc-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-trunc-head-"));

  try {
    fs.writeFileSync(path.join(tmpBase, "compose.yml"), "services:\n  web:\n    image: nginx:alpine\n");
    fs.writeFileSync(
      path.join(tmpHead, "compose.yml"),
      "services:\n  web:\n    image: nginx:latest\n  db:\n    image: postgres:16\n  cache:\n    image: redis:alpine\n"
    );

    const result = diffRepo(tmpBase, tmpHead, { maxMarkdownLength: 80 });
    assert.equal(result.hasChanges, true);
    assert.ok(result.markdown.length <= 80, `Expected length <= 80, got ${result.markdown.length}`);
    assert.ok(result.markdown.includes("_Truncated: the full diff is in the workflow artifact._"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diffRepo: footer appears exactly once with real URL and no <REPO_URL>, and Compose uses 'change'", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-footer-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-footer-head-"));

  try {
    // 1. Prisma schema
    fs.writeFileSync(path.join(tmpBase, "schema.prisma"), "model User { id Int @id\nemail String }\n");
    fs.writeFileSync(path.join(tmpHead, "schema.prisma"), "model User { id Int @id\nemail String\nrole String }\n");

    // 2. Compose file
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), "services:\n  db:\n    image: postgres:15\n");
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.hasChanges, true);
    assert.equal(result.modifiedSources.length, 2);

    // Verify footer appears exactly once with real repo URL
    const footerCount = (result.markdown.match(/\*Generated by \[Archtour\]/g) || []).length;
    assert.equal(footerCount, 1, `Expected footer to appear exactly once, got ${footerCount}`);
    assert.ok(result.markdown.includes("*Generated by [Archtour](https://github.com/Zune2004/archtour).*"));
    assert.equal(result.markdown.includes("<REPO_URL>"), false);

    // Verify Compose wording: says '~ db  ~1 change' instead of 'fields'
    assert.ok(result.markdown.includes("~ db  ~1 change"), `Expected '~ db  ~1 change' in markdown:\n${result.markdown}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("repro Bug 1: truncated scan produces no false Removed Sources and starts with partial-scan warning", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-repro1-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-repro1-head-"));

  try {
    // Both base and head have z/schema.prisma
    const baseZ = path.join(tmpBase, "z");
    const headZ = path.join(tmpHead, "z");
    fs.mkdirSync(baseZ, { recursive: true });
    fs.mkdirSync(headZ, { recursive: true });
    const schemaContent = "model User { id Int @id }\n";
    fs.writeFileSync(path.join(baseZ, "schema.prisma"), schemaContent);
    fs.writeFileSync(path.join(headZ, "schema.prisma"), schemaContent);

    // Head has 60 extra files in a/ so it exceeds maxFiles: 40; base has 20 files in a/
    const baseA = path.join(tmpBase, "a");
    const headA = path.join(tmpHead, "a");
    fs.mkdirSync(baseA, { recursive: true });
    fs.mkdirSync(headA, { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(baseA, `empty_${i}.txt`), "");
    }
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(headA, `empty_${i}.txt`), "");
    }

    const result = diffRepo(tmpBase, tmpHead, { maxFiles: 40, format: "markdown" });

    assert.equal(result.truncated, true);
    assert.equal(result.removedSources.length, 0);
    assert.equal(result.addedSources.length, 0);
    assert.equal(result.markdown.includes("Removed Sources"), false);
    assert.ok(result.markdown.includes("⚠️ Partial scan:"));
    assert.ok(result.markdown.includes("Removed/added sources are not reported; narrow 'paths' or raise --max-files."));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("truncated head with an actually removed source does not report removal (by design) but shows warning", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-repro2-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-repro2-head-"));

  try {
    // Base has a/old.prisma and z/schema.prisma
    const baseA = path.join(tmpBase, "a");
    const baseZ = path.join(tmpBase, "z");
    fs.mkdirSync(baseA, { recursive: true });
    fs.mkdirSync(baseZ, { recursive: true });
    fs.writeFileSync(path.join(baseA, "old.prisma"), "model Old { id Int @id }\n");
    fs.writeFileSync(path.join(baseZ, "schema.prisma"), "model User { id Int @id }\n");

    // Head actually removed a/old.prisma, keeps z/schema.prisma, but has 60 files in pad/ causing truncation
    const headPad = path.join(tmpHead, "pad");
    const headZ = path.join(tmpHead, "z");
    fs.mkdirSync(headPad, { recursive: true });
    fs.mkdirSync(headZ, { recursive: true });
    fs.writeFileSync(path.join(headZ, "schema.prisma"), "model User { id Int @id }\n");
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(headPad, `pad_${i}.txt`), "");
    }

    const result = diffRepo(tmpBase, tmpHead, { maxFiles: 40, format: "markdown" });

    assert.equal(result.truncated, true);
    assert.equal(result.removedSources.length, 0);
    assert.equal(result.markdown.includes("Removed Sources"), false);
    assert.ok(result.markdown.includes("⚠️ Partial scan:"));
    assert.ok(result.markdown.includes("Removed/added sources are not reported; narrow 'paths' or raise --max-files."));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo CLI command outputs partial-scan warning to stderr and markdown header", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-cli-trunc-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-cli-trunc-head-"));

  try {
    const baseA = path.join(tmpBase, "a");
    const headA = path.join(tmpHead, "a");
    fs.mkdirSync(baseA, { recursive: true });
    fs.mkdirSync(headA, { recursive: true });
    fs.writeFileSync(path.join(tmpBase, "schema.prisma"), "model User { id Int @id }\n");
    fs.writeFileSync(path.join(tmpHead, "schema.prisma"), "model User { id Int @id }\n");

    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(headA, `file_${i}.txt`), "");
    }

    const proc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--max-files", "40", "--format", "markdown"],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0);
    assert.ok(proc.stderr.includes("⚠️ Partial scan:"), `stderr should contain partial scan warning:\n${proc.stderr}`);
    assert.ok(proc.stdout.includes("⚠️ Partial scan:"), `stdout should contain partial scan warning:\n${proc.stdout}`);
    assert.equal(proc.stdout.includes("Removed Sources"), false);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo: head parse failure is shown as warning line, not 'Removed', and CLI exits with code 3", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-head-err-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-head-err-head-"));

  try {
    const basePrisma = path.join(tmpBase, "prisma");
    const headPrisma = path.join(tmpHead, "prisma");
    fs.mkdirSync(basePrisma, { recursive: true });
    fs.mkdirSync(headPrisma, { recursive: true });

    // Valid prisma in base
    fs.writeFileSync(path.join(basePrisma, "schema.prisma"), "model Account { id Int @id }\n");

    // Syntax error in head
    fs.writeFileSync(path.join(headPrisma, "schema.prisma"), "datasource db {\n provider = 'invalid'\n");

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.hasChanges, true);
    assert.equal(result.removedSources.length, 0, "Source that failed to parse in head must NOT be reported as removed");
    assert.ok(result.parseErrors.length > 0, "newHeadParseErrors should be recorded in parseErrors");
    assert.ok(result.markdown.includes("could not be parsed in this PR"), `Expected warning line in markdown:\n${result.markdown}`);
    assert.ok(result.markdown.includes("Skipped files"));
    assert.equal(result.markdown.includes("#### 🔴 Removed Sources"), false);
    assert.equal(result.markdown.includes("removed source"), false);

    // CLI exit code 3 test
    const proc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--format", "markdown"],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 3, `CLI should exit with code 3 on new head parse error, got ${proc.status}. stderr:\n${proc.stderr}`);
    assert.ok(proc.stdout.includes("could not be parsed in this PR"), `stdout should contain warning:\n${proc.stdout}`);
    assert.equal(proc.stdout.includes("#### 🔴 Removed Sources"), false);
    assert.equal(proc.stdout.includes("removed source"), false);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("diff-repo: parse failures on both sides are listed under 'Not compared' and do not trigger exit code 3", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-both-err-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-both-err-head-"));

  try {
    const brokenYaml = "services:\n  bad: [unclosed yaml";
    fs.writeFileSync(path.join(tmpBase, "docker-compose.yml"), brokenYaml);
    fs.writeFileSync(path.join(tmpHead, "docker-compose.yml"), brokenYaml);

    // Also a valid schema on both sides
    fs.writeFileSync(path.join(tmpBase, "schema.prisma"), "model User { id Int @id }\n");
    fs.writeFileSync(path.join(tmpHead, "schema.prisma"), "model User { id Int @id }\n");

    const result = diffRepo(tmpBase, tmpHead, { format: "markdown" });

    assert.equal(result.parseErrors.length, 0, "Failures on both sides are not new parse errors");
    assert.equal(result.bothParseFailures.length, 1);
    assert.ok(result.markdown.includes("Not compared"), `Expected 'Not compared' in markdown:\n${result.markdown}`);
    assert.ok(result.markdown.includes("docker-compose.yml"));

    // CLI exit code 0 when no new parse errors
    const proc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--format", "markdown"],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0, `CLI should exit with code 0, got ${proc.status}`);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("truncateMarkdown never cuts inside code spans, code blocks, or HTML comments", () => {
  // Test code block: cutting at a limit that falls inside the block must back up before it
  const linesWithCodeBlock = [
    "### 📊 Changes",
    "- Line 1",
    "```json",
    '{\n  "service": "web",\n  "status": "active"\n}',
    "```",
    "- Line 2"
  ].join("\n");

  const cutTargetInsideBlock = linesWithCodeBlock.indexOf('"status"');
  const truncatedBlock = truncateMarkdown(linesWithCodeBlock, cutTargetInsideBlock + 60);

  // Assert code block is not cut open
  const ticksCount = (truncatedBlock.replace(/_Truncated.*$/, "").match(/```/g) || []).length;
  assert.equal(ticksCount % 2, 0, `Code block fences must be balanced (closed), got ${ticksCount}`);

  // Test HTML comment: cutting at a limit that falls inside <!-- ... -->
  const linesWithComment = [
    "### 📊 Changes",
    "- Line 1",
    "<!--",
    "Multi-line hidden comment that should not be left open",
    "-->",
    "- Line 2"
  ].join("\n");

  const cutTargetInsideComment = linesWithComment.indexOf("Multi-line");
  const truncatedComment = truncateMarkdown(linesWithComment, cutTargetInsideComment + 60);

  const textBeforeSuffix = truncatedComment.replace(/_Truncated.*$/, "");
  const openComments = (textBeforeSuffix.match(/<!--/g) || []).length;
  const closeComments = (textBeforeSuffix.match(/-->/g) || []).length;
  assert.equal(openComments, closeComments, "HTML comment must not be left unclosed");
});

test("diffRepo returns result.summary containing { hasChanges, truncated, parseErrors, counts }", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-summary-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-summary-head-"));

  try {
    fs.writeFileSync(
      path.join(tmpBase, "schema.prisma"),
      "model User {\n  id Int @id\n}\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "schema.prisma"),
      "model User {\n  id Int @id\n  role String\n}\n"
    );

    const result = diffRepo(tmpBase, tmpHead, { format: "json" });
    assert.ok(result.summary, "result.summary should exist");
    assert.equal(result.summary.hasChanges, true);
    assert.equal(result.summary.truncated, false);
    assert.ok(Array.isArray(result.summary.parseErrors));
    assert.equal(result.summary.parseErrors.length, 0);
    assert.ok(result.summary.counts, "result.summary.counts should exist");
    assert.equal(result.summary.counts.modified, 1);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("--summary-json writes file and folder named 'No architecture changes' does not suppress changes", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-fakefolder-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-fakefolder-head-"));
  const summaryFile = path.join(tmpHead, "summary-output.json");

  try {
    const fakeDirBase = path.join(tmpBase, "No architecture changes");
    const fakeDirHead = path.join(tmpHead, "No architecture changes");
    fs.mkdirSync(fakeDirBase, { recursive: true });
    fs.mkdirSync(fakeDirHead, { recursive: true });

    fs.writeFileSync(
      path.join(fakeDirBase, "schema.prisma"),
      "model Setting {\n  id Int @id\n}\n"
    );
    fs.writeFileSync(
      path.join(fakeDirHead, "schema.prisma"),
      "model Setting {\n  id Int @id\n  key String\n}\n"
    );

    const proc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--format", "json", "--summary-json", summaryFile],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 0, `Process failed: ${proc.stderr}`);
    assert.ok(fs.existsSync(summaryFile), "summary file should be written");

    const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    assert.equal(summary.hasChanges, true, "hasChanges must be true despite 'No architecture changes' folder name");
    assert.equal(summary.counts.modified, 1);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("--summary-json is written even when head introduces new parse errors (exit code 3)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-err-summary-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "diff-repo-err-summary-head-"));
  const summaryFile = path.join(tmpHead, "err-summary.json");

  try {
    fs.writeFileSync(
      path.join(tmpBase, "schema.prisma"),
      "model Account { id Int @id }\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "schema.prisma"),
      "datasource db {\n provider = 'unclosed\n"
    );

    const proc = spawnSync(
      process.execPath,
      [DIAGRAM_CLI, "diff-repo", tmpBase, tmpHead, "--format", "json", "--summary-json", summaryFile],
      { encoding: "utf8" }
    );

    assert.equal(proc.status, 3, "Should exit with code 3 on new head parse error");
    assert.ok(fs.existsSync(summaryFile), "summary JSON file must still be written when exiting with code 3");

    const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    assert.equal(summary.hasChanges, true);
    assert.equal(summary.parseErrors.length, 1);
    assert.equal(summary.parseErrors[0].path, "schema.prisma");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});
