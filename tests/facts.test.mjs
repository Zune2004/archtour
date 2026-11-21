import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { extractFacts } from "../tools/facts.mjs";
import { diffFacts } from "../tools/facts-diff.mjs";

const CLI = path.resolve("tools/cli.mjs");

// 1. Prisma extraction
test("extractFacts extracts db.model, db.field, and db.relation from Prisma schema", () => {
  const schema = `
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

model User {
  id      Int      @id @default(autoincrement())
  email   String   @unique
  bio     String?
  posts   Post[]
  profile Profile?
}

model Post {
  id       Int    @id
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}

model Profile {
  id     Int  @id
  user   User @relation(fields: [userId], references: [id])
  userId Int
}
`;

  const facts = extractFacts([{ path: "schema.prisma", content: schema }]);

  assert.equal(facts.errors.length, 0);
  assert.equal(facts.sources.length, 1);
  assert.equal(facts.sources[0].kind, "Database");

  // Models
  const userModel = facts.entities.find(e => e.id === "db.model:User");
  assert.ok(userModel);
  assert.equal(userModel.kind, "db.model");
  assert.equal(userModel.name, "User");
  assert.equal(userModel.source.file, "schema.prisma");
  assert.equal(userModel.source.line, 7);
  assert.deepEqual(userModel.attrs, { name: "User" });

  const postModel = facts.entities.find(e => e.id === "db.model:Post");
  assert.ok(postModel);

  // Fields
  const idField = facts.entities.find(e => e.id === "db.field:User.id");
  assert.ok(idField);
  assert.equal(idField.kind, "db.field");
  assert.deepEqual(idField.attrs, {
    model: "User",
    name: "id",
    type: "Int",
    optional: false,
    list: false,
    id: true,
    unique: false,
    default: true
  });

  const emailField = facts.entities.find(e => e.id === "db.field:User.email");
  assert.ok(emailField);
  assert.deepEqual(emailField.attrs, {
    model: "User",
    name: "email",
    type: "String",
    optional: false,
    list: false,
    id: false,
    unique: true,
    default: false
  });

  const bioField = facts.entities.find(e => e.id === "db.field:User.bio");
  assert.ok(bioField);
  assert.equal(bioField.attrs.optional, true);

  const postsField = facts.entities.find(e => e.id === "db.field:User.posts");
  assert.ok(postsField);
  assert.equal(postsField.attrs.list, true);

  // Relations
  const userPostRel = facts.relations.find(
    r => r.kind === "db.relation" && r.from === "User" && r.to === "Post"
  );
  assert.ok(userPostRel);
  assert.equal(userPostRel.cardinality, "1:N");

  const userProfileRel = facts.relations.find(
    r => r.kind === "db.relation" && ((r.from === "User" && r.to === "Profile") || (r.from === "Profile" && r.to === "User"))
  );
  assert.ok(userProfileRel);
  assert.equal(userProfileRel.cardinality, "1:1");
});

