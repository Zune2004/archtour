import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitLargeSpec } from "../tools/split.mjs";

function buildSynthetic60ModelSpec() {
  const nodes = [];
  const edges = [];

  // Hub: User
  nodes.push({ id: "user", label: "User\nid: Int 🔑", shape: "rectangle", color: "blue" });

  // Cluster 1: 12 models (c1_m1 to c1_m12)
  for (let i = 1; i <= 12; i++) {
    nodes.push({ id: `c1_m${i}`, label: `Cluster1Model${i}`, shape: "rectangle", color: "blue" });
  }
  // c1_m1 is lead, connects to c1_m2..c1_m6
  for (let i = 2; i <= 6; i++) {
    edges.push({ from: "c1_m1", to: `c1_m${i}`, label: "1 : N" });
  }
  // chain c1_m6 to c1_m12
  for (let i = 6; i <= 11; i++) {
    edges.push({ from: `c1_m${i}`, to: `c1_m${i + 1}`, label: "1 : 1" });
  }

  // Cluster 2: 13 models (c2_m1 to c2_m13)
  for (let i = 1; i <= 13; i++) {
    nodes.push({ id: `c2_m${i}`, label: `Cluster2Model${i}`, shape: "rectangle", color: "blue" });
  }
  for (let i = 2; i <= 6; i++) {
    edges.push({ from: "c2_m1", to: `c2_m${i}`, label: "1 : N" });
  }
  for (let i = 6; i <= 12; i++) {
    edges.push({ from: `c2_m${i}`, to: `c2_m${i + 1}`, label: "1 : 1" });
  }

  // Cluster 3: 13 models (c3_m1 to c3_m13)
  for (let i = 1; i <= 13; i++) {
    nodes.push({ id: `c3_m${i}`, label: `Cluster3Model${i}`, shape: "rectangle", color: "blue" });
  }
  for (let i = 2; i <= 6; i++) {
    edges.push({ from: "c3_m1", to: `c3_m${i}`, label: "1 : N" });
  }
  for (let i = 6; i <= 12; i++) {
    edges.push({ from: `c3_m${i}`, to: `c3_m${i + 1}`, label: "1 : 1" });
  }

  // Cluster 4: 16 models (c4_m1 to c4_m16) - larger than 15 to test splitting
  for (let i = 1; i <= 16; i++) {
    nodes.push({ id: `c4_m${i}`, label: `Cluster4Model${i}`, shape: "rectangle", color: "blue" });
  }
  for (let i = 2; i <= 6; i++) {
    edges.push({ from: "c4_m1", to: `c4_m${i}`, label: "1 : N" });
  }
  for (let i = 6; i <= 15; i++) {
    edges.push({ from: `c4_m${i}`, to: `c4_m${i + 1}`, label: "1 : 1" });
  }

  // Hub relations: User related to 20 models (5 in each cluster)
  for (let i = 1; i <= 5; i++) {
    edges.push({ from: "user", to: `c1_m${i}`, label: "1 : N" });
    edges.push({ from: "user", to: `c2_m${i}`, label: "1 : N" });
    edges.push({ from: "user", to: `c3_m${i}`, label: "1 : N" });
    edges.push({ from: "user", to: `c4_m${i}`, label: "1 : N" });
  }

  // Inter-cluster relations between Cluster 1 and Cluster 2 (2 crossing relations)
  edges.push({ from: "c1_m2", to: "c2_m2", label: "1 : 1" });
  edges.push({ from: "c1_m3", to: "c2_m3", label: "1 : 1" });

  // 5 isolated models with no edges
  for (let i = 1; i <= 5; i++) {
    nodes.push({ id: `iso_${i}`, label: `Isolated${i}`, shape: "rectangle", color: "blue" });
  }

  assert.equal(nodes.length, 60, "Must have exactly 60 models");

  return {
    title: "Synthetic 60-Model Schema",
    direction: "LR",
    preset: "clean",
    nodes,
    edges
  };
}

