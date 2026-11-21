import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import yaml from "yaml";
import {
  parseOverrideComment,
  checkUserPermission,
  getUserTeams,
  resolveOverride
} from "../tools/override.mjs";

test("action.yml parses cleanly and comment script contains paginate, user.type, and github-actions[bot]", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  assert.ok(parsed, "action.yml should parse successfully");
  assert.ok(parsed.runs?.steps, "action.yml should contain runs.steps");

  const commentStep = parsed.runs.steps.find(
    (step) => step.name === "Post or Update PR Comment"
  );
  assert.ok(commentStep, "Post or Update PR Comment step should exist");

  const script = commentStep.with?.script;
  assert.ok(typeof script === "string", "script should be a string");

  assert.ok(
    script.includes("paginate"),
    "script should use github.paginate to list comments across all pages"
  );
  assert.ok(
    script.includes("user.type"),
    "script should verify user.type === 'Bot'"
  );
  assert.ok(
    script.includes("github-actions[bot]"),
    "script should fallback to github-actions[bot]"
  );
  assert.ok(
    script.includes("getAuthenticated"),
    "script should call github.rest.users.getAuthenticated()"
  );
  assert.ok(
    script.includes("per_page: 100"),
    "script should specify per_page: 100 in pagination parameters"
  );
});

test("comment matching logic filters by marker, bot user type, and expected login", () => {
  const botLogin = "github-actions[bot]";
  const comments = [
    {
      id: 1,
      body: "<!-- archtour-guardrails --> Fake comment by human author",
      user: { login: "pr-author", type: "User" }
    },
    {
      id: 2,
      body: "<!-- archtour-guardrails --> Comment by another bot",
      user: { login: "other-bot[bot]", type: "Bot" }
    },
    {
      id: 3,
      body: "Normal comment without marker",
      user: { login: "github-actions[bot]", type: "Bot" }
    },
    {
      id: 4,
      body: "### Guardrails\n<!-- archtour-guardrails -->\nGuardrails summary",
      user: { login: "github-actions[bot]", type: "Bot" }
    }
  ];

  const matched = comments.find(
    (comment) =>
      comment.body &&
      comment.body.includes("<!-- archtour-guardrails -->") &&
      comment.user &&
      comment.user.type === "Bot" &&
      comment.user.login === botLogin
  );

  assert.ok(matched, "Should find the matching bot comment");
  assert.equal(matched.id, 4, "Should select only comment 4");
});

test("action.yml outputs written without raw newlines", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  // Check all steps writing to GITHUB_OUTPUT: verify they strip \r\n or use literal values
  for (const step of parsed.runs.steps) {
    if (typeof step.run === "string" && step.run.includes("GITHUB_OUTPUT")) {
      const outputLines = step.run
        .split("\n")
        .filter((line) => line.includes(">> \"$GITHUB_OUTPUT\"") || line.includes(">> $GITHUB_OUTPUT"));
      for (const line of outputLines) {
        assert.ok(
          line.includes("CLEAN_"),
          `GITHUB_OUTPUT line should use sanitized or clean value: ${line.trim()}`
        );
      }
    }
  }
});

test("action.yml declares include-tests with default 'false'", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  assert.ok(parsed.inputs["include-tests"], "include-tests should be declared in inputs");
  assert.equal(parsed.inputs["include-tests"].default, "false");
});

test("action.yml declares migration-dirs and max-file-size with default ''", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  const parsed = yaml.parse(content);

  assert.ok(parsed.inputs["migration-dirs"], "migration-dirs should be declared in inputs");
  assert.equal(parsed.inputs["migration-dirs"].default, "");
  assert.ok(parsed.inputs["max-file-size"], "max-file-size should be declared in inputs");
  assert.equal(parsed.inputs["max-file-size"].default, "");
});

test("action.yml declares mode input with default check and strict-release with default false", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  assert.ok(parsed.inputs.mode, "action.yml should declare input 'mode'");
  assert.equal(parsed.inputs.mode.default, "check", "mode default should be 'check'");

  assert.ok(parsed.inputs["strict-release"], "action.yml should declare input 'strict-release'");
  assert.equal(parsed.inputs["strict-release"].default, "false", "strict-release default should be 'false'");

  assert.ok(parsed.inputs["github-token"], "action.yml should declare input 'github-token'");
});

test("action.yml name is Archtour, default mode is check, and there is no Chrome step", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  assert.equal(parsed.name, "Archtour", "action name should be 'Archtour'");
  assert.equal(parsed.inputs.mode.default, "check", "default mode should be 'check'");

  const chromeStep = parsed.runs.steps.find((s) => s.name === "Set Chrome Path");
  assert.equal(chromeStep, undefined, "Set Chrome Path step should not exist");
});

