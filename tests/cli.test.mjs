import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve("tools/diagram.mjs");

test("tools/diagram.mjs --help runs successfully from a fresh temp directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-help-test-"));
  try {
    const res = spawnSync(process.execPath, [CLI, "--help"], {
      cwd: tmpDir,
      encoding: "utf8"
    });
    assert.equal(res.status, 0, `Expected exit status 0, got ${res.status}. stderr: ${res.stderr}`);
    assert.ok(
      res.stdout.includes("usage: archtour"),
      `Expected usage output, got: ${res.stdout}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("archtour help lists the guardrails commands with check first", () => {
  const r = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const order = ["check", "baseline", "audit-history", "diff-repo", "facts", "changes", "scan"];
  const listed = r.stdout
    .split("\n")
    .filter((line) => /^  \S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);
  assert.deepEqual(listed, order, "help output should list the guardrails commands in order, check first");
});

test("CLI scan with fixture --json writes valid spec JSON", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-scan-test-"));
  try {
    const prismaDir = path.join(tmp, "prisma");
    fs.mkdirSync(prismaDir);
    fs.writeFileSync(path.join(prismaDir, "schema.prisma"), "model User { id Int @id\nemail String }\n");
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  web:\n    image: nginx\n");
    fs.writeFileSync(path.join(tmp, "openapi.json"), JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test API" },
      paths: { "/items": { get: { summary: "List items" } } }
    }));
    fs.writeFileSync(path.join(tmp, "openapi.yaml"), "openapi: 3.0.0\n");

    const outJson = path.join(tmp, "x.json");
    const r = spawnSync(process.execPath, [CLI, "scan", tmp, "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    assert.ok(r.stdout.includes("found prisma/schema.prisma"));
    assert.ok(r.stdout.includes("found docker-compose.yml"));
    assert.ok(r.stdout.includes("found openapi.json"));
    assert.ok(r.stdout.includes("skipped openapi.yaml"));
    assert.ok(fs.existsSync(outJson));

    const spec = JSON.parse(fs.readFileSync(outJson, "utf8"));
    assert.equal(spec.nodes.length, 3);
    assert.equal(spec.edges.length, 0);
    assert.ok(spec.nodes.every(n => n.drill));
    assert.equal(spec.steps.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan on empty dir exits with error", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-scan-empty-"));
  try {
    const r = spawnSync(process.execPath, [CLI, "scan", tmp], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("No Prisma schema, Docker Compose file or OpenAPI JSON found under"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan with repeatable --ignore skips folders and prints skipped (ignored)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-scan-ignore-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model App { id Int @id }\n");
    const legacyDir = path.join(tmp, "legacy");
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "schema.prisma"), "model Legacy { id Int @id }\n");

    const outJson = path.join(tmp, "out.json");
    const r = spawnSync(process.execPath, [CLI, "scan", tmp, "--ignore", "legacy", "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    assert.ok(r.stdout.includes("found schema.prisma"));
    assert.ok(r.stdout.includes("skipped (ignored): legacy"));
    assert.equal(r.stdout.includes("found legacy/schema.prisma"), false);

    // Verify scan without any matching ignored folder does NOT mention "skipped (ignored)"
    const r2 = spawnSync(process.execPath, [CLI, "scan", tmp, "--ignore", "nonexistent-folder", "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.includes("skipped (ignored):"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI diff-repo -o x.md writes markdown with archtour-diff marker and exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-diff-md-test-"));
  try {
    const baseDir = path.join(tmp, "base");
    const headDir = path.join(tmp, "head");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(headDir, { recursive: true });

    fs.writeFileSync(
      path.join(baseDir, "compose.yml"),
      "services:\n  app:\n    image: node:20\n"
    );
    fs.writeFileSync(
      path.join(headDir, "compose.yml"),
      "services:\n  app:\n    image: node:22\n  redis:\n    image: redis:alpine\n"
    );

    const outFile = path.join(tmp, "x.md");
    const r = spawnSync(
      process.execPath,
      [CLI, "diff-repo", baseDir, headDir, "-o", outFile],
      { encoding: "utf8" }
    );

    assert.equal(r.status, 0, `diff-repo -o x.md failed: ${r.stderr}`);
    assert.ok(fs.existsSync(outFile));
    const content = fs.readFileSync(outFile, "utf8");
    assert.ok(
      content.includes("<!-- archtour-diff -->"),
      `Expected markdown to contain <!-- archtour-diff -->, got:\n${content}`
    );
    assert.ok(r.stdout.includes(`wrote ${outFile}`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI diff-repo -o x.json writes valid planned spec JSON and exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-diff-json-test-"));
  try {
    const baseDir = path.join(tmp, "base");
    const headDir = path.join(tmp, "head");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(headDir, { recursive: true });

    fs.writeFileSync(
      path.join(baseDir, "compose.yml"),
      "services:\n  app:\n    image: node:20\n"
    );
    fs.writeFileSync(
      path.join(headDir, "compose.yml"),
      "services:\n  app:\n    image: node:22\n  redis:\n    image: redis:alpine\n"
    );

    const outFile = path.join(tmp, "x.json");
    const r = spawnSync(
      process.execPath,
      [CLI, "diff-repo", baseDir, headDir, "-o", outFile],
      { encoding: "utf8" }
    );

    assert.equal(r.status, 0, `diff-repo -o x.json failed: ${r.stderr}`);
    assert.ok(fs.existsSync(outFile));
    const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.ok(parsed.title);
    assert.ok(Array.isArray(parsed.nodes));
    assert.ok(r.stdout.includes(`wrote ${outFile}`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI diff-repo -o x.txt exits non-zero with unsupported extension message", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-diff-txt-test-"));
  try {
    const baseDir = path.join(tmp, "base");
    const headDir = path.join(tmp, "head");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(headDir, { recursive: true });

    fs.writeFileSync(
      path.join(baseDir, "compose.yml"),
      "services:\n  app:\n    image: node:20\n"
    );
    fs.writeFileSync(
      path.join(headDir, "compose.yml"),
      "services:\n  app:\n    image: node:20\n"
    );

    const outFile = path.join(tmp, "x.txt");
    const r = spawnSync(
      process.execPath,
      [CLI, "diff-repo", baseDir, headDir, "-o", outFile],
      { encoding: "utf8" }
    );

    assert.notEqual(r.status, 0);
    assert.ok(
      r.stderr.includes("-o must end in .md or .json (got .txt)"),
      `Expected stderr to include error message, got:\n${r.stderr}`
    );
    assert.equal(fs.existsSync(outFile), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI diff-repo with --format md and -o d.md does not crash or overwrite with JSON", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-bug-test-"));
  try {
    const baseDir = path.join(tmp, "base");
    const headDir = path.join(tmp, "head");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(headDir, { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, "compose.yml"),
      "services:\n  app:\n    image: node:20\n"
    );
    fs.writeFileSync(
      path.join(headDir, "compose.yml"),
      "services:\n  app:\n    image: node:22\n  redis:\n    image: redis:alpine\n"
    );

    const outFile = path.join(tmp, "d.md");
    const r = spawnSync(
      process.execPath,
      [CLI, "diff-repo", baseDir, headDir, "--format", "md", "-o", outFile],
      { encoding: "utf8" }
    );
    assert.equal(r.status, 0, `diff-repo --format md -o d.md failed: ${r.stderr}`);
    assert.ok(fs.existsSync(outFile));
    const content = fs.readFileSync(outFile, "utf8");
    assert.ok(content.includes("<!-- archtour-diff -->"));
    assert.equal(fs.existsSync(path.join(tmp, "d.json")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan validates -o extension", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cli-ext-val-test-"));
  try {
    const prismaFile = path.join(tmp, "schema.prisma");
    fs.writeFileSync(prismaFile, "model Item { id Int @id }\n");

    const scanJsonOut = path.join(tmp, "scan.json");
    const rScanJson = spawnSync(
      process.execPath,
      [CLI, "scan", tmp, "-o", scanJsonOut],
      { encoding: "utf8" }
    );
    assert.equal(rScanJson.status, 0);
    assert.ok(fs.existsSync(scanJsonOut));

    const scanTxtOut = path.join(tmp, "scan.txt");
    const rScanTxt = spawnSync(
      process.execPath,
      [CLI, "scan", tmp, "-o", scanTxtOut],
      { encoding: "utf8" }
    );
    assert.notEqual(rScanTxt.status, 0);
    assert.ok(rScanTxt.stderr.includes("-o must end in .json (got .txt)"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan with --max-files truncates and reports partial scan warning to stderr", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scan-max-files-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model App { id Int @id }\n");
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(tmp, `dummy_${i}.txt`), "content");
    }

    const outJson = path.join(tmp, "out.json");
    const r = spawnSync(process.execPath, [CLI, "scan", tmp, "--max-files", "50", "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    assert.ok(r.stderr.includes("⚠️ Partial scan:"), `stderr should contain partial scan warning:\n${r.stderr}`);
    assert.ok(r.stderr.includes("raise --max-files"), `stderr should contain raise --max-files:\n${r.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan prints 'ignored by default: <n> dirs' and --include-tests includes them", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scan-default-ignores-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model App { id Int @id }\n");
    const fixDir = path.join(tmp, "fixtures");
    const exDir = path.join(tmp, "examples");
    fs.mkdirSync(fixDir);
    fs.mkdirSync(exDir);
    fs.writeFileSync(path.join(fixDir, "schema.prisma"), "model Fix { id Int @id }\n");
    fs.writeFileSync(path.join(exDir, "schema.prisma"), "model Ex { id Int @id }\n");

    const outJson = path.join(tmp, "out.json");
    const rDefault = spawnSync(process.execPath, [CLI, "scan", tmp, "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(rDefault.status, 0, `scan failed: ${rDefault.stderr}`);
    assert.ok(rDefault.stdout.includes("ignored by default: 2 dirs (use --include-tests to scan them)"), `stdout should contain default ignore line:\n${rDefault.stdout}`);

    const rInclude = spawnSync(process.execPath, [CLI, "scan", tmp, "--include-tests", "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(rInclude.status, 0, `scan failed: ${rInclude.stderr}`);
    assert.equal(rInclude.stdout.includes("ignored by default:"), false, `stdout should not contain default ignore line when --include-tests is passed:\n${rInclude.stdout}`);
    assert.ok(rInclude.stdout.includes("found fixtures/schema.prisma"));
    assert.ok(rInclude.stdout.includes("found examples/schema.prisma"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI scan on Helm-like YAML with template keys produces no stderr warning", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scan-helm-yaml-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model App { id Int @id }\n");
    fs.writeFileSync(
      path.join(tmp, "helm.yaml"),
      `openapi: 3.0.0
info:
  title: Helm Test
  version: 1.0.0
paths:
  /status:
    get:
      summary: Status
{{ .Values.server.host }}:
  port: 8080
`
    );

    const outJson = path.join(tmp, "out.json");
    const r = spawnSync(process.execPath, [CLI, "scan", tmp, "--json", "-o", outJson], { encoding: "utf8" });
    assert.equal(r.status, 0, `scan failed: ${r.stderr}`);
    assert.equal(r.stderr.includes("Warning: Keys with collection values will be stringified"), false);
    assert.equal(r.stderr.includes("Warning"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI refuses out == input for diff-repo and scan and leaves input unchanged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-no-overwrite-"));
  try {
    const prismaContent = "model User { id Int @id }\n";

    // 1. diff-repo
    const dirA = path.join(tmp, "repoA");
    const dirB = path.join(tmp, "repoB");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const fileA = path.join(dirA, "schema.prisma");
    fs.writeFileSync(fileA, prismaContent);
    fs.writeFileSync(path.join(dirB, "schema.prisma"), prismaContent);
    const rDiffRepo = spawnSync(process.execPath, [CLI, "diff-repo", dirA, dirB, "-o", fileA], { encoding: "utf8" });
    assert.equal(rDiffRepo.status, 1);
    assert.ok(rDiffRepo.stderr.includes("output file would overwrite input file"));
    assert.equal(fs.readFileSync(fileA, "utf8"), prismaContent);

    // 2. scan
    const scanDir = path.join(tmp, "scandir");
    fs.mkdirSync(scanDir);
    const scanInputFile = path.join(scanDir, "schema.prisma");
    fs.writeFileSync(scanInputFile, prismaContent);
    const rScan = spawnSync(process.execPath, [CLI, "scan", scanDir, "-o", scanInputFile], { encoding: "utf8" });
    assert.equal(rScan.status, 1);
    assert.ok(rScan.stderr.includes("output file would overwrite input file"));
    assert.equal(fs.readFileSync(scanInputFile, "utf8"), prismaContent);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI automatically creates missing output directories", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ensure-dir-"));
  try {
    const baseDir = path.join(tmp, "base");
    const headDir = path.join(tmp, "head");
    fs.mkdirSync(baseDir);
    fs.mkdirSync(headDir);
    fs.writeFileSync(path.join(baseDir, "compose.yml"), "services:\n  app:\n    image: node:20\n");
    fs.writeFileSync(path.join(headDir, "compose.yml"), "services:\n  app:\n    image: node:22\n");

    const nestedOut = path.join(tmp, "a", "b", "c", "out.md");
    assert.equal(fs.existsSync(path.dirname(nestedOut)), false);

    const r = spawnSync(process.execPath, [CLI, "diff-repo", baseDir, headDir, "-o", nestedOut], { encoding: "utf8" });
    assert.equal(r.status, 0, `Command failed: ${r.stderr}`);
    assert.ok(fs.existsSync(nestedOut), "Output file should be created in nested directory");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI facts prints architecture facts for a file or directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-facts-test-"));
  try {
    const file = path.join(tmp, "docker-compose.yml");
    fs.writeFileSync(
      file,
      "services:\n  web:\n    image: nginx:alpine\n    ports:\n      - '80:80'\n"
    );

    // File target with text summary
    const rFileText = spawnSync(process.execPath, [CLI, "facts", file], { encoding: "utf8" });
    assert.equal(rFileText.status, 0, `facts on file failed: ${rFileText.stderr}`);
    assert.ok(rFileText.stdout.includes("Architecture Facts"));
    assert.ok(rFileText.stdout.includes("Entities: 1"));
    assert.ok(rFileText.stdout.includes("service: 1"));

    // Directory target with --json
    const rDirJson = spawnSync(process.execPath, [CLI, "facts", tmp, "--json"], { encoding: "utf8" });
    assert.equal(rDirJson.status, 0, `facts on dir failed: ${rDirJson.stderr}`);
    const parsed = JSON.parse(rDirJson.stdout);
    assert.equal(parsed.entities.length, 1);
    assert.equal(parsed.entities[0].id, "service:web");
    assert.equal(parsed.entities[0].attrs.registry, "docker.io");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI changes reports typed change events between base and head directories", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "cli-changes-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "cli-changes-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: node:18\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: node:20\n    privileged: true\n"
    );

    // Test text output
    const rText = spawnSync(process.execPath, [CLI, "changes", tmpBase, tmpHead], { encoding: "utf8" });
    assert.equal(rText.status, 0, `changes text failed: ${rText.stderr}`);
    assert.ok(rText.stdout.includes("Architecture Changes"));
    assert.ok(rText.stdout.includes("service.image_changed"));
    assert.ok(rText.stdout.includes("service.privileged_enabled"));

    // Test JSON output
    const rJson = spawnSync(process.execPath, [CLI, "changes", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(rJson.status, 0, `changes json failed: ${rJson.stderr}`);
    const parsed = JSON.parse(rJson.stdout);
    assert.equal(parsed.events.length, 2);
    assert.ok(parsed.events.some(e => e.type === "service.image_changed"));
    assert.ok(parsed.events.some(e => e.type === "service.privileged_enabled"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("CLI changes validates directory existence and arguments", () => {
  const rMissingArgs = spawnSync(process.execPath, [CLI, "changes"], { encoding: "utf8" });
  assert.notEqual(rMissingArgs.status, 0);
  assert.ok(rMissingArgs.stderr.includes("missing inputs"));

  const rMissingDir = spawnSync(process.execPath, [CLI, "changes", "nonexistent_dir_1", "nonexistent_dir_2"], { encoding: "utf8" });
  assert.notEqual(rMissingDir.status, 0);
  assert.ok(rMissingDir.stderr.includes("does not exist"));
});

test("--version prints the package version", () => {
  const r = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version);
});

test("the CLI runs when started through a symlinked bin (npm on Linux/macOS)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-bin-link-"));
  try {
    const link = path.join(dir, "archtour");
    try {
      fs.symlinkSync(CLI, link, "file");
    } catch (err) {
      if (t?.skip) t.skip(`file symlinks need elevation here: ${err.code}`);
      return;
    }
    const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