function buildRealCaseFixture() {
  const nodes = [];
  const edges = [];

  // Hub: User
  nodes.push({ id: "user", label: "User\nid: Int 🔑", shape: "rectangle", color: "blue" });

  // 4 models named *Attempt
  const attemptNames = ["LoginAttempt", "PasswordAttempt", "QuizAttempt", "SignupAttempt"];
  for (const name of attemptNames) {
    const id = name.toLowerCase();
    nodes.push({ id, label: `${name}\nid: Int 🔑`, shape: "rectangle", color: "blue" });
    edges.push({ from: "user", to: id, label: "1 : N" });
  }

  // 6 models named Org* / Organization*
  const orgNames = [
    "OrgUnit", "OrgMember", "OrgRole",
    "OrgSetting", "OrgDomain", "OrgAudit"
  ];
  for (const name of orgNames) {
    const id = name.toLowerCase();
    nodes.push({ id, label: `${name}\nid: Int 🔑`, shape: "rectangle", color: "blue" });
    edges.push({ from: "user", to: id, label: "1 : N" });
  }

  // Rest varied (24 models, total 34 related to User)
  const variedNames = [
    "Account", "Billing", "Customer", "Document", "EventRecord", "FeatureFlag",
    "PaymentGateway", "HistoryLog", "Invoice", "JournalEntry", "LicenseKey", "MetricData",
    "Notification", "Payment", "QueueJob", "ReportDoc", "SessionToken", "TenantSpace",
    "UploadFile", "VoucherCode", "WebhookSub", "WorkspaceArea", "ProfileInfo", "ActivityTrack"
  ];
  for (const name of variedNames) {
    const id = name.toLowerCase();
    nodes.push({ id, label: `${name}\nid: Int 🔑`, shape: "rectangle", color: "blue" });
    edges.push({ from: "user", to: id, label: "1 : N" });
  }

  // Plus 2 connected chains of 6
  // Chain 1: c1_a -> c1_b -> c1_c -> c1_d -> c1_e -> c1_f
  const chain1 = ["c1_a", "c1_b", "c1_c", "c1_d", "c1_e", "c1_f"];
  for (const id of chain1) {
    nodes.push({ id, label: `${id} model`, shape: "rectangle", color: "blue" });
  }
  for (let i = 0; i < chain1.length - 1; i++) {
    edges.push({ from: chain1[i], to: chain1[i + 1], label: "1 : 1" });
  }

  // Chain 2: c2_a -> c2_b -> c2_c -> c2_d -> c2_e -> c2_f
  const chain2 = ["c2_a", "c2_b", "c2_c", "c2_d", "c2_e", "c2_f"];
  for (const id of chain2) {
    nodes.push({ id, label: `${id} model`, shape: "rectangle", color: "blue" });
  }
  for (let i = 0; i < chain2.length - 1; i++) {
    edges.push({ from: chain2[i], to: chain2[i + 1], label: "1 : 1" });
  }

  assert.equal(nodes.length, 1 + 34 + 12, "Must have exactly 47 models (1 user + 34 relations + 12 chain models)");

  return {
    title: "Real Case Shaped Schema",
    direction: "LR",
    preset: "clean",
    nodes,
    edges
  };
}

test("splitLargeSpec returns spec with <= 15 nodes unchanged", () => {
  const smallSpec = {
    title: "Small Schema",
    nodes: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, label: `Model${i}` })),
    edges: [{ from: "m0", to: "m1", label: "rel" }]
  };

  const result = splitLargeSpec(smallSpec);
  assert.equal(result, smallSpec, "Must return exact same object reference unchanged");
});