test("action.yml check step runs in check mode and no diff step exists", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  const checkStep = parsed.runs.steps.find(
    (s) => s.id === "check" || s.name === "Run Archtour Guardrails Check"
  );
  assert.ok(checkStep, "Run Archtour Guardrails Check step should exist");
  assert.ok(
    checkStep.if?.includes("check") && !checkStep.if?.includes("both") && !checkStep.if?.includes("diff"),
    "check step should run in check mode only"
  );

  const diffStep = parsed.runs.steps.find((s) => s.id === "diff");
  assert.equal(diffStep, undefined, "diff step should not exist");
});

test("action.yml base resolution covers pull_request, merge_group, tag push, and materialises into RUNNER_TEMP", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  const checkoutStep = parsed.runs.steps.find(
    (s) => s.id === "checkout-base" || s.name.includes("base")
  );
  assert.ok(checkoutStep, "checkout-base step should exist");
  assert.ok(typeof checkoutStep.run === "string");

  assert.ok(
    checkoutStep.run.includes("pull_request"),
    "base resolution should cover pull_request"
  );
  assert.ok(
    checkoutStep.run.includes("merge_group"),
    "base resolution should cover merge_group"
  );
  assert.ok(
    checkoutStep.run.includes("describe --tags") || checkoutStep.run.includes("git describe"),
    "base resolution should cover tag gates via git describe"
  );
  assert.ok(
    checkoutStep.run.includes("git worktree add"),
    "base should be materialised with git worktree add"
  );
  assert.ok(
    checkoutStep.run.includes("RUNNER_TEMP"),
    "base should be materialised into RUNNER_TEMP"
  );
});

test("action.yml check step passes reason through env and avoids ${{ }} interpolation of comment text", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  const checkStep = parsed.runs.steps.find(
    (s) => s.id === "check" || s.name === "Run Archtour Guardrails Check"
  );
  assert.ok(checkStep, "check step should exist");
  assert.ok(
    !checkStep.run.includes("${{ github.event.comment") &&
    !checkStep.run.includes("${{ github.event.issue") &&
    !checkStep.run.includes("${{ inputs.reason"),
    "check step run must not interpolate untrusted comment text directly into bash"
  );
  assert.ok(
    checkStep.run.includes("--override-reason") && checkStep.run.includes("ARCHTOUR_OVERRIDE_REASON"),
    "check step should pass override reason through env variable"
  );

  const overrideStep = parsed.runs.steps.find(
    (s) => s.id === "override" || s.name === "Resolve Guardrails Override"
  );
  assert.ok(overrideStep, "override step should exist");
  assert.ok(
    overrideStep.env?.GITHUB_TOKEN?.includes("github-token"),
    "override step should pass github-token via env"
  );
});

test("action.yml annotations use the ::warning file=,line= form", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  const checkStep = parsed.runs.steps.find(
    (s) => s.id === "check" || s.name === "Run Archtour Guardrails Check"
  );
  assert.ok(checkStep, "check step should exist");
  assert.ok(
    checkStep.run.includes("::warning file=") && checkStep.run.includes(",line="),
    "annotations must use the ::warning file=...,line=... form"
  );
});

test("examples parse as valid YAML and declare required triggers and permissions", () => {
  const guardrailsExamplePath = path.resolve("examples/github-workflow-guardrails.yml");
  const guardrailsContent = fs.readFileSync(guardrailsExamplePath, "utf8");
  const guardrailsParsed = yaml.parse(guardrailsContent);

  assert.ok(guardrailsParsed, "github-workflow-guardrails.yml should parse successfully");
  assert.ok(guardrailsParsed.on?.pull_request !== undefined, "guardrails example should trigger on pull_request");
  assert.ok(guardrailsParsed.on?.merge_group !== undefined, "guardrails example should trigger on merge_group");
  assert.equal(guardrailsParsed.permissions?.["pull-requests"], "write", "guardrails example needs pull-requests: write");

  const releaseExamplePath = path.resolve("examples/github-workflow-release-gate.yml");
  const releaseContent = fs.readFileSync(releaseExamplePath, "utf8");
  const releaseParsed = yaml.parse(releaseContent);

  assert.ok(releaseParsed, "github-workflow-release-gate.yml should parse successfully");
  assert.ok(
    releaseParsed.on?.push?.tags?.includes("v*") || releaseParsed.on?.push?.tags?.includes("'v*'"),
    "release example should trigger on push tags v*"
  );
  assert.ok(
    releaseParsed.on?.release?.types?.includes("published"),
    "release example should trigger on release published"
  );
});