// 2. Compose extraction
test("extractFacts extracts service entities, attributes and service.depends_on from Docker Compose", () => {
  const compose = `
version: "3.8"
services:
  web:
    image: nginx:alpine
    build: ./web
    privileged: true
    network_mode: host
    cap_add:
      - SYS_ADMIN
      - NET_ADMIN
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
      - /etc/configs:/etc/configs
    environment:
      - NODE_ENV=production
      - API_SECRET=ultra_secret_value_12345
    ports:
      - "80:80"
      - "0.0.0.0:443:443"
      - "127.0.0.1:8080:8080"
      - "53:53/udp"
    depends_on:
      - api
  api:
    image: ghcr.io/myorg/backend:v2.0
    ports:
      - 3000
`;

  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);

  assert.equal(facts.errors.length, 0);
  assert.equal(facts.sources.length, 1);

  const web = facts.entities.find(e => e.id === "service:web");
  assert.ok(web);
  assert.equal(web.kind, "service");
  assert.equal(web.attrs.name, "web");
  assert.equal(web.attrs.image, "nginx:alpine");
  assert.equal(web.attrs.registry, "docker.io");
  assert.equal(web.attrs.build, true);
  assert.equal(web.attrs.privileged, true);
  assert.equal(web.attrs.networkModeHost, true);
  assert.deepEqual(web.attrs.capAdd, ["SYS_ADMIN", "NET_ADMIN"]);
  assert.deepEqual(web.attrs.hostMounts, ["/var/run/docker.sock", "./data", "/etc/configs"]);
  assert.equal(web.attrs.dockerSocket, true);
  assert.deepEqual(web.attrs.envNames, ["NODE_ENV", "API_SECRET"]);

  // Verify ports
  const p80 = web.attrs.ports.find(p => p.container === "80");
  assert.ok(p80);
  assert.equal(p80.host, "80");
  assert.equal(p80.published, true);
  assert.equal(p80.bindAll, true);

  const p443 = web.attrs.ports.find(p => p.container === "443");
  assert.ok(p443);
  assert.equal(p443.host, "443");
  assert.equal(p443.published, true);
  assert.equal(p443.bindAll, true);

  const p8080 = web.attrs.ports.find(p => p.container === "8080");
  assert.ok(p8080);
  assert.equal(p8080.host, "8080");
  assert.equal(p8080.published, true);
  assert.equal(p8080.bindAll, false); // bound specifically to 127.0.0.1

  const p53 = web.attrs.ports.find(p => p.container === "53");
  assert.ok(p53);
  assert.equal(p53.protocol, "udp");

  // Registry for api service
  const api = facts.entities.find(e => e.id === "service:api");
  assert.ok(api);
  assert.equal(api.attrs.registry, "ghcr.io");
  assert.equal(api.attrs.ports[0].published, false);
  assert.equal(api.attrs.ports[0].container, "3000");

  // Relation
  const depRel = facts.relations.find(
    r => r.kind === "service.depends_on" && r.from === "web" && r.to === "api"
  );
  assert.ok(depRel);
});

// 3. OpenAPI extraction
test("extractFacts extracts api.route entities and attributes from OpenAPI JSON and YAML", () => {
  const openapiYaml = `
openapi: "3.0.0"
info:
  title: Users API
  version: "1.0.0"
paths:
  /users/{id}:
    parameters:
      - name: id
        in: path
        required: true
    get:
      operationId: getUserById
      tags:
        - Users
      security:
        - BearerAuth: []
    delete:
      operationId: deleteUser
      tags:
        - Users
      security: []
  /users:
    post:
      operationId: createUser
      tags:
        - Users
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required:
                - email
                - name
              properties:
                email:
                  type: string
                name:
                  type: string
`;

  const facts = extractFacts([{ path: "openapi.yaml", content: openapiYaml }]);
  assert.equal(facts.errors.length, 0);

  // T-103: route identity is matched on a normalized path ({param} -> {}), so a parameter rename
  // is not a removal. Path text itself is still kept in name/attrs.path.
  const getRoute = facts.entities.find(e => e.id === "api.route:GET /users/{}");
  assert.ok(getRoute);
  assert.equal(getRoute.name, "GET /users/{id}", "route name keeps the original path text");
  assert.equal(getRoute.attrs.method, "GET");
  assert.equal(getRoute.attrs.path, "/users/{id}");
  assert.equal(getRoute.attrs.operationId, "getUserById");
  assert.deepEqual(getRoute.attrs.tags, ["Users"]);
  assert.deepEqual(getRoute.attrs.requiredParams, ["id"]);
  assert.equal(getRoute.attrs.security, true);

  const deleteRoute = facts.entities.find(e => e.id === "api.route:DELETE /users/{}");
  assert.ok(deleteRoute);
  assert.equal(deleteRoute.attrs.security, false);

  const postRoute = facts.entities.find(e => e.id === "api.route:POST /users");
  assert.ok(postRoute);
  assert.deepEqual(postRoute.attrs.requestRequired, ["email", "name"]);
});

// 4. Secret values never appear in output
test("env VALUES never appear anywhere in the output facts or diffs", () => {
  const secretKey = "super_classified_secret_key_99999";
  const secretDbUri = "postgres://admin:my_secret_password_88888@db:5432/main";
  const compose = `
version: "3.8"
services:
  db:
    image: postgres:15
    environment:
      - DB_SECRET=${secretKey}
      - DATABASE_URL=${secretDbUri}
`;

  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const serializedFacts = JSON.stringify(facts);

  assert.equal(serializedFacts.includes(secretKey), false, "secretKey should not appear in facts");
  assert.equal(serializedFacts.includes(secretDbUri), false, "secretDbUri should not appear in facts");
  assert.equal(serializedFacts.includes("my_secret_password_88888"), false, "password should not appear in facts");
  assert.ok(serializedFacts.includes("DB_SECRET"), "env name should appear");
  assert.ok(serializedFacts.includes("DATABASE_URL"), "env name should appear");

  const diff = diffFacts({}, facts);
  const serializedDiff = JSON.stringify(diff);
  assert.equal(serializedDiff.includes(secretKey), false, "secretKey should not appear in diff");
  assert.equal(serializedDiff.includes(secretDbUri), false, "secretDbUri should not appear in diff");
});

