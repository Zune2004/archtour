import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { auditHistory, isCandidateSource, isIgnoredPath, parseDiffTreeZ } from "../tools/history.mjs";

const CLI = path.resolve("tools/cli.mjs");

function hasGit() {
  try {
    const res = spawnSync("git", ["--version"]);
    return res.status === 0;
  } catch {
    return false;
  }
}

function listAllFiles(dir) {
  const result = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(current, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      result.push(rel);
      if (e.isDirectory()) {
        walk(full);
      }
    }
  }
  walk(dir);
  result.sort();
  return result;
}

const FIXED_ENV = {
  GIT_AUTHOR_NAME: "Alice TestAuthor",
  GIT_AUTHOR_EMAIL: "alice.author@example.com",
  GIT_COMMITTER_NAME: "Bob TestCommitter",
  GIT_COMMITTER_EMAIL: "bob.committer@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0"
};

function gitCmd(repoDir, args, input = null) {
  return execFileSync("git", args, {
    cwd: repoDir,
    env: { ...process.env, ...FIXED_ENV },
    input,
    encoding: "utf8"
  }).trim();
}

test("candidate detection and ignore defaults helper", () => {
  // Ignored directory paths
  assert.equal(isIgnoredPath("node_modules/pkg/compose.yml"), true);
  assert.equal(isIgnoredPath(".git/config"), true);
  assert.equal(isIgnoredPath(".github/workflows/ci.yml"), true);
  assert.equal(isIgnoredPath("tests/fixtures/compose.yml"), true);
  assert.equal(isIgnoredPath("test/schema.prisma"), true);
  assert.equal(isIgnoredPath("e2e/compose.yml"), true);
  assert.equal(isIgnoredPath("dist/bundle.js"), true);

  // Candidate sources
  assert.equal(isCandidateSource("docker-compose.yml"), true);
  assert.equal(isCandidateSource("compose.yaml"), true);
  assert.equal(isCandidateSource("docker-compose.prod.yml"), true);
  assert.equal(isCandidateSource("schema.prisma"), true);
  assert.equal(isCandidateSource("prisma/schema.prisma"), true);
  assert.equal(isCandidateSource("migrations/001_create_table.sql"), true);
  assert.equal(isCandidateSource("api/schema.graphql"), true);
  assert.equal(isCandidateSource("proto/service.proto"), true);
  assert.equal(isCandidateSource("openapi.json"), true);
  assert.equal(isCandidateSource("openapi.yaml"), true);

  // Non-candidate sources
  assert.equal(isCandidateSource("README.md"), false);
  assert.equal(isCandidateSource("src/index.js"), false);
  assert.equal(isCandidateSource(".gitignore"), false);
  assert.equal(isCandidateSource("node_modules/app/docker-compose.yml"), false);
  assert.equal(isCandidateSource("tests/test-compose.yml"), false);
});

test("parseDiffTreeZ parses NUL-separated git diff-tree output", () => {
  const sampleZ = "M\0docker-compose.yml\0A\0prisma/schema.prisma\0D\0old.json\0R100\0old-path.sql\0new-path.sql\0";
  const files = parseDiffTreeZ(sampleZ);

  assert.equal(files.length, 4);
  assert.deepEqual(files[0], { status: "M", path: "docker-compose.yml" });
  assert.deepEqual(files[1], { status: "A", path: "prisma/schema.prisma" });
  assert.deepEqual(files[2], { status: "D", path: "old.json" });
  assert.deepEqual(files[3], { status: "R", oldPath: "old-path.sql", newPath: "new-path.sql", path: "new-path.sql" });
});

