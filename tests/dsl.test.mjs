import test from "node:test";
import assert from "node:assert/strict";
import { parseDsl } from "../tools/dsl.mjs";

test("parseDsl parses metadata, nodes, shapes, colors, and edges", () => {
  const dsl = `
title: Checkout Architecture
direction: LR
preset: clean

web "Web Store" {shape: ellipse, color: blue, tooltip: "Customer SPA"}
api "Backend API" {color: violet}
ok "Payment Valid?" {shape: diamond, color: orange}
db "Database" {shape: ellipse, color: green}

web -> api : POST /order
api -> ok
ok -> db : yes
ok -.-> web : retry
`;

  const spec = parseDsl(dsl);

  assert.equal(spec.title, "Checkout Architecture");
  assert.equal(spec.direction, "LR");
  assert.equal(spec.preset, "clean");
  assert.equal(spec.nodes.length, 4);

  const webNode = spec.nodes.find(n => n.id === "web");
  assert.equal(webNode.label, "Web Store");
  assert.equal(webNode.shape, "ellipse");
  assert.equal(webNode.color, "blue");
  assert.equal(webNode.tooltip, "Customer SPA");

  const okNode = spec.nodes.find(n => n.id === "ok");
  assert.equal(okNode.shape, "diamond");
  assert.equal(okNode.color, "orange");

  assert.equal(spec.edges.length, 4);
  const postEdge = spec.edges.find(e => e.from === "web" && e.to === "api");
  assert.equal(postEdge.label, "POST /order");

  const retryEdge = spec.edges.find(e => e.from === "ok" && e.to === "web");
  assert.equal(retryEdge.style, "dashed");
  assert.equal(retryEdge.label, "retry");
});

test("parseDsl parses groups and steps", () => {
  const dsl = `
title: Microservices
group cloud "Cloud Infrastructure" [api, db] {color: gray}

api -> db : SQL query

step "Database Read" : App queries database
nodes: api, db
`;

  const spec = parseDsl(dsl);
  assert.equal(spec.groups.length, 1);
  assert.equal(spec.groups[0].id, "cloud");
  assert.equal(spec.groups[0].label, "Cloud Infrastructure");
  assert.deepEqual(spec.groups[0].nodes, ["api", "db"]);

  assert.equal(spec.steps.length, 1);
  assert.equal(spec.steps[0].title, "Database Read");
  assert.deepEqual(spec.steps[0].nodes, ["api", "db"]);
});

test("parseDsl supports shorthand shape and color syntax", () => {
  const dsl = `
[gateway] API Gateway {diamond, violet}
storage {ellipse, teal}
gateway -> storage
`;

  const spec = parseDsl(dsl);
  const gw = spec.nodes.find(n => n.id === "gateway");
  assert.equal(gw.label, "API Gateway");
  assert.equal(gw.shape, "diamond");
  assert.equal(gw.color, "violet");

  const st = spec.nodes.find(n => n.id === "storage");
  assert.equal(st.shape, "ellipse");
  assert.equal(st.color, "teal");
});

test("parseDsl throws error when line exceeds 20000 chars", () => {
  const longLine = "a -> b : " + "x".repeat(20001);
  assert.throws(
    () => parseDsl(longLine),
    /exceeds maximum length of 20000 characters/
  );
});

test("120k-char DSL line returns in < 1 s (rejected)", () => {
  const line120k = "a -> b : " + "x".repeat(120000);
  const start = Date.now();
  assert.throws(
    () => parseDsl(line120k),
    /exceeds maximum length of 20000 characters/
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Expected < 1000ms, took ${elapsed}ms`);
});

test("parseDsl parses valid long lines under 20000 chars without backtracking", () => {
  const label = "x".repeat(5000);
  const dsl = `web -> api : ${label}`;
  const start = Date.now();
  const spec = parseDsl(dsl);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `Expected < 1000ms, took ${elapsed}ms`);
  assert.equal(spec.edges.length, 1);
  assert.equal(spec.edges[0].label, label);
});

