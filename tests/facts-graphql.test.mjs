import test from "node:test";
import assert from "node:assert/strict";
import { extractFacts } from "../tools/facts.mjs";
import { diffFacts } from "../tools/facts-diff.mjs";
import { evaluateRules, formatMarkdownReport } from "../tools/rules.mjs";
import { RECOMMENDED_RULES } from "../tools/rules-recommended.mjs";

// 1. GraphQL multi-file schema in one directory
test("GraphQL multi-file schema: files in same directory form one schema concatenated in path order", () => {
  const file1 = {
    path: "schema/types.graphql",
    content: `
      type User {
        id: ID!
        name: String!
        posts: [Post!]!
      }

      type Post {
        id: ID!
        title: String!
      }
    `
  };

  const file2 = {
    path: "schema/query.graphql",
    content: `
      type Query {
        user(id: ID!): User
        posts(limit: Int): [Post!]!
      }
    `
  };

  const facts = extractFacts([file1, file2]);

  assert.equal(facts.errors.length, 0);
  assert.equal(facts.sources.length, 2);
  assert.equal(facts.sources[0].kind, "GraphQL");

  // Verify types
  const userType = facts.entities.find(e => e.id === "gql.type:User");
  assert.ok(userType, "User type entity should exist");
  assert.equal(userType.kind, "gql.type");
  assert.equal(userType.attrs.name, "User");
  assert.equal(userType.attrs.kind, "OBJECT");

  const queryType = facts.entities.find(e => e.id === "gql.type:Query");
  assert.ok(queryType, "Query type entity should exist");
  assert.equal(queryType.attrs.kind, "OBJECT");

  // Verify fields
  const userIdField = facts.entities.find(e => e.id === "gql.field:User.id");
  assert.ok(userIdField, "User.id field entity should exist");
  assert.equal(userIdField.attrs.returnType, "ID!");
  assert.deepEqual(userIdField.attrs.args, []);

  const queryUserField = facts.entities.find(e => e.id === "gql.field:Query.user");
  assert.ok(queryUserField, "Query.user field entity should exist");
  assert.equal(queryUserField.attrs.returnType, "User");
  assert.equal(queryUserField.attrs.args.length, 1);
  assert.deepEqual(queryUserField.attrs.args[0], {
    name: "id",
    type: "ID!",
    required: true
  });

  const queryPostsField = facts.entities.find(e => e.id === "gql.field:Query.posts");
  assert.ok(queryPostsField, "Query.posts field entity should exist");
  assert.equal(queryPostsField.attrs.args[0].required, false);
});

// 2. A removed field -> gql.breaking
test("GraphQL removed field produces gql.breaking change event", () => {
  const baseFiles = [
    {
      path: "schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
          email: String
        }

        type Query {
          user(id: ID!): User
        }
      `
    }
  ];

  const headFiles = [
    {
      path: "schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
        }

        type Query {
          user(id: ID!): User
        }
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);

  const diff = diffFacts(baseFacts, headFacts);

  const breakingEvent = diff.events.find(e => e.type === "gql.breaking");
  assert.ok(breakingEvent, "Expected gql.breaking event when a field is removed");
  assert.equal(breakingEvent.changeType, "FIELD_REMOVED");
  assert.ok(breakingEvent.description.includes("User.email"), "Event description should mention User.email");
});

// 3. A new optional arg -> no breaking (only dangerous or safe)
test("GraphQL new optional argument does not produce gql.breaking change event", () => {
  const baseFiles = [
    {
      path: "schema.graphql",
      content: `
        type Query {
          search: String
        }
      `
    }
  ];

  const headFiles = [
    {
      path: "schema.graphql",
      content: `
        type Query {
          search(query: String): String
        }
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);

  const diff = diffFacts(baseFacts, headFacts);

  const breakingEvents = diff.events.filter(e => e.type === "gql.breaking");
  assert.equal(breakingEvents.length, 0, "New optional argument should not produce breaking changes");

  const dangerousEvent = diff.events.find(e => e.type === "gql.dangerous");
  assert.ok(dangerousEvent, "New optional argument produces dangerous change event");
  assert.equal(dangerousEvent.changeType, "OPTIONAL_ARG_ADDED");
});