if (!hasGit()) {
  test("audit-history git tests skipped because git is missing", (t) => {
    t.skip("git binary is not available");
  });
} else {
  test("audit-history 5-commit repository test with privacy, link generation, and zero repo modification", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-hist-5commit-"));
    try {
      // 1. Initialize git repo with fixed author info
      gitCmd(tmp, ["init", "-b", "main"]);
      gitCmd(tmp, ["config", "user.name", "Alice TestAuthor"]);
      gitCmd(tmp, ["config", "user.email", "alice.author@example.com"]);
      gitCmd(tmp, ["config", "commit.gpgSign", "false"]);

      // Commit 1: add compose
      fs.writeFileSync(
        path.join(tmp, "docker-compose.yml"),
        "version: '3.8'\nservices:\n  app:\n    image: nginx:alpine\n"
      );
      gitCmd(tmp, ["add", "docker-compose.yml"]);
      gitCmd(tmp, ["commit", "-m", "add compose"]);
      const c1 = gitCmd(tmp, ["rev-parse", "HEAD"]);

      // Commit 2: make a service privileged
      fs.writeFileSync(
        path.join(tmp, "docker-compose.yml"),
        "version: '3.8'\nservices:\n  app:\n    image: nginx:alpine\n    privileged: true\n"
      );
      gitCmd(tmp, ["add", "docker-compose.yml"]);
      gitCmd(tmp, ["commit", "-m", "make a service privileged"]);
      const c2 = gitCmd(tmp, ["rev-parse", "HEAD"]);

      // Commit 3: add a migration that drops a column
      fs.mkdirSync(path.join(tmp, "migrations"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "migrations", "001_drop_column.sql"),
        "ALTER TABLE users DROP COLUMN bio;\n"
      );
      gitCmd(tmp, ["add", "migrations/001_drop_column.sql"]);
      gitCmd(tmp, ["commit", "-m", "add a migration that drops a column"]);
      const c3 = gitCmd(tmp, ["rev-parse", "HEAD"]);

      // Commit 4: unrelated README change
      fs.writeFileSync(
        path.join(tmp, "README.md"),
        "# Test Project\nUnrelated documentation change.\n"
      );
      gitCmd(tmp, ["add", "README.md"]);
      gitCmd(tmp, ["commit", "-m", "unrelated README change"]);
      const c4 = gitCmd(tmp, ["rev-parse", "HEAD"]);

      // Commit 5: revert
      fs.writeFileSync(
        path.join(tmp, "docker-compose.yml"),
        "version: '3.8'\nservices:\n  app:\n    image: nginx:alpine\n"
      );
      gitCmd(tmp, ["add", "docker-compose.yml"]);
      gitCmd(tmp, ["commit", "-m", "revert privileged mode"]);
      const c5 = gitCmd(tmp, ["rev-parse", "HEAD"]);

      // Snapshot file list before running audit
      const filesBefore = listAllFiles(tmp);

      // Run auditHistory
      const repoUrl = "https://github.com/my-org/my-repo";
      const result = await auditHistory(tmp, { repoUrl });

      // Verify nothing written to the repo
      const filesAfter = listAllFiles(tmp);
      assert.deepEqual(filesAfter, filesBefore, "audit-history must never modify the repository or write files");

      // Verify findings on exactly the right commits
      const c1Findings = result.findings.filter(f => f.sha === c1);
      const c2Findings = result.findings.filter(f => f.sha === c2);
      const c3Findings = result.findings.filter(f => f.sha === c3);
      const c4Findings = result.findings.filter(f => f.sha === c4);
      const c5Findings = result.findings.filter(f => f.sha === c5);

      assert.equal(c1Findings.length, 0, "Commit 1 (add compose) must have 0 findings");
      assert.equal(c2Findings.length, 1, "Commit 2 (make privileged) must have 1 finding");
      assert.equal(c2Findings[0].ruleId, "no-privileged-containers");
      assert.equal(c2Findings[0].level, "hard");

      assert.ok(c3Findings.length >= 1, "Commit 3 (drop column) must have findings");
      assert.ok(c3Findings.some(f => f.ruleId === "sql-no-drop-column"), "Commit 3 flags sql-no-drop-column");

      assert.equal(c4Findings.length, 0, "Commit 4 (README change) must have 0 findings");
      assert.equal(c5Findings.length, 0, "Commit 5 (revert) must have 0 findings");

      // Verify README commit was skipped without candidate changes
      const c4CommitInfo = result.commits.find(c => c.sha === c4);
      assert.ok(c4CommitInfo, "Commit 4 must be recorded in scanned commits");
      assert.equal(c4CommitInfo.hasArchitectureChanges, false, "README commit must not have architecture changes");

      // Totals
      assert.equal(result.summary.commitsScanned, 5);
      assert.equal(result.summary.commitsWithArchitectureChanges, 3);
      assert.equal(result.summary.hard, 1);
      assert.ok(result.summary.soft >= 1);

      // Rule summary table
      assert.ok(result.rules.some(r => r.ruleId === "no-privileged-containers" && r.count === 1));
      assert.ok(result.rules.some(r => r.ruleId === "sql-no-drop-column"));

      // Privacy: Report contains no author names or emails
      const jsonOutput = JSON.stringify(result);
      assert.equal(jsonOutput.includes("Alice TestAuthor"), false, "JSON must not contain author name");
      assert.equal(jsonOutput.includes("alice.author@example.com"), false, "JSON must not contain author email");
      assert.equal(jsonOutput.includes("Bob TestCommitter"), false, "JSON must not contain committer name");
      assert.equal(jsonOutput.includes("bob.committer@example.com"), false, "JSON must not contain committer email");

      assert.equal(result.markdown.includes("Alice TestAuthor"), false, "Markdown must not contain author name");
      assert.equal(result.markdown.includes("alice.author@example.com"), false, "Markdown must not contain author email");
      assert.equal(result.markdown.includes("Bob TestCommitter"), false, "Markdown must not contain committer name");
      assert.equal(result.markdown.includes("bob.committer@example.com"), false, "Markdown must not contain committer email");

      // Commit links with --repo-url
      assert.ok(result.markdown.includes(`${repoUrl}/commit/${c2}`), "Markdown must contain commit link for C2");
      assert.ok(result.markdown.includes(`${repoUrl}/commit/${c3}`), "Markdown must contain commit link for C3");

      // 4. Test --max-commits limits the scan
      const resLimit2 = await auditHistory(tmp, { maxCommits: 2 });
      assert.equal(resLimit2.summary.commitsScanned, 2, "maxCommits 2 limits scan to 2 commits");
      assert.equal(resLimit2.findings.length, 0, "Newest 2 commits have no findings");

      const resLimit3 = await auditHistory(tmp, { maxCommits: 3 });
      assert.equal(resLimit3.summary.commitsScanned, 3, "maxCommits 3 limits scan to 3 commits");
      assert.ok(resLimit3.findings.some(f => f.sha === c3), "Scan of 3 commits includes C3 findings");
      assert.equal(resLimit3.findings.some(f => f.sha === c2), false, "Scan of 3 commits excludes C2 findings");

      // 5. Test CLI execution via tools/cli.mjs audit-history
      const cliJsonRes = spawnSync(process.execPath, [CLI, "audit-history", tmp, "--json"], { encoding: "utf8" });
      assert.equal(cliJsonRes.status, 0, `CLI audit-history failed: ${cliJsonRes.stderr}`);
      const parsedCliJson = JSON.parse(cliJsonRes.stdout);
      assert.equal(parsedCliJson.summary.commitsScanned, 5);
      assert.equal(parsedCliJson.summary.hard, 1);

      // Test CLI --md output
      const mdOutFile = path.join(os.tmpdir(), `archtour-test-md-${Date.now()}.md`);
      try {
        const cliMdRes = spawnSync(process.execPath, [CLI, "audit-history", tmp, "--md", mdOutFile], { encoding: "utf8" });
        assert.equal(cliMdRes.status, 0, `CLI audit-history with --md failed: ${cliMdRes.stderr}`);
        assert.ok(fs.existsSync(mdOutFile), "Markdown output file must exist");
        const writtenMd = fs.readFileSync(mdOutFile, "utf8");
        assert.ok(writtenMd.includes("Architecture History Audit"));
        assert.ok(writtenMd.includes("no-privileged-containers"));
      } finally {
        if (fs.existsSync(mdOutFile)) fs.unlinkSync(mdOutFile);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("audit-history on 300-commit generated repository completes in < 10 s", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-hist-300commit-"));
    try {
      gitCmd(tmp, ["init", "-b", "main"]);
      gitCmd(tmp, ["config", "user.name", "Alice TestAuthor"]);
      gitCmd(tmp, ["config", "user.email", "alice.author@example.com"]);
      gitCmd(tmp, ["config", "commit.gpgSign", "false"]);

      // Generate 300 commits fast using git fast-import
      let importStream = "";
      // Commit 1: initial compose
      importStream += `commit refs/heads/main\n`;
      importStream += `committer Generator <gen@example.com> 1700000000 +0000\n`;
      importStream += `data <<EOF\ncommit 1\nEOF\n`;
      importStream += `M 644 inline docker-compose.yml\n`;
      importStream += `data <<EOF\nversion: '3.8'\nservices:\n  app:\n    image: nginx:alpine\nEOF\n\n`;

      // Commit 2: privileged enabled (triggers rule)
      importStream += `commit refs/heads/main\n`;
      importStream += `committer Generator <gen@example.com> 1700000001 +0000\n`;
      importStream += `data <<EOF\ncommit 2\nEOF\n`;
      importStream += `M 644 inline docker-compose.yml\n`;
      importStream += `data <<EOF\nversion: '3.8'\nservices:\n  app:\n    image: nginx:alpine\n    privileged: true\nEOF\n\n`;

      // Commits 3..300: unrelated text changes in docs/
      for (let i = 3; i <= 300; i++) {
        importStream += `commit refs/heads/main\n`;
        importStream += `committer Generator <gen@example.com> ${1700000000 + i} +0000\n`;
        importStream += `data <<EOF\ncommit ${i}\nEOF\n`;
        importStream += `M 644 inline docs/note_${i}.txt\n`;
        importStream += `data <<EOF\nNote content for commit ${i}\nEOF\n\n`;
      }

      gitCmd(tmp, ["fast-import"], importStream);
      gitCmd(tmp, ["reset", "--hard", "main"]);

      // Measure auditHistory execution time
      const startTime = performance.now();
      const res = await auditHistory(tmp, { maxCommits: 500 });
      const elapsedMs = performance.now() - startTime;

      assert.equal(res.summary.commitsScanned, 300, "Must scan all 300 commits");
      assert.ok(res.findings.some(f => f.ruleId === "no-privileged-containers"), "Must find privileged container rule violation");
      assert.ok(elapsedMs < 10000, `Auditing 300 commits must take < 10 s (took ${(elapsedMs / 1000).toFixed(2)} s)`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
