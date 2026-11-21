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

// 1. Nested messages
test("protobuf parser extracts nested messages and fields with hierarchical names and ids", () => {
  const proto = `
    syntax = "proto3";
    package acme.core;

    message Outer {
      string outer_id = 1;

      message Inner {
        int32 inner_val = 1;

        message Deep {
          bool deep_flag = 1;
        }
      }

      Inner inner = 2;
    }
  `;

  const facts = extractFacts([{ path: "nested.proto", content: proto }]);
  assert.equal(facts.errors.length, 0);

  // Outer message & field
  const outerMsg = facts.entities.find(e => e.id === "proto.message:acme.core.Outer");
  assert.ok(outerMsg, "Outer message entity should exist");
  const outerField = facts.entities.find(e => e.id === "proto.field:acme.core.Outer.outer_id");
  assert.ok(outerField, "Outer.outer_id field should exist with id package.message.field");
  assert.equal(outerField.attrs.number, 1);
  assert.equal(outerField.attrs.type, "string");

  // Inner message & field
  const innerMsg = facts.entities.find(e => e.id === "proto.message:acme.core.Outer.Inner");
  assert.ok(innerMsg, "Outer.Inner message entity should exist");
  const innerField = facts.entities.find(e => e.id === "proto.field:acme.core.Outer.Inner.inner_val");
  assert.ok(innerField, "Outer.Inner.inner_val field should exist");

  // Deep message & field
  const deepMsg = facts.entities.find(e => e.id === "proto.message:acme.core.Outer.Inner.Deep");
  assert.ok(deepMsg, "Outer.Inner.Deep message entity should exist");
  const deepField = facts.entities.find(e => e.id === "proto.field:acme.core.Outer.Inner.Deep.deep_flag");
  assert.ok(deepField, "Outer.Inner.Deep.deep_flag field should exist");
});

// 2. oneof
test("protobuf parser correctly extracts oneof groups on fields", () => {
  const proto = `
    syntax = "proto3";
    package acme.contact;

    message Profile {
      string id = 1;
      oneof contact_method {
        string email = 2;
        string phone_number = 3;
      }
    }
  `;

  const facts = extractFacts([{ path: "contact.proto", content: proto }]);
  assert.equal(facts.errors.length, 0);

  const emailField = facts.entities.find(e => e.id === "proto.field:acme.contact.Profile.email");
  assert.ok(emailField);
  assert.equal(emailField.attrs.oneof, "contact_method");

  const phoneField = facts.entities.find(e => e.id === "proto.field:acme.contact.Profile.phone_number");
  assert.ok(phoneField);
  assert.equal(phoneField.attrs.oneof, "contact_method");

  const idField = facts.entities.find(e => e.id === "proto.field:acme.contact.Profile.id");
  assert.ok(idField);
  assert.equal(idField.attrs.oneof, null);
});

// 3. reserved
test("protobuf parser extracts reserved numbers and names", () => {
  const proto = `
    syntax = "proto3";
    package acme.reserved;

    message Account {
      reserved 2, 15, 9 to 11;
      reserved "foo", "bar";
      string id = 1;
    }
  `;

  const facts = extractFacts([{ path: "reserved.proto", content: proto }]);
  assert.equal(facts.errors.length, 0);

  const accMsg = facts.entities.find(e => e.id === "proto.message:acme.reserved.Account");
  assert.ok(accMsg);
  const reservedNums = accMsg.attrs.reservedNumbers;
  assert.ok(reservedNums.includes(2));
  assert.ok(reservedNums.includes(15));
  assert.ok(reservedNums.includes(9));
  assert.ok(reservedNums.includes(10));
  assert.ok(reservedNums.includes(11));

  const reservedNames = accMsg.attrs.reservedNames;
  assert.ok(reservedNames.includes("foo"));
  assert.ok(reservedNames.includes("bar"));
});