test("tools/override.mjs parseOverrideComment extracts ruleId, sha, and reason cleanly", () => {
  const single = parseOverrideComment("/archtour override no-host-network abc12345678901 Fix approved for incident 99");
  assert.deepEqual(single, {
    ruleId: "no-host-network",
    sha: "abc12345678901",
    reason: "Fix approved for incident 99"
  });

  const multiRules = parseOverrideComment(
    "LGTM\n/archtour override no-host-network,no-db-model-removed 1234567890ab Migration approved for Q4\nThanks!"
  );
  assert.deepEqual(multiRules, {
    ruleId: "no-host-network,no-db-model-removed",
    sha: "1234567890ab",
    reason: "Migration approved for Q4"
  });

  const shortSha = parseOverrideComment("/archtour override no-host-network 123456 Fix approved");
  assert.equal(shortSha, null, "SHA shorter than 7 characters should not match");

  // 7 to 11 hex characters still parse, so resolveOverride can refuse them with reason sha_too_short (tested below)
  // instead of silently ignoring the comment.
  const elevenChars = parseOverrideComment("/archtour override no-host-network 1234567890a Fix approved");
  assert.equal(elevenChars.sha, "1234567890a", "an 11-character SHA parses; the resolver refuses it");

  const upperCase12 = parseOverrideComment("/archtour override no-host-network ABCDEF123456 Approved");
  assert.deepEqual(upperCase12, {
    ruleId: "no-host-network",
    sha: "abcdef123456",
    reason: "Approved"
  });

  const noMatch = parseOverrideComment("Just a normal comment with no command");
  assert.equal(noMatch, null);
});