// 5. Duplicate names -> suffixed ids + warning
test("duplicate entity names produce deterministic suffixed ids and warnings in errors", () => {
  const file1 = {
    path: "compose1.yml",
    content: `
services:
  app:
    image: node:20
`
  };
  const file2 = {
    path: "compose2.yml",
    content: `
services:
  app:
    image: node:22
`
  };

  const facts = extractFacts([file1, file2]);
  const app1 = facts.entities.find(e => e.id === "service:app");
  const app2 = facts.entities.find(e => e.id === "service:app-2");

  assert.ok(app1, "first entity has id service:app");
  assert.ok(app2, "second entity has suffixed id service:app-2");
  assert.ok(facts.errors.length > 0, "errors list contains warning for duplicate id");
  assert.ok(facts.errors.some(e => e.message && e.message.includes("Duplicate entity id \"service:app\"")));
});

// 6. Compose privileged accepts YAML 1.1 booleans and interpolation, with fail-closed bare ${VAR}
test("compose privileged accepts YAML 1.1 booleans and interpolation, bare ${VAR} is privileged", () => {
  const cases = [
    { privileged: "yes", expected: true },
    { privileged: "on", expected: true },
    { privileged: "y", expected: true },
    { privileged: "true", expected: true },
    { privileged: true, expected: true },
    { privileged: "no", expected: false },
    { privileged: "off", expected: false },
    { privileged: "false", expected: false },
    { privileged: false, expected: false },
    { privileged: "${PRIV:-true}", expected: true },
    { privileged: "${PRIV:-false}", expected: false },
    { privileged: "${PRIV:-on}", expected: true },
    { privileged: "${PRIV}", expected: true },
    { privileged: "${PRIV-", expected: false }
  ];
  for (const { privileged, expected } of cases) {
    const compose = `services:\n  app:\n    image: alpine\n    privileged: ${JSON.stringify(privileged)}`;
    const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
    const svc = facts.entities.find(e => e.kind === "service");
    assert.ok(svc, "service entity not found");
    assert.equal(svc.attrs.privileged, expected, `privileged=${JSON.stringify(privileged)} expected ${expected}`);
  }
});

// 7. Truncated scan -> no added/removed events
test("truncated scan suppresses added and removed events by absence", () => {
  const baseFacts = extractFacts([
    {
      path: "schema.prisma",
      content: `
model User {
  id Int @id
}
`
    }
  ]);

  const headFacts = extractFacts([
    {
      path: "schema.prisma",
      content: `
model Order {
  id Int @id
}
`
    }
  ]);

  // Normal diff: produces added (Order) and removed (User)
  const normalDiff = diffFacts(baseFacts, headFacts);
  assert.ok(normalDiff.events.some(e => e.type === "db.model_removed"));
  assert.ok(normalDiff.events.some(e => e.type === "entity.added"));

  // Truncated diff: no added or removed events
  const truncatedBase = { ...baseFacts, truncated: true };
  const truncatedDiff = diffFacts(truncatedBase, headFacts);
  assert.equal(truncatedDiff.summary.truncated, true);
  assert.equal(truncatedDiff.events.length, 0);
});