// 4. streaming rpcs
test("protobuf parser extracts services with unary, client, server, and bidirectional streaming rpcs", () => {
  const proto = `
    syntax = "proto3";
    package acme.stream;

    service FlowService {
      rpc UnaryCall (Req) returns (Res);
      rpc ClientStreamCall (stream Req) returns (Res);
      rpc ServerStreamCall (Req) returns (stream Res);
      rpc BidiStreamCall (stream Req) returns (stream Res) {
        option (custom.opt) = { timeout: 30 };
      }
    }
  `;

  const facts = extractFacts([{ path: "stream.proto", content: proto }]);
  assert.equal(facts.errors.length, 0);

  const svc = facts.entities.find(e => e.id === "proto.service:acme.stream.FlowService");
  assert.ok(svc);
  const rpcs = svc.attrs.rpcs;
  assert.equal(rpcs.length, 4);

  const unary = rpcs.find(r => r.name === "UnaryCall");
  assert.equal(unary.clientStreaming, false);
  assert.equal(unary.serverStreaming, false);

  const clientStream = rpcs.find(r => r.name === "ClientStreamCall");
  assert.equal(clientStream.clientStreaming, true);
  assert.equal(clientStream.serverStreaming, false);

  const serverStream = rpcs.find(r => r.name === "ServerStreamCall");
  assert.equal(serverStream.clientStreaming, false);
  assert.equal(serverStream.serverStreaming, true);

  const bidiStream = rpcs.find(r => r.name === "BidiStreamCall");
  assert.equal(bidiStream.clientStreaming, true);
  assert.equal(bidiStream.serverStreaming, true);
});

// 5. comments with braces inside
test("protobuf parser safely ignores comments containing braces", () => {
  const proto = `
    syntax = "proto3";
    // Line comment with { braces inside {
    /*
      Multi-line comment
      with { nested { braces }
      and } }
    */
    package acme.comments;

    message SafeMessage {
      // Another comment {
      string data = 1; /* { trailing comment } */
      int32 count = 2;
    }
  `;

  const facts = extractFacts([{ path: "comments.proto", content: proto }]);
  assert.equal(facts.errors.length, 0);

  const msg = facts.entities.find(e => e.id === "proto.message:acme.comments.SafeMessage");
  assert.ok(msg, "SafeMessage should parse despite braces in comments");

  const dataField = facts.entities.find(e => e.id === "proto.field:acme.comments.SafeMessage.data");
  assert.ok(dataField);
  assert.equal(dataField.attrs.number, 1);

  const countField = facts.entities.find(e => e.id === "proto.field:acme.comments.SafeMessage.count");
  assert.ok(countField);
  assert.equal(countField.attrs.number, 2);
});