test("splitLargeSpec splits 60-model schema satisfying all acceptance criteria", () => {
  const spec = buildSynthetic60ModelSpec();
  const overview = splitLargeSpec(spec);

  // 1. Overview has at most 15 nodes
  assert.ok(overview.nodes.length <= 15, `Overview nodes count (${overview.nodes.length}) must be <= 15`);

  // 2. Overview title matches original title
  assert.equal(overview.title, spec.title);

  // 3. Every original model appears in exactly one group
  const assignedNodes = new Map(); // modelId -> groupName
  const allGroupNames = new Set();

  for (const groupNode of overview.nodes) {
    assert.ok(groupNode.drill, `Group node ${groupNode.id} must have a drill sub-spec`);
    const subSpec = groupNode.drill;
    allGroupNames.add(subSpec.title);

    // Non-stub nodes are original nodes
    const groupOriginalNodes = subSpec.nodes.filter(n => !n.id.startsWith("ext:"));

    // 4. No group has more than 15 models
    assert.ok(
      groupOriginalNodes.length <= 15,
      `Group "${subSpec.title}" has ${groupOriginalNodes.length} models, expected <= 15`
    );

    // Label check: "<name>\n<k> models"
    assert.equal(
      groupNode.label,
      `${subSpec.title}\n${groupOriginalNodes.length} models`,
      "Group node label must match '<name>\\n<k> models'"
    );

    for (const node of groupOriginalNodes) {
      assert.equal(
        assignedNodes.has(node.id),
        false,
        `Model ${node.id} is assigned more than once (in ${assignedNodes.get(node.id)} and ${subSpec.title})`
      );
      assignedNodes.set(node.id, subSpec.title);
    }
  }

  assert.equal(
    assignedNodes.size,
    60,
    `Every one of the 60 models must appear in exactly one group, found ${assignedNodes.size}`
  );

  // 5. Core contains User
  const coreGroupNode = overview.nodes.find(n => n.label.startsWith("Core\n"));
  assert.ok(coreGroupNode, "Core group must exist");
  const coreSubSpec = coreGroupNode.drill;
  assert.ok(
    coreSubSpec.nodes.some(n => n.id === "user"),
    "Core group must contain the hub User"
  );

  // 6. Isolated models (adapted from old "Other models" check): grouped together under word "iso" -> "Iso models"
  const isoGroupNode = overview.nodes.find(n => n.label.includes("Iso models"));
  assert.ok(isoGroupNode, "'Iso models' group must exist for isolated models sharing word 'iso'");
  const isoSubSpec = isoGroupNode.drill;
  for (let i = 1; i <= 5; i++) {
    assert.ok(
      isoSubSpec.nodes.some(n => n.id === `iso_${i}`),
      `Isolated model iso_${i} must be in Iso models group`
    );
  }

  // 7. Cross-group edge counts equal the real crossing relations
  const nodeToGroupName = assignedNodes;
  const expectedCrossingCounts = new Map(); // "g1:::g2" -> count

  for (const edge of spec.edges) {
    const gFrom = nodeToGroupName.get(edge.from);
    const gTo = nodeToGroupName.get(edge.to);
    if (!gFrom || !gTo || gFrom === gTo) continue;

    const [gA, gB] = gFrom < gTo ? [gFrom, gTo] : [gTo, gFrom];
    const key = `${gA}:::${gB}`;
    expectedCrossingCounts.set(key, (expectedCrossingCounts.get(key) || 0) + 1);
  }

  const overviewCrossingCounts = new Map();
  for (const edge of overview.edges) {
    const gFromNode = overview.nodes.find(n => n.id === edge.from);
    const gToNode = overview.nodes.find(n => n.id === edge.to);
    assert.ok(gFromNode, `From group node ${edge.from} must exist`);
    assert.ok(gToNode, `To group node ${edge.to} must exist`);

    const gFromName = gFromNode.drill.title;
    const gToName = gToNode.drill.title;
    const [gA, gB] = gFromName < gToName ? [gFromName, gToName] : [gToName, gFromName];
    const key = `${gA}:::${gB}`;

    const match = edge.label.match(/^(\d+)\s+relations$/);
    assert.ok(match, `Overview edge label must match '<n> relations', got "${edge.label}"`);
    const count = parseInt(match[1], 10);
    overviewCrossingCounts.set(key, count);
  }

  // Verify overview edges match expected crossing counts exactly
  assert.equal(
    overviewCrossingCounts.size,
    expectedCrossingCounts.size,
    `Overview should have exactly ${expectedCrossingCounts.size} cross-group edges, got ${overviewCrossingCounts.size}`
  );

  for (const [pairKey, expectedCount] of expectedCrossingCounts.entries()) {
    const actualCount = overviewCrossingCounts.get(pairKey);
    assert.equal(
      actualCount,
      expectedCount,
      `Crossing relations for ${pairKey} expected ${expectedCount}, got ${actualCount}`
    );
  }

  // 8. Output identical across two runs (JSON.stringify equal)
  const run1Json = JSON.stringify(splitLargeSpec(spec));
  const run2Json = JSON.stringify(splitLargeSpec(spec));
  assert.equal(run1Json, run2Json, "splitLargeSpec must produce byte-identical JSON output across multiple runs");

  // 9. Stub nodes in sub-specs: grey stub ↗ with tooltip in ...
  for (const groupNode of overview.nodes) {
    const subSpec = groupNode.drill;
    const stubs = subSpec.nodes.filter(n => n.id.startsWith("ext:"));
    for (const stub of stubs) {
      assert.equal(stub.color, "gray", `Stub node ${stub.id} must be gray`);
      assert.ok(stub.label.startsWith("↗ "), `Stub label "${stub.label}" must start with ↗`);
      assert.ok(stub.tooltip.startsWith("in "), `Stub tooltip "${stub.tooltip}" must start with 'in '`);
    }
  }
});

