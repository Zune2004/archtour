import test from "node:test";
import assert from "node:assert/strict";
import { parseMermaid } from "../tools/mermaid.mjs";

test("parseMermaid parses flowchart with various shapes and edge types", () => {
  const mmd = `
flowchart LR
  user([User]) --> api[API Gateway]
  api --> auth{Token valid?}
  auth -->|yes| svc[Orders service] --> db[(Postgres)]
  auth -->|no| err[401]
`;

  const spec = parseMermaid(mmd);

  assert.equal(spec.direction, "LR");
  assert.equal(spec.nodes.length, 6);

  const byId = new Map(spec.nodes.map(n => [n.id, n]));
  assert.equal(byId.get("user").shape, "ellipse");
  assert.equal(byId.get("api").shape, "rectangle");
  assert.equal(byId.get("auth").shape, "diamond");
  assert.equal(byId.get("db").shape, "ellipse");
  assert.equal(byId.get("db").label, "Postgres");

  assert.equal(spec.edges.length, 5);
  const yesEdge = spec.edges.find(e => e.from === "auth" && e.to === "svc");
  assert.ok(yesEdge);
  assert.equal(yesEdge.label, "yes");

  const dbEdge = spec.edges.find(e => e.from === "svc" && e.to === "db");
  assert.ok(dbEdge);
});

test("parseMermaid handles subgraphs and groups", () => {
  const mmd = `
flowchart TB
  subgraph Cloud [Cloud Services]
    api[API]
    db[(Database)]
  end
  client[Client] --> api
  api --> db
`;

  const spec = parseMermaid(mmd);
  assert.equal(spec.direction, "TB");
  assert.equal(spec.groups.length, 1);
  assert.equal(spec.groups[0].id, "Cloud");
  assert.equal(spec.groups[0].label, "Cloud Services");
  assert.deepEqual(spec.groups[0].nodes, ["api", "db"]);
});

test("parseMermaid parses stateDiagram-v2 transitions and start/end pseudo-states", () => {
  const mmd = `
stateDiagram-v2
  direction LR
  [*] --> Placed : checkout
  Placed --> Paid : payment captured
  Paid --> Delivered : carrier delivers
  Delivered --> [*]
`;

  const spec = parseMermaid(mmd);
  assert.equal(spec.direction, "LR");

  const startNode = spec.nodes.find(n => n.label === "Start");
  const endNode = spec.nodes.find(n => n.label === "End");
  assert.ok(startNode);
  assert.ok(endNode);

  const checkoutEdge = spec.edges.find(e => e.from === startNode.id && e.to === "Placed");
  assert.ok(checkoutEdge);
  assert.equal(checkoutEdge.label, "checkout");

  const endEdge = spec.edges.find(e => e.from === "Delivered" && e.to === endNode.id);
  assert.ok(endEdge);
});

test("parseMermaid throws clear explanatory error on unsupported diagram types", () => {
  const mmd = `
sequenceDiagram
  Alice->>Bob: Hello
`;

  assert.throws(
    () => parseMermaid(mmd),
    (err) => {
      assert.ok(err.message.includes('Unsupported Mermaid diagram type "sequenceDiagram"'));
      assert.ok(err.message.includes("Interactive conversion currently supports flowcharts"));
      assert.ok(err.message.includes("node tools/diagram.mjs mermaid <file.mmd>"));
      return true;
    }
  );
});