test("tools/override.mjs checkUserPermission validates write, maintain, admin access", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/admin-user/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/write-user/permission")) {
      return { ok: true, json: async () => ({ permission: "write" }) };
    }
    if (url.includes("/maintain-user/permission")) {
      return { ok: true, json: async () => ({ permission: "maintain" }) };
    }
    if (url.includes("/read-user/permission")) {
      return { ok: true, json: async () => ({ permission: "read" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const adminRes = await checkUserPermission({
    owner: "org",
    repo: "repo",
    username: "admin-user",
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(adminRes.allowed, true);

  const writeRes = await checkUserPermission({
    owner: "org",
    repo: "repo",
    username: "write-user",
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(writeRes.allowed, true);

  const maintainRes = await checkUserPermission({
    owner: "org",
    repo: "repo",
    username: "maintain-user",
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(maintainRes.allowed, true);

  const readRes = await checkUserPermission({
    owner: "org",
    repo: "repo",
    username: "read-user",
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(readRes.allowed, false);
});

test("tools/override.mjs getUserTeams returns team slugs and gracefully handles token limits", async () => {
  const calledUrls = [];
  const fakeFetchSuccess = async (url) => {
    calledUrls.push(url);
    if (url.includes("/teams/platform/memberships/alice")) {
      return {
        ok: true,
        json: async () => ({ state: "active" })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const teams = await getUserTeams({
    org: "acme",
    username: "alice",
    teams: ["@acme/platform"],
    token: "tok",
    fetchImpl: fakeFetchSuccess
  });
  assert.ok(teams.includes("acme/platform"));
  assert.ok(teams.includes("platform"));
  assert.ok(teams.includes("@acme/platform"));
  assert.equal(calledUrls.length, 1);
  assert.ok(calledUrls[0].includes("/teams/platform/memberships/alice"));

  // Failure fallback
  const fakeFetchFail = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const fallbackTeams = await getUserTeams({
    org: "acme",
    username: "alice",
    teams: ["@acme/platform"],
    token: "tok",
    fetchImpl: fakeFetchFail
  });
  assert.deepEqual(fallbackTeams, []);
});

test("team membership lookup calls only the named team (mock fetch)", async () => {
  const calledUrls = [];
  const fakeFetch = async (url) => {
    calledUrls.push(url);
    if (url.includes("/orgs/acme/teams/infra/memberships/carol")) {
      return { ok: true, json: async () => ({ state: "active" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const res = await getUserTeams({
    org: "acme",
    username: "carol",
    rules: [
      { id: "custom-rule-1", owners: ["@acme/infra"] },
      { id: "custom-rule-2", owners: ["individual-user"] }
    ],
    token: "tok_secret",
    fetchImpl: fakeFetch
  });

  assert.equal(calledUrls.length, 1, "Must query ONLY the named team, never listing all org teams");
  assert.equal(calledUrls[0], "https://api.github.com/orgs/acme/teams/infra/memberships/carol");
  assert.ok(res.includes("acme/infra"));
  assert.ok(res.includes("infra"));
  assert.ok(res.includes("@acme/infra"));
});

test("tools/override.mjs resolveOverride requires label, chooses newest comment, and respects permissions", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/collaborators/bob/permission")) {
      return { ok: true, json: async () => ({ permission: "read" }) };
    }
    if (url.includes("/teams/security/memberships/alice")) {
      return { ok: true, json: async () => ({ state: "active" }) };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          {
            event: "labeled",
            label: { name: "archtour-override" },
            actor: { login: "alice" },
            created_at: "2026-11-14T11:00:00Z"
          }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const eventNoLabel = {
    pull_request: {
      number: 10,
      head: { sha: "abc12345678901def" },
      labels: [{ name: "feature" }]
    },
    repository: { full_name: "acme/repo" }
  };

  const resNoLabel = await resolveOverride({
    event: eventNoLabel,
    comments: [
      {
        id: 1,
        body: "/archtour override no-host-network abc12345678901 Emergency hotfix",
        user: { login: "alice" },
        created_at: "2026-11-14T09:00:00Z",
        updated_at: "2026-11-14T09:00:00Z"
      }
    ],
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(resNoLabel.active, false);
  assert.equal(resNoLabel.hasLabel, false);

  const eventWithLabel = {
    pull_request: {
      number: 10,
      head: { sha: "abc12345678901def" },
      labels: [{ name: "archtour-override" }]
    },
    repository: { full_name: "acme/repo" }
  };

  // Bob (read-only) comment should be ignored; Alice (admin) comment should win
  const comments = [
    {
      id: 1,
      body: "/archtour override rule-old abc12345678901def Old reason from alice",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:00:00Z"
    },
    {
      id: 2,
      body: "/archtour override rule-bob abc12345678901def Reason from read-only bob",
      user: { login: "bob" },
      created_at: "2026-11-14T10:00:00Z",
      updated_at: "2026-11-14T10:00:00Z"
    },
    {
      id: 3,
      body: "/archtour override rule-new abc12345678901def Newest valid reason from alice",
      user: { login: "alice" },
      created_at: "2026-11-14T11:00:00Z",
      updated_at: "2026-11-14T11:00:00Z"
    }
  ];

  const resWithLabel = await resolveOverride({
    event: eventWithLabel,
    comments,
    rules: [{ id: "rule-new", owners: ["@acme/security"] }],
    token: "tok",
    fetchImpl: fakeFetch
  });

  assert.equal(resWithLabel.active, true);
  assert.equal(resWithLabel.hasLabel, true);
  assert.equal(resWithLabel.ruleId, "rule-new");
  assert.equal(resWithLabel.sha, "abc12345678901def");
  assert.equal(resWithLabel.overrideBy, "alice");
  assert.equal(resWithLabel.reason, "Newest valid reason from alice");
  assert.ok(resWithLabel.ownerTeams.includes("acme/security"));

  // Check label author restriction when specified
  const resLabelAuthorMismatch = await resolveOverride({
    event: eventWithLabel,
    comments,
    rules: [{ id: "rule-new", owners: ["@acme/security"] }],
    labelAuthor: "charlie",
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(resLabelAuthorMismatch.active, false);
});


test("the PR comment is still posted when the guardrails check fails", () => {
  const parsed = yaml.parse(fs.readFileSync(path.resolve("action.yml"), "utf8"));
  const steps = parsed.runs.steps;
  const checkIdx = steps.findIndex((s) => s.id === "check");
  const commentIdx = steps.findIndex((s) => s.name === "Post or Update PR Comment");
  assert.ok(checkIdx !== -1 && commentIdx > checkIdx, "the comment step runs after the check step");
  // A step without always()/!cancelled()/failure() is skipped once an earlier step failed (the check exits 1 or 2 on findings)
  assert.match(String(steps[commentIdx].if), /!cancelled\(\)|always\(\)/);
});

test("action.yml has an else/crash branch for other exit codes and a mode validation step", () => {
  const actionPath = path.resolve("action.yml");
  const parsed = yaml.parse(fs.readFileSync(actionPath, "utf8"));

  // 1. Mode validation step
  const modeStep = parsed.runs.steps.find((s) => s.id === "validate-mode" || s.name === "Validate Mode");
  assert.ok(modeStep, "Validate Mode step should exist in action.yml");
  assert.ok(modeStep.run.includes("Invalid mode"), "Validate Mode step should print error on invalid mode");
  assert.ok(modeStep.run.includes("exit 3"), "Validate Mode step should exit 3 on invalid mode");

  // 2. Check step has crash/else branch for other exit codes
  const checkStep = parsed.runs.steps.find((s) => s.id === "check" || s.name === "Run Archtour Guardrails Check");
  assert.ok(checkStep, "Run Archtour Guardrails Check step should exist");
  assert.ok(
    checkStep.run.includes("Archtour check crashed") && checkStep.run.includes("exit \"$CHECK_EXIT\""),
    "check step should fail with crash error and exit with CHECK_EXIT on other exit codes"
  );
});

test("override comment on page 2 of comments is found (mock fetch with a Link header)", async () => {
  const event = {
    pull_request: {
      number: 42,
      head: { sha: "fedcba9876543210" },
      labels: [{ name: "archtour-override" }],
      user: { login: "pr-author" }
    },
    repository: { full_name: "acme/repo" }
  };

  const fakeFetch = async (url) => {
    // Permission check for alice
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "write" }) };
    }
    // Org teams check for acme
    if (url.includes("/orgs/acme/teams")) {
      return { ok: true, json: async () => [] };
    }
    // Issue events for 42
    if (url.includes("/issues/42/events")) {
      return {
        ok: true,
        json: async () => [
          {
            event: "labeled",
            label: { name: "archtour-override" },
            actor: { login: "alice" },
            created_at: "2026-11-16T11:00:00Z"
          }
        ]
      };
    }
    // Comments page 1: returns normal comments, links to page 2
    if (url.includes("/issues/42/comments") && !url.includes("page=2")) {
      return {
        ok: true,
        headers: {
          get: (header) => {
            if (header.toLowerCase() === "link") {
              return '<https://api.github.com/repos/acme/repo/issues/42/comments?per_page=100&page=2>; rel="next"';
            }
            return null;
          }
        },
        json: async () => [
          {
            id: 101,
            body: "Looks good so far, but please check column deprecation.",
            user: { login: "reviewer" },
            created_at: "2026-11-16T10:00:00Z",
            updated_at: "2026-11-16T10:00:00Z"
          }
        ]
      };
    }
    // Comments page 2: contains the override comment
    if (url.includes("page=2")) {
      return {
        ok: true,
        headers: {
          get: () => null // No next page
        },
        json: async () => [
          {
            id: 102,
            body: "/archtour override sql-no-drop-column fedcba9876543210 Column drop approved for migration v2",
            user: { login: "alice" },
            created_at: "2026-11-16T11:00:00Z",
            updated_at: "2026-11-16T11:00:00Z"
          }
        ]
      };
    }
    return { ok: false, status: 404 };
  };

  const res = await resolveOverride({
    event,
    token: "gh-token",
    fetchImpl: fakeFetch
  });

  assert.equal(res.active, true, "Override should be active from page 2 comment");
  assert.equal(res.ruleId, "sql-no-drop-column");
  assert.equal(res.sha, "fedcba9876543210");
  assert.equal(res.overrideBy, "alice");
  assert.equal(res.reason, "Column drop approved for migration v2");
});

test("PR base is the test merge's first parent when the base branch moved after the PR was opened", (t) => {
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.status !== 0) {
    if (t?.skip) t.skip("bash is unavailable");
    return;
  }
  const parsed = yaml.parse(fs.readFileSync(path.resolve("action.yml"), "utf8"));
  const step = parsed.runs.steps.find((s) => s.id === "checkout-base");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "action-merge-base-"));
  try {
    const git = (...args) => {
      const r = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(tmp, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const oldBase = git("rev-parse", "HEAD");
    git("switch", "-qc", "feature");
    fs.writeFileSync(path.join(tmp, "b.txt"), "b\n");
    git("add", "-A");
    git("commit", "-qm", "pr");
    const prHead = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    fs.writeFileSync(path.join(tmp, "c.txt"), "c\n");
    git("add", "-A");
    git("commit", "-qm", "main moved on");
    const currentBase = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", "-m", "test merge", "feature");

    const out = path.join(tmp, "..", `gh-output-${path.basename(tmp)}.txt`);
    fs.writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", step.run], {
      cwd: tmp,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT_NAME: "pull_request",
        MODE: "check",
        BASE_SHA: oldBase,
        PR_HEAD_SHA: prHead,
        BASE_REF: "main",
        GITHUB_OUTPUT: out,
        RUNNER_TEMP: path.join(tmp, "..", `runner-${path.basename(tmp)}`)
      }
    });
    assert.equal(r.status, 0, r.stderr);
    const outputs = fs.readFileSync(out, "utf8");
    assert.match(outputs, new RegExp(`base_commit=${currentBase}`), outputs);
    fs.rmSync(out, { force: true });
  } finally {
    spawnSync("git", ["worktree", "prune"], { cwd: tmp });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the facts cache is never restored or saved for pull requests or the merge queue", () => {
  const parsed = yaml.parse(fs.readFileSync(path.resolve("action.yml"), "utf8"));
  const step = parsed.runs.steps.find((s) => s.name === "Cache Archtour facts");
  assert.ok(step, "cache step exists");
  for (const event of ["pull_request", "merge_group"]) {
    assert.match(String(step.if), new RegExp(`github\.event_name != '${event}'`), `${event} must not use the cache`);
  }
});

test("team membership lookup verifies named teams (active vs inactive)", async () => {
  const fakeFetch = async (url) => {
    // Membership checks
    if (url.includes("/teams/team-page-1/memberships/alice")) {
      return { ok: false, status: 404 };
    }
    if (url.includes("/teams/team-page-2/memberships/alice")) {
      return {
        ok: true,
        json: async () => ({ state: "active" })
      };
    }
    return { ok: false, status: 404 };
  };

  const teams = await getUserTeams({
    org: "my-org",
    username: "alice",
    teams: ["@my-org/team-page-1", "@my-org/team-page-2"],
    token: "gh-token",
    fetchImpl: fakeFetch
  });

  assert.ok(teams.includes("my-org/team-page-2"), "Must find active team");
  assert.ok(teams.includes("team-page-2"), "Must include team slug");
  assert.ok(!teams.includes("team-page-1"), "Must not include inactive team");
});

test("ci.yml contains pack-install job with required matrix and steps", () => {
  const ciPath = path.resolve(".github/workflows/ci.yml");
  const ciContent = fs.readFileSync(ciPath, "utf8");
  const ciYaml = yaml.parse(ciContent);

  const packJob = ciYaml.jobs?.["pack-install"];
  assert.ok(packJob, "pack-install job must exist in ci.yml");

  const matrixOs = packJob.strategy?.matrix?.os;
  assert.deepEqual(matrixOs, ["ubuntu-latest", "macos-latest"], "pack-install matrix must include ubuntu-latest and macos-latest");

  const steps = packJob.steps || [];
  const testStep = steps.find(s => s.name === "Pack and test installation" || s.run?.includes("npm pack"));
  assert.ok(testStep, "pack-install must contain a step running npm pack");
  assert.ok(testStep.run.includes("npm pack"), "must run npm pack");
  assert.ok(testStep.run.includes("npm install"), "must run npm install");
  assert.ok(testStep.run.includes("npx archtour check"), "must run npx archtour check");
  assert.ok(testStep.run.includes("privileged: true"), "must test privileged: true");
});

test("README.md workflow YAML block specifies pull_request types: [opened, synchronize, reopened, labeled, edited]", () => {
  const readmePath = path.resolve("README.md");
  const readmeContent = fs.readFileSync(readmePath, "utf8");

  // Extract the GitHub Action workflow yaml block
  const yamlMatch = readmeContent.match(/```yaml\s*\n(name:\s*Archtour Guardrails[\s\S]*?)```/);
  assert.ok(yamlMatch, "README.md must contain the Archtour Guardrails workflow yaml block");

  const parsedWorkflow = yaml.parse(yamlMatch[1]);
  assert.ok(parsedWorkflow, "Parsed workflow must be valid YAML");

  const prEvent = parsedWorkflow.on?.pull_request;
  assert.ok(prEvent, "pull_request event must be defined in workflow");
  assert.deepEqual(
    prEvent.types,
    ["opened", "synchronize", "reopened", "labeled", "edited"],
    "pull_request types must be [opened, synchronize, reopened, labeled, edited]"
  );
});// Override with wrong sha -> skipped with standard no-valid-override reason
test("override with wrong or short sha is not applied", async () => {
  const event = {
    pull_request: {
      number: 10,
      head: { sha: "abc12345678901DEF" },
      labels: [{ name: "archtour-override" }]
    },
    repository: { full_name: "acme/repo" }
  };
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "write" }) };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          {
            event: "labeled",
            label: { name: "archtour-override" },
            actor: { login: "alice" }
          }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // Short sha (less than 12 chars) -> inactive with sha_too_short
  const commentsShortSha = [
    {
      id: 1,
      body: "/archtour override no-host-network abc1234567 Approved",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:00:00Z"
    }
  ];
  const resShortSha = await resolveOverride({
    event,
    comments: commentsShortSha,
    token: "tok",
    fetchImpl: fakeFetch,
    rules: [{ id: "no-host-network", owners: [] }]
  });
  assert.equal(resShortSha.reason, "sha_too_short", "short sha must give reason sha_too_short");
  assert.equal(resShortSha.active, false, "Override with short sha should be inactive");

  // Wrong sha (full length, not the head sha) -> skipped by resolveOverride; no reason emitted.
  const commentsWrongSha = [
    {
      id: 2,
      body: "/archtour override no-host-network deadbeef012345678 Approved",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:00:00Z"
    }
  ];
  const resWrongSha = await resolveOverride({
    event,
    comments: commentsWrongSha,
    token: "tok",
    fetchImpl: fakeFetch,
    rules: [{ id: "no-host-network", owners: [] }]
  });
  assert.equal(resWrongSha.reason, "no_valid_override_comment", "Override with wrong sha should be skipped, returning the standard no-valid-override reason");
  assert.equal(resWrongSha.active, false, "Override with wrong sha should be inactive");
  assert.equal(resShortSha.active, false, "Override with wrong sha should be inactive");
  
  // Full SHA, lowercase, accepted (permission check answered by mock fetch)
  const commentsGoodSha = [
    {
      id: 2,
      body: "/archtour override no-host-network abc12345678901def Approved",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:00:00Z"
    }
  ];
  const resGoodSha = await resolveOverride({
    event,
    comments: commentsGoodSha,
    token: "tok",
    fetchImpl: fakeFetch,
    rules: [{ id: "no-host-network", owners: [] }]
  });
  assert.equal(resGoodSha.active, true, "Lowercase full head SHA must be active");
  assert.equal(resGoodSha.sha, "abc12345678901def");

  // Full SHA, uppercase, accepted (lowercased before the exact match)
  const commentsUpperSha = [
    {
      id: 3,
      body: "/archtour override no-host-network ABC12345678901DEF Approved",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:00:00Z"
    }
  ];
  const resUpperSha = await resolveOverride({
    event,
    comments: commentsUpperSha,
    token: "tok",
    fetchImpl: fakeFetch,
    rules: [{ id: "no-host-network", owners: [] }]
  });
  assert.equal(resUpperSha.active, true, "Upper-case full head SHA must be accepted");
  assert.equal(resUpperSha.sha, "abc12345678901def");
});

// Edited comment -> not applied
test("edited override comment (updated_at !== created_at) is rejected", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          {
            event: "labeled",
            label: { name: "archtour-override" },
            actor: { login: "alice" }
          }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const event = {
    pull_request: {
      number: 10,
      head: { sha: "abc123456789" },
      labels: [{ name: "archtour-override" }]
    },
    repository: { full_name: "acme/repo" }
  };

  const commentsEdited = [
    {
      id: 1,
      body: "/archtour override no-host-network abc1234 Approved",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:05:00Z"
    }
  ];

  const res = await resolveOverride({
    event,
    comments: commentsEdited,
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(res.active, false, "Edited comment must not be active");
});

// Comment author != latest labeller on a synchronize event -> not applied
test("comment author != latest labeller on synchronize event is rejected", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/collaborators/bob/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          {
            event: "labeled",
            label: { name: "archtour-override" },
            actor: { login: "bob" },
            created_at: "2026-11-14T10:00:00Z"
          }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const event = {
    action: "synchronize",
    pull_request: {
      number: 10,
      head: { sha: "abc123456789" },
      labels: [{ name: "archtour-override" }]
    },
    repository: { full_name: "acme/repo" }
  };

  const comments = [
    {
      id: 1,
      body: "/archtour override no-host-network abc1234 Approved by alice",
      user: { login: "alice" },
      created_at: "2026-11-14T09:00:00Z",
      updated_at: "2026-11-14T09:00:00Z"
    }
  ];

  const res = await resolveOverride({
    event,
    comments,
    token: "tok",
    fetchImpl: fakeFetch
  });
  assert.equal(res.active, false, "Must be inactive when comment author does not match latest labeller");
});

// Correct sha + same labeller + unedited -> applied (mock fetch for comments and events)
test("correct sha + same labeller + unedited comment is successfully applied with mock fetch", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "write" }) };
    }
    if (url.endsWith("/orgs/acme/teams")) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          {
            event: "labeled",
            label: { name: "archtour-override" },
            actor: { login: "alice" },
            created_at: "2026-11-14T09:30:00Z"
          }
        ]
      };
    }
    if (url.includes("/issues/10/comments")) {
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [
          {
            id: 10,
            body: "/archtour override no-host-network abc12345678901def Approved valid reason",
            user: { login: "alice" },
            created_at: "2026-11-14T09:00:00Z",
            updated_at: "2026-11-14T09:00:00Z"
          }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const event = {
    action: "synchronize",
    pull_request: {
      number: 10,
      head: { sha: "abc12345678901def" },
      labels: [{ name: "archtour-override" }],
      user: { login: "pr-author" }
    },
    repository: { full_name: "acme/repo" }
  };

  const res = await resolveOverride({
    event,
    token: "tok",
    fetchImpl: fakeFetch
  });

  assert.equal(res.active, true, "Override must be applied");
  assert.equal(res.ruleId, "no-host-network");
  assert.equal(res.sha, "abc12345678901def");
  assert.equal(res.overrideBy, "alice");
  assert.equal(res.reason, "Approved valid reason");
});

// README table test: every row item under "blocks" maps to a soft/hard rule
test("README 'What it checks' table: every row item under 'Blocks' maps to a soft or hard rule", () => {
  const readmeContent = fs.readFileSync(path.resolve("README.md"), "utf8");
  const tableMatch = readmeContent.match(/## What it checks\s*\n\s*\|([^\n]+)\|\s*\n\s*\|([^\n]+)\|\s*\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(tableMatch, "README.md must contain the 'What it checks' table");

  const headerLine = tableMatch[1];
  assert.ok(headerLine.includes("Blocks"), "Table header must have a 'Blocks' column");
  assert.ok(headerLine.includes("Warns"), "Table header must have a 'Warns' column");

  const rows = tableMatch[3].trim().split("\n").filter(Boolean);
  assert.ok(rows.length >= 8, `Expected at least 8 format rows in table, got ${rows.length}`);

  // Disallowed warn/advisory items that must NOT appear in the Blocks column
  const warnMarkers = [
    "NOT NULL without DEFAULT",
    "NOT NULL without `DEFAULT`",
    "index without CONCURRENTLY",
    "type narrowing",
    "column type narrowing",
    "column type changes",
    "changing optional fields to required",
    "required query or body parameters",
    "dangerous enum value changes",
    "untrusted container registry",
    "container image changes",
    "new service dependencies",
    "privilege escalation",
    "Linux capabilities",
    "resource limits",
    "wildcard IAM"
  ];

  for (const row of rows) {
    const cols = row.split("|").map(c => c.trim()).filter(Boolean);
    assert.ok(cols.length >= 3, `Row must have at least 3 columns: ${row}`);
    const formatCol = cols[0];
    const blocksCol = cols[1];

    for (const marker of warnMarkers) {
      assert.ok(
        !blocksCol.toLowerCase().includes(marker.toLowerCase()),
        `Warn rule "${marker}" was found under Blocks column for format ${formatCol}: "${blocksCol}"`
      );
    }
  }
});

// B1: the resolver must reject rule ids that are not in the loaded policy
test("resolveOverride rejects an unknown rule id (inactive, with a reason)", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          { event: "labeled", label: { name: "archtour-override" }, actor: { login: "alice" }, created_at: "2026-11-14T11:00:00Z" }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const event = {
    pull_request: {
      number: 10,
      head: { sha: "abc12345678901def" },
      labels: [{ name: "archtour-override" }],
      user: { login: "pr-author" }
    },
    repository: { full_name: "acme/repo" }
  };

  const res = await resolveOverride({
    event,
    comments: [
      {
        id: 1,
        body: "/archtour override help abc12345678901def ship it",
        user: { login: "alice" },
        created_at: "2026-11-14T09:00:00Z",
        updated_at: "2026-11-14T09:00:00Z"
      }
    ],
    rules: [{ id: "sql-no-drop-column", owners: [] }],
    token: "tok",
    fetchImpl: fakeFetch
  });

  assert.equal(res.active, false, "an unknown rule id can never be an active override");
  assert.match(String(res.reason), /unknown_rule_id/, `reason must say the rule is unknown, got: ${res.reason}`);
});

// B1: the PR author must never approve their own override
test("resolveOverride rejects an override by the PR author", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/collaborators/alice/permission")) {
      return { ok: true, json: async () => ({ permission: "admin" }) };
    }
    if (url.includes("/issues/10/events")) {
      return {
        ok: true,
        json: async () => [
          { event: "labeled", label: { name: "archtour-override" }, actor: { login: "alice" }, created_at: "2026-11-14T11:00:00Z" }
        ]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const event = {
    pull_request: {
      number: 10,
      head: { sha: "abc123456789" },
      labels: [{ name: "archtour-override" }],
      user: { login: "alice" }
    },
    repository: { full_name: "acme/repo" }
  };

  const res = await resolveOverride({
    event,
    comments: [
      {
        id: 1,
        body: "/archtour override sql-no-drop-column abc1234 ship it",
        user: { login: "alice" },
        created_at: "2026-11-14T09:00:00Z",
        updated_at: "2026-11-14T09:00:00Z"
      }
    ],
    rules: [{ id: "sql-no-drop-column", owners: ["@acme/security"] }],
    token: "tok",
    fetchImpl: fakeFetch
  });

  assert.equal(res.active, false, "the PR author can never approve their own override");
  assert.equal(res.reason, "pr_author_cannot_override");
});

test("action.yml guardrails check step passes INPUT_INCLUDE_TESTS to check command", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");

  // Check that INPUT_INCLUDE_TESTS is in the env
  assert.ok(content.includes("INPUT_INCLUDE_TESTS: ${{ inputs.include-tests }}"),
    "action.yml guardrails check should set INPUT_INCLUDE_TESTS env from inputs.include-tests");

  // Check that the conditional adds --include-tests
  assert.ok(content.includes('if [ "$INPUT_INCLUDE_TESTS" = "true" ]; then'),
    "action.yml guardrails check should check INPUT_INCLUDE_TESTS");
  assert.ok(content.includes("CHECK_ARGS+=(--include-tests)"),
    "action.yml guardrails check should add --include-tests to CHECK_ARGS when INPUT_INCLUDE_TESTS is true");
});

test("action.yml maps inputs.ignore to INPUT_IGNORE in the step's env", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  assert.ok(
    content.includes("INPUT_IGNORE: ${{ inputs.ignore }}"),
    "action.yml guardrails check step should set INPUT_IGNORE env from inputs.ignore"
  );
});

test("action.yml run script reads INPUT_IGNORE and contains --ignore=", () => {
  const actionPath = path.resolve("action.yml");
  const content = fs.readFileSync(actionPath, "utf8");
  assert.ok(
    content.includes("$INPUT_IGNORE"),
    "action.yml run script should read $INPUT_IGNORE"
  );
  assert.ok(
    content.includes("--ignore="),
    "action.yml run script should contain --ignore="
  );
});

// A job skipped by `if:` reports Success, even for a required check, and the newest run on the head commit wins:
// a PR author could edit the title to turn a red check green. So the recommended workflows never skip the job.
test("recommended workflows never skip the guardrails job with a job-level if (skipped counts as Success)", () => {
  for (const file of ["README.md", "examples/github-workflow-guardrails.yml"]) {
    const content = fs.readFileSync(path.resolve(file), "utf8");
    assert.ok(content.includes("labeled, edited]"), `${file} should trigger on edited`);
    assert.ok(!/^\s+if:\s*github\.event/m.test(content), `${file} must not skip the job with a job-level if`);
  }
});