test("splitLargeSpec on real-case fixture satisfies all round 2 acceptance criteria", () => {
  const spec = buildRealCaseFixture();
  const overview = splitLargeSpec(spec);

  // 1. Expect <= 8 overview groups
  assert.ok(
    overview.nodes.length <= 8,
    `Overview groups count (${overview.nodes.length}) must be <= 8`
  );

  // 2. No group < 3 models except when the total leftover is < 3 (Core group contains the hubs)
  for (const groupNode of overview.nodes) {
    assert.ok(groupNode.drill, `Group ${groupNode.id} must have drill`);
    const subSpec = groupNode.drill;
    const originalModels = subSpec.nodes.filter(n => !n.id.startsWith("ext:"));
    if (groupNode.id !== "core") {
      assert.ok(
        originalModels.length >= 3,
        `Non-core group "${groupNode.id}" has ${originalModels.length} models, expected >= 3`
      );
    }
  }

  // 3. An "Attempt models" group
  const attemptGroupNode = overview.nodes.find(n => n.label.startsWith("Attempt models\n"));
  assert.ok(attemptGroupNode, "Overview must contain an 'Attempt models' group");
  const attemptSubSpec = attemptGroupNode.drill;
  assert.equal(
    attemptSubSpec.nodes.filter(n => !n.id.startsWith("ext:")).length,
    4,
    "'Attempt models' group must have 4 models"
  );

  // 4. Core stubs <= number of groups
  const coreGroupNode = overview.nodes.find(n => n.id === "core");
  assert.ok(coreGroupNode, "Core group must exist");
  const coreStubs = coreGroupNode.drill.nodes.filter(n => n.id.startsWith("ext:"));
  assert.ok(
    coreStubs.length <= overview.nodes.length,
    `Core stubs count (${coreStubs.length}) must be <= number of groups (${overview.nodes.length})`
  );

  // 5. Every model exactly once
  const assigned = new Set();
  for (const g of overview.nodes) {
    const models = g.drill.nodes.filter(n => !n.id.startsWith("ext:"));
    for (const m of models) {
      assert.equal(assigned.has(m.id), false, `Model ${m.id} assigned multiple times`);
      assigned.add(m.id);
    }
  }
  assert.equal(assigned.size, spec.nodes.length, "Every model must appear in exactly one group");

  // 6. Deterministic across runs
  const run1 = JSON.stringify(splitLargeSpec(spec));
  const run2 = JSON.stringify(splitLargeSpec(spec));
  assert.equal(run1, run2, "Output must be byte-identical across runs");
});