// 7. Each event type produced by a minimal base/head pair (all 21 types!)
test("minimal base/head pairs produce each of the 21 specified event types", () => {
  // 1. entity.added
  {
    const base = extractFacts([]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  worker:\n    image: redis" }]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "entity.added"), "entity.added not produced");
  }

  // 2. entity.removed
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  worker:\n    image: redis" }]);
    const head = extractFacts([]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "entity.removed"), "entity.removed not produced");
  }

  // 3. service.image_changed
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: nginx:1.20" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: nginx:1.21" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.image_changed");
    assert.ok(ev, "service.image_changed not produced");
    assert.equal(ev.before, "nginx:1.20");
    assert.equal(ev.after, "nginx:1.21");
    assert.ok(ev.message.includes("Service 'app' image changed"));
  }

  // 4. service.registry_changed
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: myapp:1.0" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: ghcr.io/myapp:1.0" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.registry_changed");
    assert.ok(ev, "service.registry_changed not produced");
    assert.equal(ev.before, "docker.io");
    assert.equal(ev.after, "ghcr.io");
  }

  // 5. service.privileged_enabled
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine\n    privileged: false" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine\n    privileged: true" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.privileged_enabled");
    assert.ok(ev, "service.privileged_enabled not produced");
  }

  // 6. service.host_network_enabled
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine\n    network_mode: host" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.host_network_enabled");
    assert.ok(ev, "service.host_network_enabled not produced");
  }

  // 7. service.docker_socket_mounted
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.docker_socket_mounted");
    assert.ok(ev, "service.docker_socket_mounted not produced");
  }

  // 8. service.host_mount_added
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine\n    volumes:\n      - /host/data:/app/data" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.host_mount_added");
    assert.ok(ev, "service.host_mount_added not produced");
    assert.equal(ev.after, "/host/data");
  }

  // 9. service.port_published
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  app:\n    image: alpine\n    ports:\n      - '8080:80'" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.port_published");
    assert.ok(ev, "service.port_published not produced");
    assert.ok(ev.message.includes("8080:80/tcp"));
    assert.ok(ev.message.includes("all interfaces"));
  }

  // 10. service.dependency_added
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  web:\n    image: nginx\n  db:\n    image: postgres" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  web:\n    image: nginx\n    depends_on:\n      - db\n  db:\n    image: postgres" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.dependency_added");
    assert.ok(ev, "service.dependency_added not produced");
    assert.equal(ev.after, "db");
  }

  // 11. service.dependency_removed
  {
    const base = extractFacts([{ path: "compose.yml", content: "services:\n  web:\n    image: nginx\n    depends_on:\n      - db\n  db:\n    image: postgres" }]);
    const head = extractFacts([{ path: "compose.yml", content: "services:\n  web:\n    image: nginx\n  db:\n    image: postgres" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "service.dependency_removed");
    assert.ok(ev, "service.dependency_removed not produced");
    assert.equal(ev.before, "db");
  }

  // 12. db.model_removed
  {
    const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n}\nmodel OldModel {\n  id Int @id\n}" }]);
    const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n}" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "db.model_removed");
    assert.ok(ev, "db.model_removed not produced");
    assert.equal(ev.before, "OldModel");
  }

  // 13. db.field_removed
  {
    const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  email String\n}" }]);
    const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n}" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "db.field_removed");
    assert.ok(ev, "db.field_removed not produced");
    assert.equal(ev.before, "User.email");
  }

  // 14. db.field_type_changed
  {
    const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  count Int\n}" }]);
    const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  count BigInt\n}" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "db.field_type_changed");
    assert.ok(ev, "db.field_type_changed not produced");
    assert.equal(ev.before, "Int");
    assert.equal(ev.after, "BigInt");
  }

  // 15. db.field_made_required (optional -> required)
  {
    const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio String?\n}" }]);
    const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio String\n}" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "db.field_made_required");
    assert.ok(ev, "db.field_made_required not produced");
    assert.equal(ev.before, "optional");
    assert.equal(ev.after, "required");
  }

  // 16. db.field_unique_added
  {
    const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  handle String\n}" }]);
    const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  handle String @unique\n}" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "db.field_unique_added");
    assert.ok(ev, "db.field_unique_added not produced");
  }

  // 17. api.route_removed
  {
    const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/old": { get: {} } } }) }]);
    const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: {} }) }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "api.route_removed");
    assert.ok(ev, "api.route_removed not produced");
  }

  // 18. api.route_added
  {
    const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: {} }) }]);
    const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/new": { post: {} } } }) }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "api.route_added");
    assert.ok(ev, "api.route_added not produced");
  }

  // 19. api.param_required_added
  {
    const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({
      openapi: "3.0.0",
      paths: { "/items": { get: { parameters: [{ name: "filter", in: "query", required: false }] } } }
    }) }]);
    const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({
      openapi: "3.0.0",
      paths: { "/items": { get: { parameters: [{ name: "filter", in: "query", required: true }] } } }
    }) }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "api.param_required_added");
    assert.ok(ev, "api.param_required_added not produced");
    assert.equal(ev.after, "filter");
  }

  // 20. api.request_required_added
  {
    const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({
      openapi: "3.0.0",
      paths: { "/users": { post: { requestBody: { content: { "application/json": { schema: { required: ["email"] } } } } } } }
    }) }]);
    const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({
      openapi: "3.0.0",
      paths: { "/users": { post: { requestBody: { content: { "application/json": { schema: { required: ["email", "password"] } } } } } } }
    }) }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "api.request_required_added");
    assert.ok(ev, "api.request_required_added not produced");
    assert.equal(ev.after, "password");
  }

  // 21. api.security_removed
  {
    const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({
      openapi: "3.0.0",
      paths: { "/secure": { get: { security: [{ bearerAuth: [] }] } } }
    }) }]);
    const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({
      openapi: "3.0.0",
      paths: { "/secure": { get: { security: [] } } }
    }) }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "api.security_removed");
    assert.ok(ev, "api.security_removed not produced");
  }
});

