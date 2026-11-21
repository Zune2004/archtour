import test from "node:test";
import assert from "node:assert/strict";
import { mdText, mdCode } from "../tools/md.mjs";

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
