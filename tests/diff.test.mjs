import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeSpecDiff, createVisualDiffSpec, formatMarkdownDiff, loadOrParseSpec, formatNonZeroSummary, mdText, mdCode } from "../tools/diff.mjs";
import { parsePrismaSchema } from "../tools/from-code.mjs";

test("computeSpecDiff identifies added, removed, and modified nodes", () => {
  const baseSpec = {
    nodes: [
      { id: "user", label: "User" },
      { id: "auth", label: "Auth API" },
      { id: "legacy", label: "Legacy DB" }
    ],
    edges: [
      { from: "user", to: "auth" },
      { from: "auth", to: "legacy" }
    ]
  };

  const headSpec = {
    nodes: [
      { id: "user", label: "User" },
      { id: "auth", label: "OAuth2 / OIDC Service" }, // modified label
      { id: "postgres", label: "Postgres DB" } // added node (legacy removed)
    ],
    edges: [
      { from: "user", to: "auth" },
      { from: "auth", to: "postgres" } // added edge (legacy removed)
    ]
  };

  const diff = computeSpecDiff(baseSpec, headSpec);

  assert.equal(diff.hasChanges, true);
  assert.equal(diff.addedNodes.length, 1);
  assert.equal(diff.addedNodes[0].id, "postgres");

  assert.equal(diff.removedNodes.length, 1);
  assert.equal(diff.removedNodes[0].id, "legacy");

  assert.equal(diff.modifiedNodes.length, 1);
  assert.equal(diff.modifiedNodes[0].head.id, "auth");
  assert.equal(diff.modifiedNodes[0].base.label, "Auth API");
  assert.equal(diff.modifiedNodes[0].head.label, "OAuth2 / OIDC Service");

  assert.equal(diff.addedEdges.length, 1);
  assert.equal(diff.addedEdges[0].to, "postgres");

  assert.equal(diff.removedEdges.length, 1);
  assert.equal(diff.removedEdges[0].to, "legacy");
});

test("computeSpecDiff reports no changes for identical specs", () => {
  const spec = {
    nodes: [{ id: "app", label: "App" }],
    edges: []
  };

  const diff = computeSpecDiff(spec, spec);
  assert.equal(diff.hasChanges, false);
  assert.equal(diff.addedNodes.length, 0);
  assert.equal(diff.removedNodes.length, 0);
  assert.equal(diff.modifiedNodes.length, 0);
});

test("createVisualDiffSpec produces valid visual diagram spec with diff indicators", () => {
  const base = {
    title: "System v1",
    nodes: [{ id: "a", label: "Service A" }, { id: "b", label: "Service B" }],
    edges: [{ from: "a", to: "b" }]
  };
  const head = {
    title: "System v2",
    nodes: [{ id: "a", label: "Service A (v2)" }, { id: "c", label: "Service C" }],
    edges: [{ from: "a", to: "c" }]
  };

  const diff = computeSpecDiff(base, head);
  const visualSpec = createVisualDiffSpec(base, head, diff);

  assert.equal(visualSpec.title, "Diff: System v2");
  assert.ok(visualSpec.subtitle.includes("1 added, 1 removed, 1 modified"));

  // Check green for added node C
  const nodeC = visualSpec.nodes.find((n) => n.id === "c");
  assert.ok(nodeC);
  assert.equal(nodeC.color, "green");
  assert.ok(nodeC.label.startsWith("+"));

  // Check red for removed node B
  const nodeB = visualSpec.nodes.find((n) => n.id === "b");
  assert.ok(nodeB);
  assert.equal(nodeB.color, "red");
  assert.ok(nodeB.label.startsWith("-"));

  // Check orange for modified node A
  const nodeA = visualSpec.nodes.find((n) => n.id === "a");
  assert.ok(nodeA);
  assert.equal(nodeA.color, "orange");
  assert.ok(nodeA.label.startsWith("~"));
});