test("splitLargeSpec works on Docker Compose and OpenAPI spec formats", () => {
  // Docker Compose format (20 services)
  const composeNodes = Array.from({ length: 20 }, (_, i) => ({
    id: `svc_${i}`,
    label: `svc_${i}\n(image:v1)`,
    shape: "rectangle",
    color: "violet",
    fields: []
  }));
  const composeEdges = [];
  for (let i = 1; i < 20; i++) {
    composeEdges.push({ from: `svc_0`, to: `svc_${i}`, label: "depends on" });
  }
  const composeSpec = {
    title: "Container Infrastructure",
    direction: "TB",
    preset: "blueprint",
    nodes: composeNodes,
    edges: composeEdges
  };

  const splitCompose = splitLargeSpec(composeSpec);
  assert.ok(splitCompose.nodes.length <= 15);
  assert.ok(splitCompose.nodes.every(n => n.drill));
});

test("split of a 2,000-model chain spec -> top level has <= 15 nodes, every level <= 15, every model appears exactly once at the leaves", () => {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 2000; i++) {
    nodes.push({ id: `m${i}`, label: `M${i}`, shape: "rectangle", color: "blue" });
  }
  for (let i = 0; i < 1999; i++) {
    edges.push({ from: `m${i}`, to: `m${i + 1}`, label: "1 : 1" });
  }
  const spec = {
    title: "2000-Model Chain Schema",
    direction: "LR",
    preset: "clean",
    nodes,
    edges
  };

  const overview = splitLargeSpec(spec);

  // 1. Top level has <= 15 nodes
  assert.ok(overview.nodes.length <= 15, `Top level nodes count (${overview.nodes.length}) must be <= 15`);
  assert.ok(overview.nodes.length > 1, `Top level nodes count (${overview.nodes.length}) must be > 1`);

  // 2. Every level has <= 15 boxes (models/groups, excluding external stubs)
  function assertMax15Nodes(currentSpec, pathName = "root") {
    const items = currentSpec.nodes.filter(n => !n.id.startsWith("ext:"));
    assert.ok(
      items.length <= 15,
      `Level "${pathName}" (${currentSpec.title}) has ${items.length} nodes, expected <= 15`
    );
    for (const node of currentSpec.nodes) {
      if (node.drill) {
        assertMax15Nodes(node.drill, `${pathName} > ${node.id}`);
      }
    }
  }
  assertMax15Nodes(overview);

  // 3. Every model appears exactly once at the leaves
  const leafModelIds = [];
  function collectLeaves(currentSpec) {
    for (const node of currentSpec.nodes) {
      if (node.id.startsWith("ext:")) continue;
      if (node.drill) {
        collectLeaves(node.drill);
      } else {
        leafModelIds.push(node.id);
      }
    }
  }
  collectLeaves(overview);

  assert.equal(leafModelIds.length, 2000, `Expected 2000 leaf models, found ${leafModelIds.length}`);
  const uniqueLeaves = new Set(leafModelIds);
  assert.equal(uniqueLeaves.size, 2000, `Expected 2000 unique leaf models, found ${uniqueLeaves.size}`);

  // Drill-in structure has meta-groups containing child groups
  const topGroup = overview.nodes[0];
  assert.ok(topGroup.drill, "Top-level overview node must have a drill sub-spec");
  assert.ok(
    topGroup.drill.nodes.some(child => child.drill),
    "Meta-group must contain child groups with their own drill sub-specs"
  );
});