// 8. 2,000-entity fixture extracts and diffs in < 2 s
test("a 2,000-entity fixture extracts and diffs in < 2 s", () => {
  // Generate 500 models, each with 3 fields = 2000 entities
  const modelLines = [];
  for (let i = 0; i < 500; i++) {
    modelLines.push(`model Model${i} {
  id Int @id @default(autoincrement())
  name String
  count Int
}`);
  }
  const basePrisma = modelLines.join("\n\n");

  // Head has Model250 type changed and Model499 removed, plus Model500 added
  const headLines = modelLines.slice(0, 499);
  headLines[250] = headLines[250].replace("count Int", "count BigInt");
  headLines.push(`model Model500 {\n  id Int @id\n  extra String\n}`);
  const headPrisma = headLines.join("\n\n");

  const t0 = performance.now();
  const baseFacts = extractFacts([{ path: "schema.prisma", content: basePrisma }]);
  const headFacts = extractFacts([{ path: "schema.prisma", content: headPrisma }]);

  assert.equal(baseFacts.entities.length, 2000, `Expected 2000 base entities, got ${baseFacts.entities.length}`);

  const diff = diffFacts(baseFacts, headFacts);
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  assert.ok(elapsedMs < 2000, `Expected extract + diff in < 2000 ms, took ${elapsedMs.toFixed(1)} ms`);
  assert.ok(diff.events.some(e => e.type === "db.field_type_changed"));
  assert.ok(diff.events.some(e => e.type === "db.model_removed"));
  assert.ok(diff.events.some(e => e.type === "entity.added"));
});

// 9. CLI changes --json on two temp dirs
test("CLI changes --json on two temp dirs prints valid change events", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "facts-cli-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "facts-cli-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx:1.20\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "docker-compose.yml"),
      "services:\n  app:\n    image: nginx:1.21\n"
    );

    const r = spawnSync(process.execPath, [CLI, "changes", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `CLI changes failed: ${r.stderr}`);

    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.events));
    assert.ok(parsed.events.some(e => e.type === "service.image_changed"));
    assert.equal(parsed.events[0].before, "nginx:1.20");
    assert.equal(parsed.events[0].after, "nginx:1.21");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 10. New required field in Prisma schema does NOT emit db.field_made_required (change-only events don't fire for new entities)
test("new required field does not emit db.field_made_required", () => {
  const base = extractFacts([{ path: "schema.prisma", content: "model Claim {\n  id Int @id\n}\n" }]);
  const head = extractFacts([{ path: "schema.prisma", content: "model Claim {\n  id Int @id\n  envelopeContentCount Int\n}\n" }]);
  const diff = diffFacts(base, head);
  const madeRequired = diff.events.filter(e => e.type === "db.field_made_required");
  assert.equal(madeRequired.length, 0, "New required field should NOT emit db.field_made_required");
});

// 11. Existing optional field made required DOES emit db.field_made_required
test("existing optional field made required emits db.field_made_required", () => {
  const base = extractFacts([{ path: "schema.prisma", content: "model Claim {\n  id Int @id\n  envelopeContentCount Int?\n}\n" }]);
  const head = extractFacts([{ path: "schema.prisma", content: "model Claim {\n  id Int @id\n  envelopeContentCount Int\n}\n" }]);
  const diff = diffFacts(base, head);
  const madeRequired = diff.events.filter(e => e.type === "db.field_made_required");
  assert.equal(madeRequired.length, 1, "Existing optional->required field SHOULD emit db.field_made_required");
  assert.equal(madeRequired[0].entityId, "db.field:Claim.envelopeContentCount");
});

// 12. New field type change does NOT emit db.field_type_changed (change-only event for new entity)
test("new field type change does not emit db.field_type_changed", () => {
  const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n}\n" }]);
  const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio String\n}\n" }]);
  const diff = diffFacts(base, head);
  const typeChanged = diff.events.filter(e => e.type === "db.field_type_changed");
  assert.equal(typeChanged.length, 0, "New field type should NOT emit db.field_type_changed");
});