// 6. Each proto event type (all 11 event types!)
test("minimal base/head pairs produce each of the 11 protobuf event types", () => {
  // 1. proto.field_number_reused
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string old_name = 5; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string new_name = 5; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.field_number_reused");
    assert.ok(ev, "proto.field_number_reused not produced");
    assert.ok(ev.message.includes("5"));
  }

  // 2. proto.field_number_changed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string name = 1; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string name = 2; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.field_number_changed");
    assert.ok(ev, "proto.field_number_changed not produced");
    assert.equal(ev.before, 1);
    assert.equal(ev.after, 2);
  }

  // 3. proto.field_removed (without adding number to reserved)
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string id = 1; string legacy = 2; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string id = 1; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.field_removed");
    assert.ok(ev, "proto.field_removed not produced");
    assert.ok(ev.message.includes("legacy"));
  }

  // Verify field_removed is NOT produced if number was reserved!
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string id = 1; string legacy = 2; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { reserved 2; string id = 1; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.field_removed");
    assert.equal(ev, undefined, "field_removed should not fire when number was reserved");
  }

  // 4. proto.field_type_changed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { int32 count = 1; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { int64 count = 1; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.field_type_changed");
    assert.ok(ev, "proto.field_type_changed not produced");
    assert.equal(ev.before, "int32");
    assert.equal(ev.after, "int64");
  }

  // 5. proto.required_added
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto2'; package p; message M { optional string name = 1; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto2'; package p; message M { required string name = 1; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.required_added");
    assert.ok(ev, "proto.required_added not produced for modified field");
  }

  // 6. proto.enum_value_removed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; enum E { ZERO = 0; ONE = 1; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; enum E { ZERO = 0; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.enum_value_removed");
    assert.ok(ev, "proto.enum_value_removed not produced");
    assert.ok(ev.before.includes("ONE"));
  }

  // 7. proto.enum_number_changed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; enum E { VAL = 1; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; enum E { VAL = 2; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.enum_number_changed");
    assert.ok(ev, "proto.enum_number_changed not produced");
    assert.equal(ev.before, 1);
    assert.equal(ev.after, 2);
  }

  // 8. proto.rpc_removed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; service S { rpc A (Req) returns (Res); rpc B (Req) returns (Res); }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; service S { rpc A (Req) returns (Res); }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.rpc_removed");
    assert.ok(ev, "proto.rpc_removed not produced");
    assert.ok(ev.before.includes("B"));
  }

  // 9. proto.rpc_signature_changed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; service S { rpc Call (ReqA) returns (ResA); }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; service S { rpc Call (ReqB) returns (ResB); }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.rpc_signature_changed");
    assert.ok(ev, "proto.rpc_signature_changed not produced");
  }

  // 10. proto.service_removed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; service OldService { rpc Call (Req) returns (Res); }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package p; message M { string id = 1; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.service_removed");
    assert.ok(ev, "proto.service_removed not produced");
    assert.ok(ev.before.includes("OldService"));
  }

  // 11. proto.package_changed
  {
    const base = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package acme.v1; message M { string id = 1; }" }]);
    const head = extractFacts([{ path: "file.proto", content: "syntax = 'proto3'; package acme.v2; message M { string id = 1; }" }]);
    const diff = diffFacts(base, head);
    const ev = diff.events.find(e => e.type === "proto.package_changed");
    assert.ok(ev, "proto.package_changed not produced");
    assert.equal(ev.before, "acme.v1");
    assert.equal(ev.after, "acme.v2");
  }
});

// 7. `archtour check` blocks a reused field number (exit 1)
test("archtour check blocks a reused field number with exit code 1", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "proto-reused-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "proto-reused-head-"));

  try {
    fs.writeFileSync(
      path.join(tmpBase, "api.proto"),
      `
        syntax = "proto3";
        package company.api;

        message User {
          string user_id = 1;
          string email_address = 2;
        }
      `
    );

    // Head reuses field number 2 for a different field name 'phone_number'
    fs.writeFileSync(
      path.join(tmpHead, "api.proto"),
      `
        syntax = "proto3";
        package company.api;

        message User {
          string user_id = 1;
          string phone_number = 2;
        }
      `
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit code 1 for reused field number, got ${r.status}. Stderr: ${r.stderr}`);

    const result = JSON.parse(r.stdout);
    assert.equal(result.exitCode, 1);
    assert.equal(result.verdict, "failed");
    assert.ok(result.findings.some(f => f.event.type === "proto.field_number_reused" && f.level === "hard"));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 8. 2,000 messages parse in < 2 s
test("2,000 messages parse in < 2 s", () => {
  const messageChunks = [];
  messageChunks.push('syntax = "proto3";\npackage benchmark.perf;\n');

  for (let i = 0; i < 2000; i++) {
    messageChunks.push(`message BenchmarkMessage${i} {
  string id = 1;
  int64 timestamp = 2;
  bool is_active = 3;
}`);
  }

  const bigProtoContent = messageChunks.join("\n\n");

  const t0 = performance.now();
  const facts = extractFacts([{ path: "benchmark.proto", content: bigProtoContent }]);
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  assert.equal(facts.errors.length, 0);
  const msgEntities = facts.entities.filter(e => e.kind === "proto.message");
  assert.equal(msgEntities.length, 2000, `Expected 2,000 messages, got ${msgEntities.length}`);

  assert.ok(elapsedMs < 2000, `Expected 2,000 messages to parse in < 2 s, took ${elapsedMs.toFixed(1)} ms`);
});
