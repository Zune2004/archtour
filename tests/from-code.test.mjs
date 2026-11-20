import test from "node:test";
import assert from "node:assert/strict";
import { parsePrismaSchema, parseDockerCompose, parseOpenApi } from "../tools/from-code.mjs";

test("parsePrismaSchema extracts models and relationships into diagram spec", () => {
  const schema = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  posts     Post[]
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  author    User     @relation(fields: [authorId], references: [id])
  authorId  Int
}
`;

  const spec = parsePrismaSchema(schema);
  assert.equal(spec.nodes.length, 2);
  assert.equal(spec.edges.length, 1);

  const userNode = spec.nodes.find(n => n.id === "user");
  const postNode = spec.nodes.find(n => n.id === "post");
  assert.ok(userNode);
  assert.ok(postNode);
  assert.ok(userNode.label.includes("posts → Post[]"));
  assert.ok(postNode.label.includes("author → User"));

  const edge = spec.edges[0];
  assert.equal(edge.from, "user");
  assert.equal(edge.to, "post");
  assert.equal(edge.label, "1 : N");
});

test("Prisma label shows field lines with markers and +N more", () => {
  const schema = `
model Customer {
  id          Int      @id @default(autoincrement())
  email       String   @unique
  orders      Order[]
  firstName   String
  lastName    String
  phone       String?
  city        String
  country     String
  status      String
}

model Order {
  id          Int      @id
  customerId  Int
  customer    Customer @relation(fields: [customerId], references: [id])
}
`;

  const spec = parsePrismaSchema(schema);
  const custNode = spec.nodes.find(n => n.id === "customer");
  assert.ok(custNode);

  // Label must show model name, up to 6 field lines with markers, then +N more
  const lines = custNode.label.split("\n");
  assert.equal(lines[0], "Customer");
  assert.ok(lines.some(l => l.includes("id: Int 🔑")));
  assert.ok(lines.some(l => l.includes("orders → Order[]")));
  assert.equal(lines[lines.length - 1], "+3 more");
  assert.equal(custNode.tooltip, "9 fields");

  const orderNode = spec.nodes.find(n => n.id === "order");
  assert.ok(orderNode.label.includes("customer → Customer"));
});

test("Prisma detail table lists all fields and node has machine-readable fields array", () => {
  const schema = `
model Product {
  id          Int      @id @default(autoincrement())
  sku         String   @unique
  name        String
  price       Float
  items       Item[]
}

model Item {
  id          Int      @id
  productId   Int
  product     Product  @relation(fields: [productId], references: [id])
}
`;

  const spec = parsePrismaSchema(schema);
  const prod = spec.nodes.find(n => n.id === "product");
  assert.ok(prod);

  // Detail table header and rows
  assert.ok(prod.detail.includes("| Field | Type | Attributes |"));
  assert.ok(prod.detail.includes("| id | Int | id, default |"));
  assert.ok(prod.detail.includes("| sku | String | unique |"));
  assert.ok(prod.detail.includes("| name | String |"));
  assert.ok(prod.detail.includes("| price | Float |"));
  assert.ok(prod.detail.includes("| items | Item[] | → Item |"));

  // Machine-readable fields array
  assert.equal(prod.fields.length, 5);
  const idField = prod.fields.find(f => f.name === "id");
  assert.equal(idField.type, "Int");
  assert.ok(idField.attrs.includes("id"));
  assert.ok(idField.attrs.includes("default"));

  const skuField = prod.fields.find(f => f.name === "sku");
  assert.equal(skuField.type, "String");
  assert.ok(skuField.attrs.includes("unique"));

  const itemsField = prod.fields.find(f => f.name === "items");
  assert.equal(itemsField.type, "Item[]");
  assert.ok(itemsField.attrs.includes("Item"));
});

test("parseDockerCompose extracts microservices and dependencies", () => {
  const compose = `
version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
    depends_on:
      - api
  api:
    image: node:18-alpine
    depends_on:
      - db
      - redis
  db:
    image: postgres:15
  redis:
    image: redis:alpine
`;

  const spec = parseDockerCompose(compose);
  assert.equal(spec.nodes.length, 4);

  const byId = new Map(spec.nodes.map(n => [n.id, n]));
  assert.equal(byId.get("web").color, "blue");
  assert.equal(byId.get("api").color, "violet");
  assert.equal(byId.get("db").shape, "ellipse");
  assert.equal(byId.get("db").color, "green");

  assert.equal(spec.edges.length, 3);
  const webEdge = spec.edges.find(e => e.from === "web" && e.to === "api");
  assert.ok(webEdge);
  assert.equal(webEdge.label, "depends on");
});

test("parseDockerCompose handles flow-list and map-form depends_on and links to produce edges", () => {
  const compose = `
services:
  gateway:
    image: traefik:v2
    ports:
      - "80:80"
    depends_on: [api, worker]
    links:
      - cache
  api:
    image: node:20
    depends_on:
      db:
        condition: service_healthy
      queue:
        condition: service_started
  worker:
    build: ./worker
    depends_on: {queue: {condition: service_healthy}}
  db:
    image: postgres:16
  queue:
    image: rabbitmq:3
  cache:
    image: redis:7
`;

  const spec = parseDockerCompose(compose);
  assert.equal(spec.nodes.length, 6);

  // Flow-list edges from gateway
  assert.ok(spec.edges.some(e => e.from === "gateway" && e.to === "api"));
  assert.ok(spec.edges.some(e => e.from === "gateway" && e.to === "worker"));
  // Link edge from gateway to cache
  assert.ok(spec.edges.some(e => e.from === "gateway" && e.to === "cache"));

  // Map-form edges from api
  assert.ok(spec.edges.some(e => e.from === "api" && e.to === "db"));
  assert.ok(spec.edges.some(e => e.from === "api" && e.to === "queue"));

  // Inline map-form edge from worker
  assert.ok(spec.edges.some(e => e.from === "worker" && e.to === "queue"));
});

test("compose env VALUES never appear anywhere in the output spec", () => {
  const compose = `
services:
  backend:
    image: myapp:1.0
    environment:
      - DATABASE_URL=postgres://admin:SECRET_VALUE_123@prod-db:5432/main
      - JWT_SECRET=SECRET_VALUE_123
      - STRIPE_KEY=SECRET_VALUE_123
    ports:
      - "3000:3000"
    volumes:
      - app_data:/data
  worker:
    image: worker:1.0
    environment:
      AUTH_TOKEN: SECRET_VALUE_123
      REDIS_PASSWORD: SECRET_VALUE_123
`;

  const spec = parseDockerCompose(compose);
  const specJson = JSON.stringify(spec);

  // MUST NEVER LEAK SECRET_VALUE_123
  assert.equal(specJson.includes("SECRET_VALUE_123"), false);

  // Env variable NAMES must appear
  assert.ok(specJson.includes("DATABASE_URL"));
  assert.ok(specJson.includes("JWT_SECRET"));
  assert.ok(specJson.includes("STRIPE_KEY"));
  assert.ok(specJson.includes("AUTH_TOKEN"));
  assert.ok(specJson.includes("REDIS_PASSWORD"));

  // Machine-readable fields array check
  const backendNode = spec.nodes.find(n => n.id === "backend");
  assert.ok(backendNode.fields.some(f => f.name === "DATABASE_URL" && f.type === "env"));
  assert.ok(backendNode.fields.some(f => f.name === "image" && f.type === "myapp:1.0"));
  assert.ok(backendNode.fields.some(f => f.name === "3000:3000" && f.type === "port"));
  assert.ok(backendNode.fields.some(f => f.name === "app_data" && f.type === "volume"));
});

test("parseOpenApi extracts endpoints and groups by tag with routes detail and fields", () => {
  const api = {
    info: { title: "E-Commerce API" },
    paths: {
      "/orders": {
        post: { tags: ["Orders"], summary: "Create order", operationId: "createOrder" },
        get: { tags: ["Orders"], summary: "List orders", operationId: "listOrders" }
      },
      "/users/{id}": {
        get: { tags: ["Users"], summary: "Get user profile", operationId: "getUser" }
      }
    }
  };

  const spec = parseOpenApi(api);
  assert.equal(spec.title, "E-Commerce API");

  const ordersNode = spec.nodes.find(n => n.id === "orders");
  assert.ok(ordersNode);

  // Machine readable fields
  assert.equal(ordersNode.fields.length, 2);
  assert.ok(ordersNode.fields.some(f => f.name === "POST /orders" && f.type === "createOrder"));
  assert.ok(ordersNode.fields.some(f => f.name === "GET /orders" && f.type === "listOrders"));

  // Detail lists routes
  assert.ok(ordersNode.detail.includes("- `POST /orders` - Create order"));
  assert.ok(ordersNode.detail.includes("- `GET /orders` - List orders"));

  // Client and Gateway have fields array
  const clientNode = spec.nodes.find(n => n.id === "client");
  assert.ok(Array.isArray(clientNode.fields));
});

test("parseDockerCompose supports YAML anchors and merge keys (<<: *default)", () => {
  const compose = `
x-defaults: &default
  image: node:20-alpine
  environment:
    - SHARED_KEY=SHARED_VAL
  ports:
    - "3000:3000"

services:
  app:
    <<: *default
    ports:
      - "8080:8080"
  worker:
    <<: *default
    depends_on:
      - app
`;

  const spec = parseDockerCompose(compose);
  assert.equal(spec.nodes.length, 2);

  const appNode = spec.nodes.find(n => n.id === "app");
  const workerNode = spec.nodes.find(n => n.id === "worker");
  assert.ok(appNode);
  assert.ok(workerNode);

  // app overrides ports
  assert.ok(appNode.fields.some(f => f.name === "8080:8080" && f.type === "port"));
  assert.ok(appNode.fields.some(f => f.name === "image" && f.type === "node:20-alpine"));
  assert.ok(appNode.fields.some(f => f.name === "SHARED_KEY" && f.type === "env"));

  // worker inherits ports and depends on app
  assert.ok(workerNode.fields.some(f => f.name === "3000:3000" && f.type === "port"));
  assert.ok(workerNode.fields.some(f => f.name === "SHARED_KEY" && f.type === "env"));
  assert.ok(spec.edges.some(e => e.from === "worker" && e.to === "app" && e.label === "depends on"));
});

test("parseDockerCompose extracts env variable names from list and env_file without leaking values", () => {
  const compose = `
services:
  backend:
    image: myapp:1.0
    env_file:
      - .env.local
    environment:
      - API_KEY=SECRET_VALUE_123
      - DB_SECRET=SECRET_VALUE_123
      - PLAIN_KEY
`;

  const spec = parseDockerCompose(compose);
  const specJson = JSON.stringify(spec);

  // Must never expose secret values
  assert.equal(specJson.includes("SECRET_VALUE_123"), false);

  const backendNode = spec.nodes.find(n => n.id === "backend");
  assert.ok(backendNode);
  assert.ok(backendNode.fields.some(f => f.name === "API_KEY" && f.type === "env"));
  assert.ok(backendNode.fields.some(f => f.name === "DB_SECRET" && f.type === "env"));
  assert.ok(backendNode.fields.some(f => f.name === "PLAIN_KEY" && f.type === "env"));
  assert.ok(backendNode.fields.some(f => f.name === ".env.local" && f.type === "env"));

  assert.ok(backendNode.detail.includes("`API_KEY`"));
  assert.ok(backendNode.detail.includes("`DB_SECRET`"));
  assert.ok(backendNode.detail.includes("`PLAIN_KEY`"));
  assert.ok(backendNode.detail.includes("`.env.local`"));
});

test("parseOpenApi with YAML produces same nodes and edges as equivalent JSON with 2 tags", () => {
  const jsonText = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Store API" },
    paths: {
      "/products": {
        get: { tags: ["Products"], summary: "List products", operationId: "listProducts" },
        post: { tags: ["Products"], summary: "Create product", operationId: "createProduct" }
      },
      "/orders": {
        get: { tags: ["Orders"], summary: "List orders", operationId: "listOrders" }
      }
    }
  });

  const yamlText = `
openapi: 3.0.0
info:
  title: Store API
paths:
  /products:
    get:
      tags:
        - Products
      summary: List products
      operationId: listProducts
    post:
      tags:
        - Products
      summary: Create product
      operationId: createProduct
  /orders:
    get:
      tags:
        - Orders
      summary: List orders
      operationId: listOrders
`;

  const specFromJson = parseOpenApi(jsonText);
  const specFromYaml = parseOpenApi(yamlText);

  assert.equal(specFromYaml.title, specFromJson.title);
  assert.deepEqual(specFromYaml.nodes, specFromJson.nodes);
  assert.deepEqual(specFromYaml.edges, specFromJson.edges);
});

test("parseDockerCompose and parseOpenApi throw clear error on malformed YAML", () => {
  assert.throws(
    () => parseDockerCompose("services:\n  app:\n    [invalid: {yaml"),
    /Failed to parse Docker Compose YAML|YAML/i
  );
  assert.throws(
    () => parseOpenApi("openapi: 3.0.0\npaths:\n  [invalid: {yaml"),
    /OpenAPI specification must be valid JSON or YAML|YAML/i
  );
});

test("OpenAPI tag node with 1 route uses singular '(1 route)' in label", () => {
  const api = {
    info: { title: "Single Route API" },
    paths: {
      "/health": {
        get: { tags: ["Health"], summary: "Health check" }
      },
      "/items": {
        get: { tags: ["Items"], summary: "List items" },
        post: { tags: ["Items"], summary: "Create item" }
      }
    }
  };

  const spec = parseOpenApi(api);
  const healthNode = spec.nodes.find(n => n.id === "health");
  assert.ok(healthNode);
  assert.equal(healthNode.label, "Health\n(1 route)");
  assert.equal(healthNode.tooltip, "1 endpoint under Health");

  const itemsNode = spec.nodes.find(n => n.id === "items");
  assert.ok(itemsNode);
  assert.equal(itemsNode.label, "Items\n(2 routes)");
  assert.equal(itemsNode.tooltip, "2 endpoints under Items");
});

test("parseDockerCompose assigns unique ids for colliding service names like web and WEB", () => {
  const compose = `
services:
  web:
    image: nginx:alpine
  WEB:
    image: docker:dind
`;
  const spec = parseDockerCompose(compose);
  assert.equal(spec.nodes.length, 2);

  const webNode = spec.nodes.find(n => n.id === "web");
  const web2Node = spec.nodes.find(n => n.id === "web-2");

  assert.ok(webNode);
  assert.ok(web2Node);
  assert.equal(webNode.originalName, "web");
  assert.equal(web2Node.originalName, "WEB");
});

test("parseOpenApi prevents collision between built-in client/gateway nodes and API tags", () => {
  const api = {
    info: { title: "Collision Test API" },
    paths: {
      "/clients": {
        get: { tags: ["Client"], summary: "List clients" }
      },
      "/gateways": {
        get: { tags: ["Gateway"], summary: "List gateways" }
      }
    }
  };

  const spec = parseOpenApi(api);

  // Built-in client and gateway nodes
  const builtinClient = spec.nodes.find(n => n.id === "client");
  const builtinGateway = spec.nodes.find(n => n.id === "gateway");
  assert.ok(builtinClient, "built-in client node must exist");
  assert.equal(builtinClient.label, "Client App");
  assert.ok(builtinGateway, "built-in gateway node must exist");
  assert.equal(builtinGateway.label, "API Gateway");

  // Tag controller nodes should be suffixed to client-2 and gateway-2
  const tagClient = spec.nodes.find(n => n.id === "client-2");
  const tagGateway = spec.nodes.find(n => n.id === "gateway-2");
  assert.ok(tagClient, "Client tag controller should have id client-2");
  assert.ok(tagGateway, "Gateway tag controller should have id gateway-2");

  // Built-in client connects to gateway; gateway connects to tag controllers
  assert.ok(spec.edges.some(e => e.from === "client" && e.to === "gateway"));
  assert.ok(spec.edges.some(e => e.from === "gateway" && e.to === "client-2"));
  assert.ok(spec.edges.some(e => e.from === "gateway" && e.to === "gateway-2"));
});

test("parseOpenApi prevents collision between tags like 'A b' and 'a_b'", () => {
  const api = {
    info: { title: "Tag Collision API" },
    paths: {
      "/ab1": {
        get: { tags: ["A b"], summary: "AB 1" }
      },
      "/ab2": {
        get: { tags: ["a_b"], summary: "AB 2" }
      }
    }
  };

  const spec = parseOpenApi(api);
  const tag1 = spec.nodes.find(n => n.id === "a_b");
  const tag2 = spec.nodes.find(n => n.id === "a_b-2");

  assert.ok(tag1, "First tag should have id a_b");
  assert.ok(tag2, "Second tag should have id a_b-2");
});

test("parsePrismaSchema assigns unique ids when model names collide case-insensitively", () => {
  const schema = `
model User {
  id Int @id
}
model USER {
  id Int @id
}
`;
  const spec = parsePrismaSchema(schema);
  assert.equal(spec.nodes.length, 2);
  const user1 = spec.nodes.find(n => n.id === "user");
  const user2 = spec.nodes.find(n => n.id === "user-2");
  assert.ok(user1);
  assert.ok(user2);
  assert.equal(user1.originalName, "User");
  assert.equal(user2.originalName, "USER");
});

test("parseOpenApi does not crash on paths with null or non-object pathItem", () => {
  const api = {
    info: { title: "Null Path API" },
    paths: {
      "/a": null,
      "/b": undefined,
      "/c": "not-an-object",
      "/d": {
        get: { summary: "Valid endpoint" }
      }
    }
  };
  const spec = parseOpenApi(api);
  assert.ok(spec);
  assert.ok(spec.nodes.length >= 1);
});

test("parseOpenApi parses numeric tags into string controller ids without crash", () => {
  const api = {
    info: { title: "Numeric Tags API" },
    paths: {
      "/items": {
        get: { tags: [123, 456], summary: "Get items" },
        post: { tags: 789, summary: "Create item" }
      }
    }
  };
  const spec = parseOpenApi(api);
  assert.ok(spec);
  const tag1 = spec.nodes.find(n => n.id === "123");
  const tag2 = spec.nodes.find(n => n.id === "456");
  const tag3 = spec.nodes.find(n => n.id === "789");
  assert.ok(tag1, "Tag 123 node should exist");
  assert.ok(tag2, "Tag 456 node should exist");
  assert.ok(tag3, "Tag 789 node should exist");
});