// 4. A broken head file -> parseErrors not removals
test("GraphQL broken head file produces parseErrors, never 'everything removed'", () => {
  const baseFiles = [
    {
      path: "schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
        }

        type Query {
          user: User
        }
      `
    }
  ];

  // Head file has a syntax error (missing closing brace)
  const headFiles = [
    {
      path: "schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  assert.ok(baseFacts.entities.length > 0);

  const headFacts = extractFacts(headFiles);
  assert.ok(headFacts.errors.length > 0, "head facts should report errors");
  assert.ok(headFacts.parseErrors.length > 0, "head facts should report parseErrors");

  const diff = diffFacts(baseFacts, headFacts);

  // Must have parseErrors entry
  assert.ok(diff.parseErrors && diff.parseErrors.length > 0, "diff should contain parseErrors");

  // Must NOT report all base entities as removed
  const removedEntityEvents = diff.events.filter(e => e.type === "entity.removed");
  assert.equal(removedEntityEvents.length, 0, "Broken head file must never emit 'everything removed'");
});

// 5. Built-in recommended rules evaluate GraphQL breaking and dangerous events
test("GraphQL rules in archtour:recommended fire at soft (breaking) and warn (dangerous)", () => {
  const baseFiles = [
    {
      path: "schema.graphql",
      content: `
        enum Status {
          ACTIVE
          INACTIVE
        }
        type User {
          id: ID!
          status: Status!
          secret: String
        }
        type Query {
          me: User
        }
      `
    }
  ];

  const headFiles = [
    {
      path: "schema.graphql",
      content: `
        enum Status {
          ACTIVE
          INACTIVE
          PENDING
        }
        type User {
          id: ID!
          status: Status!
        }
        type Query {
          me: User
        }
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  const { findings } = evaluateRules(RECOMMENDED_RULES, diff, baseFacts, headFacts);

  // Breaking finding: removed User.secret (soft)
  const breakingFinding = findings.find(f => f.event.type === "gql.breaking");
  assert.ok(breakingFinding, "Breaking rule should fire for removed field");
  assert.equal(breakingFinding.level, "soft");

  // Dangerous finding: added PENDING to enum (warn)
  const dangerousFinding = findings.find(f => f.event.type === "gql.dangerous");
  assert.ok(dangerousFinding, "Dangerous rule should fire for enum value added");
  assert.equal(dangerousFinding.level, "warn");
});

// 6. GraphQL removed field finding text contains "User.name"
test("GraphQL removed field finding text contains 'User.name' and carries specific detail", () => {
  const baseFiles = [
    {
      path: "schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
        }

        type Query {
          user(id: ID!): User
        }
      `
    }
  ];

  const headFiles = [
    {
      path: "schema.graphql",
      content: `
        type User {
          id: ID!
        }

        type Query {
          user(id: ID!): User
        }
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  const { findings } = evaluateRules(RECOMMENDED_RULES, diff, baseFacts, headFacts);

  const finding = findings.find(f => f.ruleId === "gql-breaking");
  assert.ok(finding, "gql-breaking finding should exist");

  // Finding text contains "User.name"
  assert.ok(
    finding.message.includes("User.name"),
    `Expected finding.message to contain 'User.name', got: "${finding.message}"`
  );

  // detail field in JSON carries specific event description
  assert.ok(
    finding.detail && finding.detail.includes("User.name"),
    `Expected finding.detail to contain 'User.name', got: "${finding.detail}"`
  );

  // Finding message is rule message + " - " + event message
  assert.equal(
    finding.message,
    "GraphQL schema breaking change detected. - Field User.name was removed."
  );

  // Markdown report contains "User.name"
  const md = formatMarkdownReport(findings);
  assert.ok(md.includes("User.name"), "Markdown report must contain 'User.name'");
});

// 7. Deleting a GraphQL schema: base folder with no head entry produces gql.breaking
test("GraphQL schema deletion produces gql.breaking change event", async () => {
  const baseFiles = [
    {
      path: "graph/schema.graphql",
      content: `
        type User {
          id: ID!
          email: String
        }

        type Query {
          me: User
        }
      `
    }
  ];

  // Head has no schema file (deleted)
  const headFiles = [];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);

  // Simulate what facts.mjs does: store schemas in _graphqlSchemas
  baseFacts._graphqlSchemas = baseFacts._graphqlSchemas || [];
  headFacts._graphqlSchemas = headFacts._graphqlSchemas || [];

  // The extractFacts already populates _graphqlSchemas via parseGraphQLFacts
  // For testing diffGraphQL directly, we need to construct the schemas manually
  const { diffGraphQL } = await import("../tools/facts-graphql.mjs");

  // Build base schema entry
  const baseSchemaEntry = baseFacts._graphqlSchemas.find(s => s.dir === "graph") || {
    dir: "graph",
    sdl: baseFiles[0].content,
    schema: null
  };
  if (!baseFacts._graphqlSchemas.some(s => s.dir === "graph")) {
    baseFacts._graphqlSchemas.push(baseSchemaEntry);
  }

  const events = diffGraphQL(baseFacts, headFacts, new Map(), new Map());

  const breakingEvent = events.find(e => e.type === "gql.breaking");
  assert.ok(breakingEvent, "Expected gql.breaking event when a schema is deleted");
});

// 8. Moving a GraphQL schema with no content change: no gql finding
test("GraphQL schema move with identical content produces no gql finding", async () => {
  const baseFiles = [
    {
      path: "graph/schema.graphql",
      content: `
        type User {
          id: ID!
          email: String
        }

        type Query {
          me: User
        }
      `
    }
  ];

  const headFiles = [
    {
      path: "api/schema.graphql",
      content: `
        type User {
          id: ID!
          email: String
        }

        type Query {
          me: User
        }
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);

  baseFacts._graphqlSchemas = baseFacts._graphqlSchemas || [];
  headFacts._graphqlSchemas = headFacts._graphqlSchemas || [];

  const { diffGraphQL } = await import("../tools/facts-graphql.mjs");

  // Base has graph/schema.graphql, head has api/schema.graphql (new dir)
  if (!baseFacts._graphqlSchemas.some(s => s.dir === "graph")) {
    baseFacts._graphqlSchemas.push({
      dir: "graph",
      sdl: baseFiles[0].content,
      schema: null
    });
  }
  if (!headFacts._graphqlSchemas.some(s => s.dir === "api")) {
    headFacts._graphqlSchemas.push({
      dir: "api",
      sdl: headFiles[0].content,
      schema: null
    });
  }

  const events = diffGraphQL(baseFacts, headFacts, new Map(), new Map());

  // No breaking changes because content is identical (just moved)
  const breakingEvents = events.filter(e => e.type === "gql.breaking");
  assert.equal(breakingEvents.length, 0, "Moving a schema with no content change should not produce gql.breaking");
});

// 9. Moving a GraphQL schema and removing a field produces gql.breaking
test("GraphQL schema move with field removal produces gql.breaking", async () => {
  const baseFiles = [
    {
      path: "graph/schema.graphql",
      content: `
        type User {
          id: ID!
          email: String
        }

        type Query {
          me: User
        }
      `
    }
  ];

  const headFiles = [
    {
      path: "api/schema.graphql",
      content: `
        type User {
          id: ID!
        }

        type Query {
          me: User
        }
      `
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);

  baseFacts._graphqlSchemas = baseFacts._graphqlSchemas || [];
  headFacts._graphqlSchemas = headFacts._graphqlSchemas || [];

  const { diffGraphQL } = await import("../tools/facts-graphql.mjs");

  // Base has graph/schema.graphql, head has api/schema.graphql with email removed
  if (!baseFacts._graphqlSchemas.some(s => s.dir === "graph")) {
    baseFacts._graphqlSchemas.push({
      dir: "graph",
      sdl: baseFiles[0].content,
      schema: null
    });
  }
  if (!headFacts._graphqlSchemas.some(s => s.dir === "api")) {
    headFacts._graphqlSchemas.push({
      dir: "api",
      sdl: headFiles[0].content,
      schema: null
    });
  }

  const events = diffGraphQL(baseFacts, headFacts, new Map(), new Map());

  const breakingEvent = events.find(e => e.type === "gql.breaking");
  assert.ok(breakingEvent, "Expected gql.breaking event when a field is removed in a moved schema");
  assert.ok(breakingEvent.description.includes("User.email"), "Event description should mention User.email");
});

// 10. GraphQL operation file (query only) is not treated as a schema - no parse error
test("GraphQL operation file with only query definition produces no parse error", () => {
  const file1 = {
    path: "src/queries/getUser.graphql",
    content: `query GetUser($id: ID!) { user(id: $id) { id name } }`
  };

  const facts = extractFacts([file1]);

  // Should not produce parse errors
  assert.equal(facts.errors.length, 0, "operation file should not cause parse error");
  assert.equal(facts.parseErrors.length, 0, "operation file should not cause parseErrors");
  // No schema entities should be extracted (no type-system definitions)
  assert.equal(facts.entities.filter(e => e.kind.startsWith("gql.")).length, 0, "no gql entities from operation-only file");
});

// 11. Editing a GraphQL operation file produces no parse error on second extraction
test("Editing a GraphQL operation file produces no parse error on re-extraction", () => {
  const file1 = {
    path: "src/queries/getUser.graphql",
    content: `query GetUser($id: ID!) { user(id: $id) { id name } }`
  };
  const file2 = {
    path: "src/queries/getUser.graphql",
    content: `query GetUser($id: ID!) { user(id: $id) { id name email } }`
  };

  const facts1 = extractFacts([file1]);
  const facts2 = extractFacts([file2]);

  assert.equal(facts1.errors.length, 0);
  assert.equal(facts2.errors.length, 0);
  assert.equal(facts1.parseErrors.length, 0);
  assert.equal(facts2.parseErrors.length, 0);
});

// 12. Schema folder with schema.graphql plus operation file: removing a schema field still produces gql-breaking
test("Schema folder with schema + operation file: removing schema field still produces gql-breaking", () => {
  const baseFiles = [
    {
      path: "schema/schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
          email: String
        }

        type Query {
          user(id: ID!): User
        }
      `
    },
    {
      path: "schema/getUser.graphql",
      content: `query GetUser($id: ID!) { user(id: $id) { id name } }`
    }
  ];

  const headFiles = [
    {
      path: "schema/schema.graphql",
      content: `
        type User {
          id: ID!
          name: String!
        }

        type Query {
          user(id: ID!): User
        }
      `
    },
    {
      path: "schema/getUser.graphql",
      content: `query GetUser($id: ID!) { user(id: $id) { id name } }`
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);

  const diff = diffFacts(baseFacts, headFacts);

  // Should still detect the breaking change (email removed)
  const breakingEvent = diff.events.find(e => e.type === "gql.breaking");
  assert.ok(breakingEvent, "Expected gql.breaking event when schema field is removed");
  assert.ok(breakingEvent.description.includes("User.email"), "Event description should mention User.email");
});