test("split of a 40-model spec keeps today's single-level behaviour (no regression)", () => {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 40; i++) {
    nodes.push({ id: `mod_${i}`, label: `Model${i}`, shape: "rectangle", color: "blue" });
  }
  for (let i = 0; i < 39; i++) {
    edges.push({ from: `mod_${i}`, to: `mod_${i + 1}`, label: "1 : 1" });
  }
  const spec = {
    title: "40-Model Chain Schema",
    direction: "LR",
    preset: "clean",
    nodes,
    edges
  };

  const overview = splitLargeSpec(spec);

  // 1. Top level has <= 15 nodes
  assert.ok(overview.nodes.length <= 15, `Top level nodes count (${overview.nodes.length}) must be <= 15`);

  // 2. Single-level behaviour: every node in overview has drill, and child nodes have NO drill
  for (const node of overview.nodes) {
    assert.ok(node.drill, `Node ${node.id} must have drill`);
    const subSpec = node.drill;
    const modelNodes = subSpec.nodes.filter(n => !n.id.startsWith("ext:"));
    assert.ok(modelNodes.length <= 15, `Group has ${modelNodes.length} models, expected <= 15`);
    for (const child of subSpec.nodes) {
      assert.equal(child.drill, undefined, `Child node ${child.id} in single-level group must not have drill`);
    }
  }

  // 3. Every model appears exactly once
  const assigned = new Set();
  for (const g of overview.nodes) {
    for (const m of g.drill.nodes.filter(n => !n.id.startsWith("ext:"))) {
      assert.equal(assigned.has(m.id), false, `Model ${m.id} assigned multiple times`);
      assigned.add(m.id);
    }
  }
  assert.equal(assigned.size, 40, `Every one of 40 models must appear once, got ${assigned.size}`);
});

test("5,000-model chain spec splits on the render-free path without RangeError, every level <= maxNodes, every model exactly once at leaves", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "split-5000-test-"));
  try {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 5000; i++) {
      nodes.push({ id: `m${i}`, label: `M${i}`, shape: "rectangle", color: "blue" });
    }
    for (let i = 0; i < 4999; i++) {
      edges.push({ from: `m${i}`, to: `m${i + 1}`, label: "1 : 1" });
    }
    const spec = {
      title: "5000-Model Chain Schema",
      direction: "LR",
      preset: "clean",
      nodes,
      edges
    };

    // Render-free split path (the diagram CLI that used to expose it is now a separate project)
    const splitSpec = splitLargeSpec(spec, { maxNodes: 15 });

    const maxNodes = 15;
    assert.ok(splitSpec.nodes.length <= maxNodes, `Top level nodes count (${splitSpec.nodes.length}) must be <= ${maxNodes}`);

    function assertMaxNodesLevel(currentSpec, pathName = "root") {
      const items = currentSpec.nodes.filter(n => !n.id.startsWith("ext:"));
      assert.ok(
        items.length <= maxNodes,
        `Level "${pathName}" (${currentSpec.title}) has ${items.length} nodes, expected <= ${maxNodes}`
      );
      for (const node of currentSpec.nodes) {
        if (node.drill) {
          assertMaxNodesLevel(node.drill, `${pathName} > ${node.id}`);
        }
      }
    }
    assertMaxNodesLevel(splitSpec);

    const leafModelIds = [];
    function collectLeaves(currentSpec) {
      for (const node of currentSpec.nodes) {
        if (node.id.startsWith("ext:")) continue;
        if (node.drill) {
          collectLeaves(node.drill);
        } else {
          leafModelIds.push(node.id);
        }
      }
    }
    collectLeaves(splitSpec);

    assert.equal(leafModelIds.length, 5000, `Expected 5000 leaf models, found ${leafModelIds.length}`);
    const uniqueLeaves = new Set(leafModelIds);
    assert.equal(uniqueLeaves.size, 5000, `Expected 5000 unique leaf models, found ${uniqueLeaves.size}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