// 13. Existing field type change DOES emit db.field_type_changed
test("existing field type change emits db.field_type_changed", () => {
  const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio String\n}\n" }]);
  const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  bio Text\n}\n" }]);
  const diff = diffFacts(base, head);
  const typeChanged = diff.events.filter(e => e.type === "db.field_type_changed");
  assert.equal(typeChanged.length, 1, "Existing field type change SHOULD emit db.field_type_changed");
});

// 14. CLI facts prints text summary and --json
test("CLI facts prints short text summary and --json output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "facts-cli-facts-"));
  try {
    const file = path.join(tmp, "schema.prisma");
    fs.writeFileSync(file, "model Customer {\n  id Int @id\n  email String @unique\n}\n");

    const rText = spawnSync(process.execPath, [CLI, "facts", file], { encoding: "utf8" });
    assert.equal(rText.status, 0, `CLI facts text failed: ${rText.stderr}`);
    assert.ok(rText.stdout.includes("Architecture Facts:"));
    assert.ok(rText.stdout.includes("Entities: 3"));
    assert.ok(rText.stdout.includes("db.model: 1"));
    assert.ok(rText.stdout.includes("db.field: 2"));

    const rJson = spawnSync(process.execPath, [CLI, "facts", file, "--json"], { encoding: "utf8" });
    assert.equal(rJson.status, 0, `CLI facts json failed: ${rJson.stderr}`);
    const parsed = JSON.parse(rJson.stdout);
    assert.equal(parsed.entities.length, 3);
    assert.ok(parsed.entities.some(e => e.id === "db.model:Customer"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

import { computeBlobSha, FactsCache, CACHE_VERSION } from "../tools/facts-cache.mjs";

// 15. FactsCache hit avoids re-parsing (spy)
test("FactsCache hit avoids re-parsing with spy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "facts-cache-test-"));
  try {
    const cache = new FactsCache(tmp);
    const content = "model User {\n  id Int @id\n}\n";
    const sha = computeBlobSha(content);

    let parseCount = 0;
    const spyExtract = (files) => {
      parseCount++;
      return extractFacts(files);
    };

    // First call: cache miss, extracts facts and saves to cache
    let hit = cache.get(sha, "schema.prisma");
    if (!hit) {
      const facts = spyExtract([{ path: "schema.prisma", content }]);
      cache.set(sha, facts);
    }
    assert.equal(parseCount, 1);

    // Second call: cache hit, parser is not called
    hit = cache.get(sha, "schema.prisma");
    assert.ok(hit);
    assert.equal(parseCount, 1, "Parser must not be called on cache hit");
    assert.ok(hit.entities.some(e => e.id === "db.model:User"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 16. FactsCache invalidation on version change
test("FactsCache invalidates when Archtour version changes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "facts-cache-ver-"));
  try {
    const cache = new FactsCache(tmp);
    const content = "services:\n  app:\n    image: nginx\n";
    const sha = computeBlobSha(content);
    const facts = extractFacts([{ path: "docker-compose.yml", content }]);
    cache.set(sha, facts);

    // Verify cache file exists
    const cacheFile = path.join(tmp, `${sha}.json`);
    assert.ok(fs.existsSync(cacheFile));

    // Tamper with the version to simulate an older archtour version
    const cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    cachedData.version = "0.0.1-old";
    fs.writeFileSync(cacheFile, JSON.stringify(cachedData));

    // Fresh cache instance pointing to same directory
    const freshCache = new FactsCache(tmp);
    const hit = freshCache.get(sha, "docker-compose.yml");
    assert.equal(hit, null, "Should miss when cache entry version does not match current version");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 17. FactsCache path remapping for dev compose services
test("FactsCache remaps dev compose service ID when retrieved under different path", () => {
  const cache = new FactsCache();
  const content = "services:\n  web:\n    image: node\n";
  const sha = computeBlobSha(content);
  const facts = extractFacts([{ path: "docker-compose.dev.yml", content }]);
  cache.set(sha, facts);

  const remapped = cache.get(sha, "compose.local.yaml");
  assert.ok(remapped);
  assert.equal(remapped.sources[0].path, "compose.local.yaml");
  const svc = remapped.entities.find(e => e.kind === "service");
  assert.ok(svc);
  assert.equal(svc.id, "service:web@compose.local.yaml");
});

// 18. Prisma @map field rename -> no removal finding, advisory rename
test("Prisma @map field rename produces db.field_renamed advisory event and no field removal", () => {
  const basePrisma = `
model Post {
  id      Int    @id
  content String
}
`;
  const headPrisma = `
model Post {
  id   Int    @id
  body String @map("content")
}
`;
  const baseFacts = extractFacts([{ path: "schema.prisma", content: basePrisma }]);
  const headFacts = extractFacts([{ path: "schema.prisma", content: headPrisma }]);
  const diff = diffFacts(baseFacts, headFacts);

  // Assert no db.field_removed
  const removedField = diff.events.find(e => e.type === "db.field_removed");
  assert.equal(removedField, undefined, "Prisma @map field rename must not emit db.field_removed");

  // Assert db.field_renamed emitted
  const renamedField = diff.events.find(e => e.type === "db.field_renamed");
  assert.ok(renamedField, "Prisma @map field rename must emit db.field_renamed");
  assert.equal(renamedField.before, "Post.content");
  assert.equal(renamedField.after, "Post.body");
});

// 19. Prisma @@map model rename -> no removal finding, advisory rename
test("Prisma @@map model rename produces db.model_renamed advisory event and no model removal", () => {
  const basePrisma = `
model Post {
  id    Int    @id
  title String
}
`;
  const headPrisma = `
model Article {
  id    Int    @id
  title String
  @@map("Post")
}
`;
  const baseFacts = extractFacts([{ path: "schema.prisma", content: basePrisma }]);
  const headFacts = extractFacts([{ path: "schema.prisma", content: headPrisma }]);
  const diff = diffFacts(baseFacts, headFacts);

  // Assert no db.model_removed
  const removedModel = diff.events.find(e => e.type === "db.model_removed");
  assert.equal(removedModel, undefined, "Prisma @@map model rename must not emit db.model_removed");

  // Assert db.model_renamed emitted
  const renamedModel = diff.events.find(e => e.type === "db.model_renamed");
  assert.ok(renamedModel, "Prisma @@map model rename must emit db.model_renamed");
  assert.equal(renamedModel.before, "Post");
  assert.equal(renamedModel.after, "Article");

  // Also assert no field removal for preserved fields
  const removedField = diff.events.find(e => e.type === "db.field_removed");
  assert.equal(removedField, undefined, "Fields in renamed model must not emit db.field_removed");
});

// 20. Compose port interpolation: ${PORT:-8080}:8080 is seen as published on all interfaces
test("compose port interpolation: ${PORT:-8080}:8080 is published on all interfaces", () => {
  const compose = `services:\n  app:\n    image: alpine\n    ports:\n      - "\${PORT:-8080}:8080"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const svc = facts.entities.find(e => e.kind === "service");
  assert.ok(svc, "service entity not found");
  const port = svc.attrs.ports[0];
  assert.ok(port, "port not found");
  assert.equal(port.host, "8080", "host port should resolve from default");
  assert.equal(port.published, true);
  assert.equal(port.bindAll, true, "interpolation with default should bind all interfaces");
});

// 21. Compose port interpolation: 0.0.0.0:${PORT:-8080}:8080 is published on all interfaces
test("compose port interpolation: 0.0.0.0:${PORT:-8080}:8080 is published on all interfaces", () => {
  const compose = `services:\n  app:\n    image: alpine\n    ports:\n      - "0.0.0.0:\${PORT:-8080}:8080"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const svc = facts.entities.find(e => e.kind === "service");
  assert.ok(svc, "service entity not found");
  const port = svc.attrs.ports[0];
  assert.ok(port, "port not found");
  assert.equal(port.hostIp, "0.0.0.0");
  assert.equal(port.host, "8080");
  assert.equal(port.published, true);
  assert.equal(port.bindAll, true);
});

// 22. Compose port interpolation: 127.0.0.1:${PORT:-8080}:8080 is NOT all interfaces (loopback)
test("compose port interpolation: 127.0.0.1:${PORT:-8080}:8080 is loopback-only", () => {
  const compose = `services:\n  app:\n    image: alpine\n    ports:\n      - "127.0.0.1:\${PORT:-8080}:8080"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const svc = facts.entities.find(e => e.kind === "service");
  assert.ok(svc, "service entity not found");
  const port = svc.attrs.ports[0];
  assert.ok(port, "port not found");
  assert.equal(port.hostIp, "127.0.0.1");
  assert.equal(port.host, "8080");
  assert.equal(port.published, true);
  assert.equal(port.bindAll, false, "loopback IP should not bind all interfaces");
});

// 23. Compose port interpolation: ${HOST:-127.0.0.1}:8080:8080 resolves default to loopback
test("compose port interpolation: ${HOST:-127.0.0.1}:8080:8080 resolves to loopback", () => {
  const compose = `services:\n  app:\n    image: alpine\n    ports:\n      - "\${HOST:-127.0.0.1}:8080:8080"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const svc = facts.entities.find(e => e.kind === "service");
  assert.ok(svc, "service entity not found");
  const port = svc.attrs.ports[0];
  assert.ok(port, "port not found");
  assert.equal(port.hostIp, "127.0.0.1", "host IP should resolve from default");
  assert.equal(port.host, "8080");
  assert.equal(port.published, true);
  assert.equal(port.bindAll, false, "resolved loopback should not bind all interfaces");
});

// 24. Compose port interpolation: ${HOST}:8080:8080 with unknown host IP fails closed (all interfaces)
test("compose port interpolation: ${HOST}:8080:8080 unknown host IP fails closed", () => {
  const compose = `services:\n  app:\n    image: alpine\n    ports:\n      - "\${HOST}:8080:8080"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const svc = facts.entities.find(e => e.kind === "service");
  assert.ok(svc, "service entity not found");
  const port = svc.attrs.ports[0];
  assert.ok(port, "port not found");
  assert.equal(port.hostIp, "0.0.0.0", "unknown host IP should default to all interfaces");
  assert.equal(port.host, "8080");
  assert.equal(port.published, true);
  assert.equal(port.bindAll, true, "unknown host IP should bind all interfaces (fail closed)");
});

// 25. State mode: loopback-only port does not emit service.port_published event
test("state mode: loopback-only port does not emit service.port_published event", async () => {
  const { extractStateEvents } = await import("../tools/rules.mjs");
  const compose = `services:\n  db:\n    image: postgres\n    ports:\n      - "127.0.0.1:5432:5432"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const events = extractStateEvents(facts);
  const portEvents = events.filter(e => e.type === "service.port_published");
  assert.equal(portEvents.length, 0, "loopback-only port should not emit port_published event");
});

// 26. State mode: all-interfaces port emits service.port_published event
test("state mode: all-interfaces port emits service.port_published event", async () => {
  const { extractStateEvents } = await import("../tools/rules.mjs");
  const compose = `services:\n  web:\n    image: nginx\n    ports:\n      - "5432:5432"`;
  const facts = extractFacts([{ path: "docker-compose.yml", content: compose }]);
  const events = extractStateEvents(facts);
  const portEvents = events.filter(e => e.type === "service.port_published");
  assert.equal(portEvents.length, 1, "all-interfaces port should emit port_published event");
  assert.ok(portEvents[0].message.includes("all interfaces"));
});

// T-103: renaming a path parameter does not remove the route
test("renaming an OpenAPI path parameter does not emit api.route_removed", () => {
  const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({
    openapi: "3.0.0",
    paths: { "/users/{id}": { get: { parameters: [{ name: "id", in: "path", required: true }] } } }
  }) }]);
  const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({
    openapi: "3.0.0",
    paths: { "/users/{userId}": { get: { parameters: [{ name: "userId", in: "path", required: true }] } } }
  }) }]);
  const diff = diffFacts(base, head);
  assert.equal(diff.events.filter(e => e.type === "api.route_removed").length, 0);
});

// T-103: an actually removed route with a path parameter is still removed
test("actually removing a route with a path parameter still emits api.route_removed", () => {
  const base = extractFacts([{ path: "openapi.json", content: JSON.stringify({
    openapi: "3.0.0",
    paths: { "/users/{id}": { get: { parameters: [{ name: "id", in: "path", required: true }] } } }
  }) }]);
  const head = extractFacts([{ path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: {} }) }]);
  const diff = diffFacts(base, head);
  const ev = diff.events.find(e => e.type === "api.route_removed");
  assert.ok(ev, "api.route_removed not produced");
  assert.ok(ev.before.includes("/users/{id}"), "message keeps the original path text");
});