test("formatMarkdownDiff outputs GitHub-compatible markdown for PR comments", () => {
  const diff = {
    hasChanges: true,
    addedNodes: [{ id: "PaymentGateway", label: "Stripe Gateway" }],
    removedNodes: [{ id: "MockPay", label: "Mock Payments" }],
    modifiedNodes: [{ base: { id: "User", label: "User" }, head: { id: "User", label: "Customer Profile" } }],
    addedEdges: [{ from: "User", to: "PaymentGateway", label: "pays" }],
    removedEdges: [{ from: "User", to: "MockPay" }],
    modifiedEdges: []
  };

  const md = formatMarkdownDiff(diff, { title: "Architecture Changes (PR #12)" });

  assert.ok(md.includes("### 📊 Architecture Changes (PR #12)"));
  assert.ok(md.includes("| **Nodes / Components** | 1 | 1 | 1 |"));
  assert.ok(md.includes("🟢 Added Components"));
  assert.ok(md.includes("Stripe Gateway"));
  assert.ok(md.includes("🔴 Removed Components"));
  assert.ok(md.includes("Mock Payments"));
  assert.ok(md.includes("🟠 Modified Components"));
  assert.ok(md.includes("🟢 Added Connections"));
  assert.ok(md.includes("`User` ➔ `PaymentGateway`"));
});

test("loadOrParseSpec supports schema strings and shorthand formats", () => {
  const prismaSchema = `
    model Team {
      id Int @id
      members User[]
    }
    model User {
      id Int @id
      team Team @relation(fields: [teamId], references: [id])
      teamId Int
    }
  `;

  const spec = loadOrParseSpec(prismaSchema, "schema.prisma");
  assert.ok(spec.nodes.some((n) => n.id === "team"));
  assert.ok(spec.nodes.some((n) => n.id === "user"));
  assert.ok(spec.edges.length > 0);
});

// The demo schemas used to live in examples/; they are written to a temp dir so the fixture travels with the test.
const DEMO_V1 = `// Initial E-Commerce / SaaS Database Schema (v1)

model User {
  id        Int       @id
  email     String    @unique
  name      String
  posts     Post[]
  sessions  Session[]
}

model Session {
  id        String    @id
  userId    Int
  user      User      @relation(fields: [userId], references: [id])
  token     String    @unique
  expiresAt DateTime
}

model Post {
  id        Int       @id
  title     String
  content   String
  authorId  Int
  author    User      @relation(fields: [authorId], references: [id])
}
`;

const DEMO_V2 = `// Updated E-Commerce / SaaS Database Schema (v2)
// Changes:
// - Removed Session (migrated to stateless JWT / Clerk)
// - Added PaymentMethod and Subscription (Stripe integration)
// - Modified Post (added tags and published status)

model User {
  id            Int             @id
  email         String          @unique
  name          String
  posts         Post[]
  subscriptions Subscription[]
}

model Post {
  id        Int       @id
  title     String
  content   String
  published Boolean
  tags      String[]
  authorId  Int
  author    User      @relation(fields: [authorId], references: [id])
}

model Subscription {
  id             String         @id
  userId         Int
  user           User           @relation(fields: [userId], references: [id])
  plan           String
  status         String
  paymentMethods PaymentMethod[]
}

model PaymentMethod {
  id             String         @id
  subscriptionId String
  subscription   Subscription   @relation(fields: [subscriptionId], references: [id])
  brand          String
  last4          String
}
`;

function writeDemoSchemas() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-demo-schemas-"));
  const v1Path = path.join(tmp, "demo-v1.prisma");
  const v2Path = path.join(tmp, "demo-v2.prisma");
  fs.writeFileSync(v1Path, DEMO_V1);
  fs.writeFileSync(v2Path, DEMO_V2);
  return { tmp, v1Path, v2Path };
}

