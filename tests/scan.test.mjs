import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepo } from "../tools/scan.mjs";

test("scanRepo extracts full architecture from fixture tree with prisma, compose, openapi.json, openapi.yaml and decoy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-tree-"));
  try {
    // 1. Prisma schema under prisma/
    const prismaDir = path.join(tmp, "prisma");
    fs.mkdirSync(prismaDir);
    fs.writeFileSync(
      path.join(prismaDir, "schema.prisma"),
      `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`
    );

    // 2. Docker compose file at root
    fs.writeFileSync(
      path.join(tmp, "docker-compose.yml"),
      `
version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    depends_on:
      - api
  api:
    image: node:20
    depends_on:
      - db
  db:
    image: postgres:16
`
    );

    // 3. OpenAPI JSON at root
    fs.writeFileSync(
      path.join(tmp, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Store API", version: "1.0.0" },
        paths: {
          "/products": {
            get: { summary: "List products", tags: ["Products"] },
            post: { summary: "Create product", tags: ["Products"] }
          },
          "/orders": {
            get: { summary: "List orders", tags: ["Orders"] }
          }
        }
      })
    );

    // 4. OpenAPI YAML at root (should be skipped with specific message)
    fs.writeFileSync(
      path.join(tmp, "openapi.yaml"),
      `
openapi: 3.0.0
info:
  title: YAML API
paths:
  /ping:
    get:
      summary: Ping
`
    );

    // 5. Decoy in node_modules/schema.prisma (must be ignored)
    const nmPrismaDir = path.join(tmp, "node_modules", "some-lib");
    fs.mkdirSync(nmPrismaDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmPrismaDir, "schema.prisma"),
      `
model Decoy {
  id Int @id
}
`
    );

    const result = scanRepo(tmp);
    const { spec, found, skipped } = result;

    // Found: prisma, docker-compose, openapi.json, openapi.yaml = 4
    assert.equal(found.length, 4);
    assert.equal(found[0].kind, "Database");
    assert.equal(found[0].path, "prisma/schema.prisma");
    assert.equal(found[1].kind, "Services");
    assert.equal(found[1].path, "docker-compose.yml");
    assert.equal(found[2].kind, "API");
    assert.equal(found[2].path, "openapi.json");
    assert.equal(found[3].kind, "API");
    assert.equal(found[3].path, "openapi.yaml");

    // Skipped: openapi.yaml is now supported and found
    assert.equal(skipped.length, 0);

    // Decoy in node_modules must not be present in found or skipped
    assert.equal(found.some(f => f.path.includes("node_modules")), false);
    assert.equal(skipped.some(s => s.path.includes("node_modules")), false);

    // Overview spec assertions
    const folderName = path.basename(tmp);
    assert.equal(spec.title, `${folderName} architecture`);
    assert.equal(spec.nodes.length, 4);
    assert.equal(spec.edges.length, 0);

    // Node labels & colours
    assert.equal(spec.nodes[0].label, "Database · 2 models\nprisma/schema.prisma");
    assert.equal(spec.nodes[0].color, "blue");
    assert.ok(spec.nodes[0].drill);
    assert.equal(spec.nodes[0].drill.title, "Database · prisma/schema.prisma");
    assert.ok(Array.isArray(spec.nodes[0].drill.nodes));

    assert.equal(spec.nodes[1].label, "Services · 3 containers\ndocker-compose.yml");
    assert.equal(spec.nodes[1].color, "violet");
    assert.ok(spec.nodes[1].drill);
    assert.equal(spec.nodes[1].drill.title, "Services · docker-compose.yml");
    assert.ok(Array.isArray(spec.nodes[1].drill.nodes));

    assert.equal(spec.nodes[2].label, "API · 3 routes\nopenapi.json");
    assert.equal(spec.nodes[2].color, "orange");
    assert.ok(spec.nodes[2].drill);
    assert.equal(spec.nodes[2].drill.title, "API · openapi.json");
    assert.ok(Array.isArray(spec.nodes[2].drill.nodes));

    assert.equal(spec.nodes[3].label, "API · 1 route\nopenapi.yaml");
    assert.equal(spec.nodes[3].color, "orange");
    assert.ok(spec.nodes[3].drill);
    assert.equal(spec.nodes[3].drill.title, "API · openapi.yaml");
    assert.ok(Array.isArray(spec.nodes[3].drill.nodes));

    // Steps: one per overview node in order Database, Services, API
    assert.equal(spec.steps.length, 4);
    assert.ok(spec.steps[0].title.includes("Database"));
    assert.ok(spec.steps[0].text.includes("model"));
    assert.ok(spec.steps[1].title.includes("Services"));
    assert.ok(spec.steps[1].text.includes("service"));
    assert.ok(spec.steps[2].title.includes("API"));
    assert.ok(spec.steps[2].text.includes("route"));
    assert.ok(spec.steps[3].title.includes("API"));
    assert.ok(spec.steps[3].text.includes("route"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo throws when nothing is found under directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-empty-"));
  try {
    assert.throws(
      () => scanRepo(tmp),
      new RegExp(`No Prisma schema, Docker Compose file or OpenAPI JSON found under ${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo records unparseable files in skipped", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-unparseable-"));
  try {
    // Valid prisma schema
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Account { id Int @id }\n");
    // Invalid docker compose without services
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "version: '3'\n# no services\n");
    // Invalid openapi json without endpoints
    fs.writeFileSync(path.join(tmp, "openapi.json"), JSON.stringify({ openapi: "3.0.0", info: { title: "Empty" } }));

    const { found, skipped } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "schema.prisma");

    assert.equal(skipped.length, 2);
    assert.ok(skipped.some(s => s.path === "docker-compose.yml"));
    assert.ok(skipped.some(s => s.path === "openapi.json"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo skips build, dist, out, vendor, .next, coverage directories", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-ignored-dirs-"));
  try {
    for (const dirName of [".git", "dist", "build", "out", "vendor", ".next", "coverage", ".turbo"]) {
      const sub = path.join(tmp, dirName);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "schema.prisma"), "model Sub { id Int @id }\n");
    }

    assert.throws(
      () => scanRepo(tmp),
      /No Prisma schema, Docker Compose file or OpenAPI JSON found under/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo handles compose.yml, compose.yaml, and docker-compose.yaml", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-compose-variants-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "compose.yaml"),
      "services:\n  worker:\n    image: worker:latest\n"
    );

    const { found } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "Services");
    assert.equal(found[0].path, "compose.yaml");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo stops and adds a skipped note when max file limit is reached", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-max-files-"));
  try {
    fs.writeFileSync(path.join(tmp, "a-schema.prisma"), "model M { id Int @id }\n");
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmp, `file${i}.txt`), "content");
    }

    const { found, skipped } = scanRepo(tmp, { maxFiles: 5 });
    assert.equal(found.length, 1);
    assert.ok(skipped.some(s => s.reason.includes("file limit")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo sets drilled spec titles and overview node labels with singular and plural counts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-counts-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Item { id Int @id }\n");
    fs.writeFileSync(path.join(tmp, "compose.yml"), "services:\n  app:\n    image: node:20\n");
    fs.writeFileSync(path.join(tmp, "openapi.json"), JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Single Route API" },
      paths: { "/health": { get: { summary: "Health check" } } }
    }));

    const { spec, found } = scanRepo(tmp);
    assert.equal(found.length, 3);

    // Database: 1 model -> "Database · 1 model\nschema.prisma"
    const dbNode = spec.nodes.find(n => n.id === "database");
    assert.ok(dbNode);
    assert.equal(dbNode.label, "Database · 1 model\nschema.prisma");
    assert.equal(dbNode.drill.title, "Database · schema.prisma");

    // Services: 1 container -> "Services · 1 container\ncompose.yml"
    const svcNode = spec.nodes.find(n => n.id === "services");
    assert.ok(svcNode);
    assert.equal(svcNode.label, "Services · 1 container\ncompose.yml");
    assert.equal(svcNode.drill.title, "Services · compose.yml");

    // API: 1 route -> "API · 1 route\nopenapi.json"
    const apiNode = spec.nodes.find(n => n.id === "api");
    assert.ok(apiNode);
    assert.equal(apiNode.label, "API · 1 route\nopenapi.json");
    assert.equal(apiNode.drill.title, "API · openapi.json");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo respects opts.ignore for folder names and relative paths", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-ignore-"));
  try {
    // 1. Root valid schema
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model User { id Int @id }\n");

    // 2. Folder to ignore by name: "legacy"
    const legacyDir = path.join(tmp, "legacy");
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "schema.prisma"), "model OldUser { id Int @id }\n");

    // 3. Folder to ignore by relative path: "tests/fixtures"
    const fixturesDir = path.join(tmp, "tests", "fixtures");
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(path.join(fixturesDir, "compose.yml"), "services:\n  test:\n    image: test\n");

    // 4. Nested valid folder: "packages/server"
    const pkgDir = path.join(tmp, "packages", "server");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "docker-compose.yml"), "services:\n  server:\n    image: app\n");

    const result = scanRepo(tmp, { ignore: ["legacy", "tests/fixtures"] });
    const { found, skipped, ignored } = result;

    // Found should only have the 2 non-ignored files
    assert.equal(found.length, 2);
    assert.equal(found[0].path, "schema.prisma");
    assert.equal(found[1].path, "packages/server/docker-compose.yml");

    // Ignored folders should be recorded in skipped and ignored
    assert.ok(skipped.some(s => s.path === "legacy" && s.reason === "ignored"));
    assert.ok(skipped.some(s => s.path === "tests/fixtures" && s.reason === "ignored"));
    assert.ok(ignored.includes("legacy"));
    assert.ok(ignored.includes("tests/fixtures"));

    // Neither legacy nor fixtures should have files in found
    assert.equal(found.some(f => f.path.startsWith("legacy/")), false);
    assert.equal(found.some(f => f.path.startsWith("tests/fixtures/")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo finds openapi.yaml and includes it as an API diagram", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-openapi-yaml-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "openapi.yaml"),
      `
openapi: 3.0.0
info:
  title: Users Service API
paths:
  /users:
    get:
      summary: List users
      tags:
        - Users
`
    );

    const { found, skipped, spec } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "API");
    assert.equal(found[0].path, "openapi.yaml");
    assert.equal(skipped.length, 0);

    const apiNode = spec.nodes.find(n => n.id === "api");
    assert.ok(apiNode);
    assert.equal(apiNode.label, "API · 1 route\nopenapi.yaml");
    assert.equal(apiNode.drill.title, "API · openapi.yaml");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo handles malformed YAML with clear error containing file name", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-malformed-yaml-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Account { id Int @id }\n");
    fs.writeFileSync(
      path.join(tmp, "openapi.yaml"),
      `
openapi: 3.0.0
paths:
  - invalid: yaml: { [ unclosed
`
    );

    const { found, skipped } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "schema.prisma");

    const skippedYaml = skipped.find(s => s.path === "openapi.yaml");
    assert.ok(skippedYaml, "malformed openapi.yaml must be recorded in skipped");
    assert.equal(skippedYaml.path, "openapi.yaml");
    assert.ok(skippedYaml.reason, "skipped entry must provide reason");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo finds schema at depth 10 with default maxDepth 12", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-depth10-"));
  try {
    const deepDir = path.join(tmp, "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "schema.prisma"), "model Deep { id Int @id }\n");

    const { found } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/schema.prisma");
    assert.equal(found[0].kind, "Database");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo ignores fixtures and examples by default and finds them with includeTests", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-default-ignores-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Root { id Int @id }\n");

    const fixDir = path.join(tmp, "fixtures");
    fs.mkdirSync(fixDir, { recursive: true });
    fs.writeFileSync(path.join(fixDir, "schema.prisma"), "model Fixture { id Int @id }\n");

    const exDir = path.join(tmp, "examples");
    fs.mkdirSync(exDir, { recursive: true });
    fs.writeFileSync(path.join(exDir, "docker-compose.yml"), "services:\n  ex:\n    image: ex\n");

    const testDir = path.join(tmp, "test");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "schema.prisma"), "model Test { id Int @id }\n");

    // Default: fixtures, examples, test are ignored
    const defaultRes = scanRepo(tmp);
    assert.equal(defaultRes.found.length, 1);
    assert.equal(defaultRes.found[0].path, "schema.prisma");
    assert.equal(defaultRes.defaultIgnoredDirs, 3);

    // With includeTests: true -> all found
    const incRes = scanRepo(tmp, { includeTests: true });
    assert.equal(incRes.found.length, 4);
    assert.equal(incRes.defaultIgnoredDirs, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo skips node_modules, dist, vendor, build, target, Pods, venv, etc.", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-heavy-dirs-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Main { id Int @id }\n");

    for (const dirName of ["node_modules", "dist", "vendor", "build", "out", "target", "coverage", "Pods", "venv", "__pycache__"]) {
      const sub = path.join(tmp, dirName);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "schema.prisma"), `model ${dirName.replace(/[^a-zA-Z0-9]/g, "")}Model { id Int @id }\n`);
    }

    const { found } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "schema.prisma");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo skips candidate files exceeding 5 MB with a reason", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-large-file-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Valid { id Int @id }\n");

    // 6 MB candidate file
    const largeFilePath = path.join(tmp, "huge-schema.prisma");
    const pad = " ".repeat(6 * 1024 * 1024);
    fs.writeFileSync(largeFilePath, "model Huge { id Int @id }\n" + pad);

    const { found, skipped } = scanRepo(tmp);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "schema.prisma");

    const skippedLarge = skipped.find(s => s.path === "huge-schema.prisma");
    assert.ok(skippedLarge, "huge-schema.prisma should be in skipped");
    assert.ok(skippedLarge.reason.includes("5 MB"), `Reason should mention 5 MB, got: ${skippedLarge.reason}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo parses Helm-like YAML with template keys without library warnings to stderr", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-helm-yaml-"));
  try {
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Base { id Int @id }\n");
    fs.writeFileSync(
      path.join(tmp, "helm-template.yaml"),
      `openapi: 3.0.0
info:
  title: Helm API
  version: 1.0.0
paths:
  /info:
    get:
      summary: Info
{{ .Values.custom.key }}:
  nested: value
`
    );

    const origStderrWrite = process.stderr.write;
    const capturedStderr = [];
    process.stderr.write = function (chunk, ...args) {
      capturedStderr.push(String(chunk));
      return origStderrWrite.apply(process.stderr, [chunk, ...args]);
    };

    try {
      const { found } = scanRepo(tmp);
      assert.ok(found.length >= 1);
    } finally {
      process.stderr.write = origStderrWrite;
    }

    const stderrStr = capturedStderr.join("");
    assert.equal(stderrStr.includes("Warning: Keys with collection values will be stringified"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("scanRepo records { path, error } in parseErrors for candidate files that fail to parse", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-parse-errors-"));
  try {
    // Valid prisma
    fs.writeFileSync(path.join(tmp, "schema.prisma"), "model Account { id Int @id }\n");
    // Invalid docker-compose
    fs.writeFileSync(path.join(tmp, "docker-compose.yml"), "services:\n  broken: [invalid yaml");
    // Invalid openapi json
    fs.writeFileSync(path.join(tmp, "openapi.json"), "{ invalid json");

    const result = scanRepo(tmp);
    assert.equal(result.found.length, 1);
    assert.equal(result.found[0].path, "schema.prisma");

    assert.ok(Array.isArray(result.parseErrors), "scanRepo should return parseErrors array");
    assert.equal(result.parseErrors.length, 2);

    const composeErr = result.parseErrors.find(e => e.path === "docker-compose.yml");
    const jsonErr = result.parseErrors.find(e => e.path === "openapi.json");

    assert.ok(composeErr, "docker-compose.yml parse error should be recorded");
    assert.ok(composeErr.error, "error message should be recorded");
    assert.ok(jsonErr, "openapi.json parse error should be recorded");
    assert.ok(jsonErr.error, "error message should be recorded");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