test("diff of the demo prisma v1 vs v2 reports exactly the real field changes for Post and User and nothing for unchanged models", () => {
  const { tmp, v1Path, v2Path } = writeDemoSchemas();
  try {
  const specV1 = loadOrParseSpec(v1Path);
  const specV2 = loadOrParseSpec(v2Path);

  const diff = computeSpecDiff(specV1, specV2);

  assert.equal(diff.hasChanges, true);

  // Added models: Subscription, PaymentMethod
  assert.equal(diff.addedNodes.length, 2);
  const addedIds = diff.addedNodes.map(n => n.id).sort();
  assert.deepEqual(addedIds, ["paymentmethod", "subscription"]);

  // Removed model: Session
  assert.equal(diff.removedNodes.length, 1);
  assert.equal(diff.removedNodes[0].id, "session");

  // Modified models: Post, User
  assert.equal(diff.modifiedNodes.length, 2);

  // Check Post real field changes: + published: Boolean, + tags: String[], 0 removed, 0 modified
  const postMod = diff.modifiedNodes.find(m => m.head.id === "post");
  assert.ok(postMod);
  assert.equal(postMod.fieldChanges.added.length, 2);
  assert.equal(postMod.fieldChanges.removed.length, 0);
  assert.equal(postMod.fieldChanges.modified.length, 0);
  const postAddedNames = postMod.fieldChanges.added.map(f => f.name).sort();
  assert.deepEqual(postAddedNames, ["published", "tags"]);

  // Check User real field changes: + subscriptions: Subscription[], - sessions: Session[], 0 modified
  const userMod = diff.modifiedNodes.find(m => m.head.id === "user");
  assert.ok(userMod);
  assert.equal(userMod.fieldChanges.added.length, 1);
  assert.equal(userMod.fieldChanges.added[0].name, "subscriptions");
  assert.equal(userMod.fieldChanges.removed.length, 1);
  assert.equal(userMod.fieldChanges.removed[0].name, "sessions");
  assert.equal(userMod.fieldChanges.modified.length, 0);

  // Visual diff spec labels and detail
  const visualSpec = createVisualDiffSpec(specV1, specV2, diff);
  const vPost = visualSpec.nodes.find(n => n.id === "post");
  assert.ok(vPost);
  assert.equal(vPost.label, "~ Post\n+ published: Boolean\n+ tags: String[]");
  assert.ok(vPost.label.includes("+ published: Boolean"));
  assert.equal(vPost.tooltip, "+2 fields");
  assert.ok(vPost.detail.includes("+ published: Boolean"));
  assert.ok(vPost.detail.includes("+ tags: String[]"));

  const vUser = visualSpec.nodes.find(n => n.id === "user");
  assert.ok(vUser);
  assert.equal(vUser.label, "~ User\n+ subscriptions: Subscription[]\n- sessions: Session[]");
  assert.equal(vUser.tooltip, "+1 / -1 fields");
  assert.ok(vUser.detail.includes("+ subscriptions: Subscription[]"));
  assert.ok(vUser.detail.includes("- sessions: Session[]"));

  // Verify unchanged model behavior:
  // Create base & head schemas with an unchanged model 'Tag'
  const baseWithTag = parsePrismaSchema(`
    model Tag {
      id   Int    @id
      name String
    }
    model Item {
      id    Int    @id
      count Int
    }
  `);
  const headWithTag = parsePrismaSchema(`
    model Tag {
      id   Int    @id
      name String
    }
    model Item {
      id    Int    @id
      count Int
      desc  String
    }
  `);

  const tagDiff = computeSpecDiff(baseWithTag, headWithTag);
  // Tag should be in unchangedNodes, NOT modifiedNodes
  assert.equal(tagDiff.modifiedNodes.length, 1);
  assert.equal(tagDiff.modifiedNodes[0].head.id, "item");
  assert.ok(tagDiff.unchangedNodes.some(n => n.id === "tag"));
  assert.ok(!tagDiff.modifiedNodes.some(m => m.head.id === "tag"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("an identical base/head diff reports zero modified", () => {
  const schema = `
model Account {
  id      Int    @id
  balance Float
}
`;
  const specA = parsePrismaSchema(schema);
  const specB = parsePrismaSchema(schema);

  const diff = computeSpecDiff(specA, specB);
  assert.equal(diff.hasChanges, false);
  assert.equal(diff.modifiedNodes.length, 0);
  assert.equal(diff.addedNodes.length, 0);
  assert.equal(diff.removedNodes.length, 0);
  assert.equal(diff.unchangedNodes.length, 1);

  const md = formatMarkdownDiff(diff);
  assert.ok(md.includes("No architectural changes detected"));
});

test("formatMarkdownDiff output contains no lines breaking table cells and collapses labels", () => {
  const { tmp, v1Path, v2Path } = writeDemoSchemas();
  try {
  const specV1 = loadOrParseSpec(v1Path);
  const specV2 = loadOrParseSpec(v2Path);

  const diff = computeSpecDiff(specV1, specV2);
  const md = formatMarkdownDiff(diff, { title: "PR Schema Diff" });

  // 1. Table lines check: every table row must start with | and not have raw newlines in cells
  const lines = md.split("\n");
  const tableRows = lines.filter(l => l.trim().startsWith("|"));
  assert.equal(tableRows.length, 4); // header, divider, nodes row, edges row
  for (const row of tableRows) {
    assert.ok(row.endsWith("|"));
  }

  // 2. No line starts in the middle of a table row
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("|") && !line.trim().startsWith("|") && !line.trim().startsWith("```")) {
      assert.fail(`Line ${i + 1} appears to start in the middle of a table row: ${line}`);
    }
  }

  // 3. Modified entries list field changes cleanly
  assert.ok(md.includes("- **`post`**: ~ Post  +2 fields"));
  assert.ok(md.includes("  - `+ published: Boolean`"));
  assert.ok(md.includes("  - `+ tags: String[]`"));

  assert.ok(md.includes("- **`user`**: ~ User  +1 / -1 fields"));
  assert.ok(md.includes("  - `+ subscriptions: Subscription[]`"));
  assert.ok(md.includes("  - `- sessions: Session[]`"));

  // 4. Added and removed components have labels on one line
  assert.ok(md.includes("- **`paymentmethod`**: PaymentMethod (5 fields)"));
  assert.ok(md.includes("- **`subscription`**: Subscription (6 fields)"));
  assert.ok(md.includes("- **`session`**: Session (5 fields)"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatMarkdownDiff footer: contains real URL, no <REPO_URL>, and supports { footer: false }", () => {
  const diff = {
    hasChanges: true,
    addedNodes: [{ id: "srv", label: "Service" }],
    removedNodes: [],
    modifiedNodes: [],
    addedEdges: [],
    removedEdges: [],
    modifiedEdges: [],
    unchangedNodes: [],
    unchangedEdges: []
  };

  const mdWithFooter = formatMarkdownDiff(diff);
  assert.ok(mdWithFooter.includes("*Generated by [Archtour](https://github.com/Zune2004/archtour).*"));
  assert.equal(mdWithFooter.includes("<REPO_URL>"), false);

  const mdWithoutFooter = formatMarkdownDiff(diff, { footer: false });
  assert.equal(mdWithoutFooter.includes("*Generated by [Archtour]"), false);
});

test("formatMarkdownDiff compose wording: uses 'change' / 'changes' for Compose services instead of 'fields'", () => {
  const composeBase = `services:
  db:
    image: postgres:15
`;
  const composeHead = `services:
  db:
    image: postgres:16
`;
  const specBase = loadOrParseSpec(composeBase, "docker-compose.yml");
  const specHead = loadOrParseSpec(composeHead, "docker-compose.yml");
  const diff = computeSpecDiff(specBase, specHead);
  const md = formatMarkdownDiff(diff, { title: "docker-compose.yml" });

  // 1 change: singular 'change'
  assert.ok(md.includes("- **`db`**: ~ db  ~1 change"), `Expected '~ db  ~1 change', got:\n${md}`);
  assert.equal(md.includes("fields"), false);

  // Multiple changes in Compose service: plural 'changes'
  const composeHeadMulti = `services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
`;
  const specHeadMulti = loadOrParseSpec(composeHeadMulti, "docker-compose.yml");
  const diffMulti = computeSpecDiff(specBase, specHeadMulti);
  const mdMulti = formatMarkdownDiff(diffMulti, { title: "docker-compose.yml" });
  assert.ok(mdMulti.includes("changes"), `Expected 'changes' in multi-field change, got:\n${mdMulti}`);
  assert.equal(mdMulti.includes("fields"), false);
});

test("diff of two specs where a node gains a field with empty type produces '+ POST /x' without trailing colon in label and markdown", () => {
  const baseSpec = {
    nodes: [
      {
        id: "api",
        label: "API",
        fields: []
      }
    ],
    edges: []
  };

  const headSpec = {
    nodes: [
      {
        id: "api",
        label: "API",
        fields: [{ name: "POST /x", type: "" }]
      }
    ],
    edges: []
  };

  const diff = computeSpecDiff(baseSpec, headSpec);
  const visualSpec = createVisualDiffSpec(baseSpec, headSpec, diff);
  const md = formatMarkdownDiff(diff);

  const modNode = visualSpec.nodes.find((n) => n.id === "api");
  assert.ok(modNode, "modified node should exist in visual spec");
  assert.ok(modNode.label.includes("+ POST /x"), "label should include '+ POST /x'");
  assert.equal(modNode.label.includes("+ POST /x:"), false, "label should not have trailing colon");

  assert.ok(md.includes("+ POST /x"), "markdown should include '+ POST /x'");
  assert.equal(md.includes("+ POST /x:"), false, "markdown should not have trailing colon");

  // Also verify ~ type change with empty side prints (none)
  const baseTypeSpec = {
    nodes: [{ id: "api2", label: "API2", fields: [{ name: "GET /y", type: "" }] }],
    edges: []
  };
  const headTypeSpec = {
    nodes: [{ id: "api2", label: "API2", fields: [{ name: "GET /y", type: "Handler" }] }],
    edges: []
  };
  const diffType = computeSpecDiff(baseTypeSpec, headTypeSpec);
  const visualType = createVisualDiffSpec(baseTypeSpec, headTypeSpec, diffType);
  const mdType = formatMarkdownDiff(diffType);
  const modNode2 = visualType.nodes.find((n) => n.id === "api2");
  assert.ok(modNode2.label.includes("~ GET /y: (none) -> Handler"));
  assert.ok(mdType.includes("~ GET /y: (none) -> Handler"));
});

test("formatNonZeroSummary uses singular 'field' when count is 1", () => {
  assert.equal(formatNonZeroSummary(1, 0, 0, "fields"), "+1 field");
  assert.equal(formatNonZeroSummary(0, 1, 0, "fields"), "-1 field");
  assert.equal(formatNonZeroSummary(0, 0, 1, "fields"), "~1 field");
  assert.equal(formatNonZeroSummary(2, 0, 0, "fields"), "+2 fields");
});

test("mdText helper escapes markdown, wraps code spans with safe backtick fences, and neutralises mentions/issue refs", () => {
  // Code spans
  assert.equal(mdCode("normal"), "`normal`");
  assert.equal(mdCode("a`b"), "``a`b``");
  assert.equal(mdCode("`start"), "`` `start ``");
  assert.equal(mdCode("end`"), "`` end` ``");
  assert.equal(mdCode("`both`"), "`` `both` ``");
  assert.equal(mdCode("a``b"), "```a``b```");

  // Plain text
  assert.equal(mdText("hello\nworld\r\ttest"), "hello world test");
  assert.equal(mdText("@team"), "@\u200Bteam");
  assert.equal(mdText("#123"), "\\#\u200B123");
  assert.equal(mdText("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(mdText("<!-- comment -->"), "&lt;\\!-- comment --&gt;");
  assert.equal(mdText("</details>"), "&lt;/details&gt;");
  assert.ok(mdText("*bold* _italic_ [link](url) | pipe ! bang ~ tilde ` tick \\ slash").includes("\\*bold\\*"));
  assert.ok(mdText("\\").includes("\\\\"));

  // Cap at max with …
  const longText = "x".repeat(250);
  const capped = mdText(longText, 200);
  assert.equal(capped.length, 201);
  assert.ok(capped.endsWith("…"));
});

test("PR diff markdown renders injection payloads inert without raw HTML or unclosed tags", () => {
  const diff = {
    hasChanges: true,
    addedNodes: [
      {
        id: "evil-svc",
        label: '<img src=x onerror=alert(1)> @team\n✅ Approved by security\n<!-- unclosed comment hiding artifact link'
      }
    ],
    removedNodes: [
      {
        id: "old-svc",
        label: '</details>\n<!-- hiding footer'
      }
    ],
    modifiedNodes: [
      {
        base: { id: "api", label: "API" },
        head: {
          id: "api",
          label: "~ </details> <script>evil</script>",
          fields: [
            { name: "SECRET`> env_key", type: "env" },
            { name: "status", type: "✅ Approved by security" }
          ]
        },
        hasFields: true,
        fieldChanges: {
          added: [{ name: "SECRET`> env_key", type: "env" }],
          removed: [],
          modified: [{ base: { name: "status", type: "draft" }, head: { name: "status", type: "✅ Approved by security" } }]
        }
      }
    ],
    addedEdges: [],
    removedEdges: [],
    modifiedEdges: [],
    unchangedNodes: [],
    unchangedEdges: []
  };

  const md = formatMarkdownDiff(diff, { title: "Injected PR Diff" });

  // Assert no raw <img
  assert.ok(!md.includes("<img"), `Markdown should not contain raw <img:\n${md}`);
  assert.ok(md.includes("&lt;img src=x onerror=alert(1)&gt;"), `Expected escaped img tag in markdown:\n${md}`);

  // Assert no raw <!-- unclosed comment (other than archtour diff marker if any)
  assert.ok(!md.includes("<!-- unclosed"), `Markdown should not contain raw <!-- unclosed:\n${md}`);
  assert.ok(!md.includes("<!-- hiding"), `Markdown should not contain raw <!-- hiding:\n${md}`);

  // Assert no </details> injected from user text (only exactly the 1 real closing </details> at the end)
  const detailsCount = (md.match(/<\/details>/g) || []).length;
  assert.equal(detailsCount, 1, `Expected exactly 1 closing </details> tag, got ${detailsCount}:\n${md}`);

  // Assert @team is not an active mention
  assert.ok(!md.includes("@team"), `@team should be neutralised with zero-width space:\n${md}`);
  assert.ok(md.includes("@\u200Bteam"), `Expected @\\u200Bteam in markdown:\n${md}`);

  // Fake status text is escaped and safe
  assert.ok(md.includes("✅ Approved by security"));
});

test("computeSpecDiff reports WEB as added when added next to web in head", () => {
  const baseSpec = {
    title: "Container Infrastructure",
    nodes: [
      { id: "web", name: "web", label: "web\n(nginx:alpine)", image: "nginx:alpine" }
    ],
    edges: []
  };

  const headSpec = {
    title: "Container Infrastructure",
    nodes: [
      { id: "web", name: "WEB", label: "WEB\n(docker:dind)", image: "docker:dind" },
      { id: "web-2", name: "web", label: "web\n(nginx:alpine)", image: "nginx:alpine" }
    ],
    edges: []
  };

  const diff = computeSpecDiff(baseSpec, headSpec);

  assert.equal(diff.hasChanges, true);
  assert.equal(diff.addedNodes.length, 1);
  assert.equal(diff.addedNodes[0].name, "WEB");
  assert.equal(diff.removedNodes.length, 0);
  assert.equal(diff.unchangedNodes.length, 1);
  assert.equal(diff.unchangedNodes[0].name, "web");
});

