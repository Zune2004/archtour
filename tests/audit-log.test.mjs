import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = path.resolve("tools/cli.mjs");

const AUTHOR = "Alice Author";
const EMAIL = "alice@example.com";

const BASE_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: AUTHOR,
  GIT_AUTHOR_EMAIL: EMAIL,
  GIT_COMMITTER_NAME: AUTHOR,
  GIT_COMMITTER_EMAIL: EMAIL
};

function git(dir, args, env = {}) {
  return execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...BASE_ENV, ...env },
    encoding: "utf8"
  }).trim();
}

function initRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "commit.gpgSign", "false"]);
  return dir;
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function commitAll(dir, { message, date, author = AUTHOR, email = EMAIL }) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message], {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date
  });
  return git(dir, ["rev-parse", "HEAD"]);
}

async function withRepo(prefix, fn) {
  const dir = initRepo(prefix);
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function auditJson(dir, extra = []) {
  const result = runCli(["audit-log", dir, "--json", ...extra]);
  assert.equal(result.status, 0, `audit-log failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function baseEvent(sha, date, subject) {
  return {
    date,
    commit: sha,
    author: AUTHOR,
    email: EMAIL,
    subject
  };
}

function iso(date) {
  return new Date(date).toISOString();
}

const EXCEPTIONS_ONE = `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: legacy database
    owner: "@alice"
    expires: "2025-12-31"
`;

test("exceptions: add, change and remove, newest first and sorted by key", async () => {
  await withRepo("archtour-audit-log-exc-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: legacy database
    owner: "@alice"
    expires: "2025-12-31"
  - rule: sql-no-drop-column
    target: migrations/001.sql
    reason: hotfix
    owner: "@bob"
    expires: "2025-06-30"
`);
    const c1 = commitAll(dir, { message: "add exceptions", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: legacy database, reviewed
    owner: "@alice"
    expires: "2025-12-31"
  - rule: sql-no-drop-column
    target: migrations/001.sql
    reason: hotfix
    owner: "@bob"
    expires: "2025-09-30"
`);
    const c2 = commitAll(dir, { message: "adjust exceptions", date: "2024-02-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: legacy database, reviewed
    owner: "@alice"
    expires: "2025-12-31"
`);
    const c3 = commitAll(dir, { message: "remove sql exception", date: "2024-03-01T00:00:00+0000" });

    const result = auditJson(dir);

    assert.deepEqual(Object.keys(result), ["repo", "branch", "head", "since", "until", "asOf", "events", "current", "summary"]);
    assert.equal(result.branch, "HEAD");
    assert.equal(result.head, c3);
    assert.equal(result.since, null);
    assert.equal(result.until, null);
    assert.equal(result.repo, path.resolve(dir));

    assert.deepEqual(result.events, [
      {
        ...baseEvent(c3, "2024-03-01T00:00:00.000Z", "remove sql exception"),
        kind: "exception-removed",
        file: ".archtour/exceptions.yml",
        key: "sql-no-drop-column migrations/001.sql",
        weakened: false,
        before: { reason: "hotfix", owner: "@bob", expires: "2025-09-30" }
      },
      {
        ...baseEvent(c2, "2024-02-01T00:00:00.000Z", "adjust exceptions"),
        kind: "exception-changed",
        file: ".archtour/exceptions.yml",
        key: "no-privileged-containers service:db",
        weakened: false,
        before: { reason: "legacy database" },
        after: { reason: "legacy database, reviewed" }
      },
      {
        ...baseEvent(c2, "2024-02-01T00:00:00.000Z", "adjust exceptions"),
        kind: "exception-changed",
        file: ".archtour/exceptions.yml",
        key: "sql-no-drop-column migrations/001.sql",
        weakened: true,
        before: { expires: "2025-06-30" },
        after: { expires: "2025-09-30" }
      },
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "add exceptions"),
        kind: "exception-added",
        file: ".archtour/exceptions.yml",
        key: "no-privileged-containers service:db",
        weakened: true,
        after: { reason: "legacy database", owner: "@alice", expires: "2025-12-31" }
      },
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "add exceptions"),
        kind: "exception-added",
        file: ".archtour/exceptions.yml",
        key: "sql-no-drop-column migrations/001.sql",
        weakened: true,
        after: { reason: "hotfix", owner: "@bob", expires: "2025-06-30" }
      }
    ]);

    assert.deepEqual(result.summary, {
      byKind: { "exception-added": 2, "exception-changed": 2, "exception-removed": 1 },
      weakened: 3
    });
  });
});

test("exceptions: an earlier expiry or a reason change is not weakening", async () => {
  await withRepo("archtour-audit-log-exc2-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: legacy
    owner: "@alice"
    expires: "2025-12-31"
`);
    commitAll(dir, { message: "add", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: still needed
    owner: "@carol"
    expires: "2025-06-30"
`);
    const c2 = commitAll(dir, { message: "tighten", date: "2024-02-01T00:00:00+0000" });

    const result = auditJson(dir);
    assert.deepEqual(result.events[0], {
      ...baseEvent(c2, "2024-02-01T00:00:00.000Z", "tighten"),
      kind: "exception-changed",
      file: ".archtour/exceptions.yml",
      key: "no-privileged-containers service:db",
      weakened: false,
      before: { reason: "legacy", owner: "@alice", expires: "2025-12-31" },
      after: { reason: "still needed", owner: "@carol", expires: "2025-06-30" }
    });
  });
});

function writeRules(dir, doc) {
  writeFile(dir, ".archtour/rules.yml", `${JSON.stringify(doc, null, 2)}\n`);
}

test("rules: add, remove, weaken, neutral changes, where and owners", async () => {
  await withRepo("archtour-audit-log-rules-", async (dir) => {
    const c1 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "hard", owners: ["@a"], adjustable: false },
          { id: "rule-b", level: "soft" }
        ]
      });
      return commitAll(dir, { message: "initial rules", date: "2024-01-01T00:00:00+0000" });
    })();

    const c2 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", enforce_from: "2025-01-01", owners: ["@a"], adjustable: false },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "weaken a and strengthen b", date: "2024-02-01T00:00:00+0000" });
    })();

    const c3 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", enforce_from: "2025-01-01", owners: ["@a"], adjustable: false, where: { name: "*-dev", file: "src/**" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "add where", date: "2024-03-01T00:00:00+0000" });
    })();

    const c4 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", enforce_from: "2025-01-01", owners: ["@a"], adjustable: false, where: { file: "src/**", name: "*-dev" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "reorder where keys", date: "2024-04-01T00:00:00+0000" });
    })();

    const c5 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", enforce_from: "2025-01-01", owners: ["@b"], adjustable: false, where: { file: "src/**", name: "*-dev" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "change owners", date: "2024-05-01T00:00:00+0000" });
    })();

    const c6 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", enforce_from: "2025-01-01", owners: ["@b"], adjustable: true, where: { file: "src/**", name: "*-dev" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "make adjustable", date: "2024-06-01T00:00:00+0000" });
    })();

    const c7 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", enforce_from: "2024-12-01", owners: ["@b"], adjustable: true, where: { file: "src/**", name: "*-dev" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "enforce earlier", date: "2024-07-01T00:00:00+0000" });
    })();

    const c8 = (() => {
      writeRules(dir, {
        version: 1,
        extends: ["archtour:recommended"],
        rules: [
          { id: "rule-a", level: "soft", owners: ["@b"], adjustable: true, where: { file: "src/**", name: "*-dev" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "drop enforce_from", date: "2024-08-01T00:00:00+0000" });
    })();

    const c9 = (() => {
      writeRules(dir, {
        version: 1,
        rules: [
          { id: "rule-a", level: "soft", owners: ["@b"], adjustable: true, where: { file: "src/**", name: "*-dev" } },
          { id: "rule-b", level: "hard" }
        ]
      });
      return commitAll(dir, { message: "drop extends", date: "2024-09-01T00:00:00+0000" });
    })();

    const c10 = (() => {
      writeRules(dir, {
        version: 1,
        rules: [
          { id: "rule-a", level: "soft", owners: ["@b"], adjustable: true, where: { file: "src/**", name: "*-dev" } }
        ]
      });
      return commitAll(dir, { message: "remove rule b", date: "2024-10-01T00:00:00+0000" });
    })();

    const result = auditJson(dir);
    const forCommit = (sha) => result.events.filter((event) => event.commit === sha);

    assert.deepEqual(forCommit(c1), [
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "initial rules"),
        kind: "extends-changed",
        file: ".archtour/rules.yml",
        key: "extends",
        weakened: false,
        before: [],
        after: ["archtour:recommended"]
      },
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "initial rules"),
        kind: "rule-added",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: false,
        after: { level: "hard", enforce_from: null, owners: ["@a"], adjustable: false }
      },
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "initial rules"),
        kind: "rule-added",
        file: ".archtour/rules.yml",
        key: "rule-b",
        weakened: false,
        after: { level: "soft", enforce_from: null, owners: null, adjustable: null }
      }
    ]);

    assert.deepEqual(forCommit(c2), [
      {
        ...baseEvent(c2, "2024-02-01T00:00:00.000Z", "weaken a and strengthen b"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: true,
        before: { level: "hard", enforce_from: null },
        after: { level: "soft", enforce_from: "2025-01-01" }
      },
      {
        ...baseEvent(c2, "2024-02-01T00:00:00.000Z", "weaken a and strengthen b"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-b",
        weakened: false,
        before: { level: "soft" },
        after: { level: "hard" }
      }
    ]);

    assert.deepEqual(forCommit(c3), [
      {
        ...baseEvent(c3, "2024-03-01T00:00:00.000Z", "add where"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: null,
        before: { where: null },
        after: { where: { name: "*-dev", file: "src/**" } }
      }
    ]);

    assert.deepEqual(forCommit(c4), []);

    assert.deepEqual(forCommit(c5), [
      {
        ...baseEvent(c5, "2024-05-01T00:00:00.000Z", "change owners"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: null,
        before: { owners: ["@a"] },
        after: { owners: ["@b"] }
      }
    ]);

    assert.deepEqual(forCommit(c6), [
      {
        ...baseEvent(c6, "2024-06-01T00:00:00.000Z", "make adjustable"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: true,
        before: { adjustable: false },
        after: { adjustable: true }
      }
    ]);

    assert.deepEqual(forCommit(c7), [
      {
        ...baseEvent(c7, "2024-07-01T00:00:00.000Z", "enforce earlier"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: false,
        before: { enforce_from: "2025-01-01" },
        after: { enforce_from: "2024-12-01" }
      }
    ]);

    assert.deepEqual(forCommit(c8), [
      {
        ...baseEvent(c8, "2024-08-01T00:00:00.000Z", "drop enforce_from"),
        kind: "rule-changed",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: false,
        before: { enforce_from: "2024-12-01" },
        after: { enforce_from: null }
      }
    ]);

    assert.deepEqual(forCommit(c9), [
      {
        ...baseEvent(c9, "2024-09-01T00:00:00.000Z", "drop extends"),
        kind: "extends-changed",
        file: ".archtour/rules.yml",
        key: "extends",
        weakened: true,
        before: ["archtour:recommended"],
        after: []
      }
    ]);

    assert.deepEqual(forCommit(c10), [
      {
        ...baseEvent(c10, "2024-10-01T00:00:00.000Z", "remove rule b"),
        kind: "rule-removed",
        file: ".archtour/rules.yml",
        key: "rule-b",
        weakened: true,
        before: { level: "hard", enforce_from: null, owners: null, adjustable: null }
      }
    ]);
  });
});

test("baseline: raised and lowered counts, absent is zero", async () => {
  await withRepo("archtour-audit-log-base-", async (dir) => {
    writeFile(dir, ".archtour/baseline.json", JSON.stringify({ "rule-a": 2 }, null, 2) + "\n");
    const c1 = commitAll(dir, { message: "lock baseline", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/baseline.json", JSON.stringify({ "rule-a": 2, "rule-b": 5 }, null, 2) + "\n");
    const c2 = commitAll(dir, { message: "raise rule b", date: "2024-02-01T00:00:00+0000" });

    writeFile(dir, ".archtour/baseline.json", JSON.stringify({ "rule-a": 1, "rule-b": 5 }, null, 2) + "\n");
    const c3 = commitAll(dir, { message: "lower rule a", date: "2024-03-01T00:00:00+0000" });

    writeFile(dir, ".archtour/baseline.json", JSON.stringify({ "rule-b": 5 }, null, 2) + "\n");
    const c4 = commitAll(dir, { message: "drop rule a", date: "2024-04-01T00:00:00+0000" });

    const result = auditJson(dir);

    assert.deepEqual(result.events, [
      {
        ...baseEvent(c4, "2024-04-01T00:00:00.000Z", "drop rule a"),
        kind: "baseline-lowered",
        file: ".archtour/baseline.json",
        key: "rule-a",
        weakened: false,
        before: 1,
        after: 0
      },
      {
        ...baseEvent(c3, "2024-03-01T00:00:00.000Z", "lower rule a"),
        kind: "baseline-lowered",
        file: ".archtour/baseline.json",
        key: "rule-a",
        weakened: false,
        before: 2,
        after: 1
      },
      {
        ...baseEvent(c2, "2024-02-01T00:00:00.000Z", "raise rule b"),
        kind: "baseline-raised",
        file: ".archtour/baseline.json",
        key: "rule-b",
        weakened: true,
        before: 0,
        after: 5
      },
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "lock baseline"),
        kind: "baseline-raised",
        file: ".archtour/baseline.json",
        key: "rule-a",
        weakened: true,
        before: 0,
        after: 2
      }
    ]);
  });
});

test("merge commits are compared with their first parent", async () => {
  await withRepo("archtour-audit-log-merge-", async (dir) => {
    writeFile(dir, "README.md", "one\n");
    commitAll(dir, { message: "start", date: "2024-01-01T00:00:00+0000" });

    git(dir, ["checkout", "-b", "feature"]);
    writeFile(dir, ".archtour/exceptions.yml", EXCEPTIONS_ONE);
    const featureCommit = commitAll(dir, { message: "add exception on feature", date: "2024-01-02T00:00:00+0000" });

    git(dir, ["checkout", "main"]);
    writeFile(dir, "README.md", "two\n");
    commitAll(dir, { message: "readme on main", date: "2024-01-03T00:00:00+0000" });

    git(dir, ["merge", "--no-ff", "feature", "-m", "merge feature"], {
      GIT_AUTHOR_DATE: "2024-01-04T00:00:00+0000",
      GIT_COMMITTER_DATE: "2024-01-04T00:00:00+0000"
    });
    const mergeCommit = git(dir, ["rev-parse", "HEAD"]);

    const result = auditJson(dir);
    assert.deepEqual(result.events, [
      {
        ...baseEvent(mergeCommit, "2024-01-04T00:00:00.000Z", "merge feature"),
        kind: "exception-added",
        file: ".archtour/exceptions.yml",
        key: "no-privileged-containers service:db",
        weakened: true,
        after: { reason: "legacy database", owner: "@alice", expires: "2025-12-31" }
      }
    ]);
    assert.equal(result.events.some((event) => event.commit === featureCommit), false);
  });
});

test("a .yml to .yaml rename is not an add plus a remove", async () => {
  await withRepo("archtour-audit-log-rename-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", EXCEPTIONS_ONE);
    const c1 = commitAll(dir, { message: "add exceptions", date: "2024-01-01T00:00:00+0000" });

    git(dir, ["mv", ".archtour/exceptions.yml", ".archtour/exceptions.yaml"]);
    commitAll(dir, { message: "rename exceptions file", date: "2024-01-02T00:00:00+0000" });

    const result = auditJson(dir);
    assert.deepEqual(result.events, [
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "add exceptions"),
        kind: "exception-added",
        file: ".archtour/exceptions.yml",
        key: "no-privileged-containers service:db",
        weakened: true,
        after: { reason: "legacy database", owner: "@alice", expires: "2025-12-31" }
      }
    ]);
    assert.equal(result.current.exceptions.length, 1);
    assert.equal(result.current.exceptions[0].expires, "2025-12-31");
  });
});

test("an unparsable version gives one parse-error and is empty for the next commit", async () => {
  await withRepo("archtour-audit-log-parse-", async (dir) => {
    writeRules(dir, { version: 1, rules: [{ id: "rule-a", level: "hard" }] });
    const c1 = commitAll(dir, { message: "valid rules", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/rules.yml", "version: 1\nrules: [\n");
    const c2 = commitAll(dir, { message: "break rules", date: "2024-01-02T00:00:00+0000" });

    writeRules(dir, {
      version: 1,
      rules: [
        { id: "rule-a", level: "hard" },
        { id: "rule-b", level: "warn" }
      ]
    });
    const c3 = commitAll(dir, { message: "fix rules", date: "2024-01-03T00:00:00+0000" });

    const result = auditJson(dir);

    const [first, second, parseError, last] = result.events;
    assert.deepEqual([first, second, last], [
      {
        ...baseEvent(c3, "2024-01-03T00:00:00.000Z", "fix rules"),
        kind: "rule-added",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: false,
        after: { level: "hard", enforce_from: null, owners: null, adjustable: null }
      },
      {
        ...baseEvent(c3, "2024-01-03T00:00:00.000Z", "fix rules"),
        kind: "rule-added",
        file: ".archtour/rules.yml",
        key: "rule-b",
        weakened: false,
        after: { level: "warn", enforce_from: null, owners: null, adjustable: null }
      },
      {
        ...baseEvent(c1, "2024-01-01T00:00:00.000Z", "valid rules"),
        kind: "rule-added",
        file: ".archtour/rules.yml",
        key: "rule-a",
        weakened: false,
        after: { level: "hard", enforce_from: null, owners: null, adjustable: null }
      }
    ]);

    const { message, ...parseRest } = parseError;
    assert.deepEqual(parseRest, {
      ...baseEvent(c2, "2024-01-02T00:00:00.000Z", "break rules"),
      kind: "parse-error",
      file: ".archtour/rules.yml",
      key: "",
      weakened: null
    });
    assert.match(message, /^Failed to parse YAML: /);
  });
});

test("current exceptions: status and the newest add/change commit", async () => {
  await withRepo("archtour-audit-log-current-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: rule-a
    target: a
    reason: expired one
    owner: "@a"
    expires: "2025-06-14"
  - rule: rule-b
    target: b
    reason: expiring one
    owner: "@b"
    expires: "2025-07-10"
  - rule: rule-c
    target: c
    reason: active one
    owner: "@c"
    expires: "2025-12-31"
  - rule: rule-d
    target: d
    reason: no expiry
    owner: "@d"
`);
    const c1 = commitAll(dir, { message: "add four exceptions", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: rule-a
    target: a
    reason: expired one
    owner: "@a"
    expires: "2025-06-14"
  - rule: rule-b
    target: b
    reason: expiring one, still needed
    owner: "@b"
    expires: "2025-07-10"
  - rule: rule-c
    target: c
    reason: active one
    owner: "@c"
    expires: "2025-12-31"
  - rule: rule-d
    target: d
    reason: no expiry
    owner: "@d"
`);
    const c2 = commitAll(dir, { message: "change expiring reason", date: "2024-02-01T00:00:00+0000" });

    const result = auditJson(dir, ["--as-of", "2025-06-15"]);
    assert.deepEqual(result.current.exceptions, [
      {
        rule: "rule-a",
        target: "a",
        reason: "expired one",
        owner: "@a",
        expires: "2025-06-14",
        added: { commit: c1, date: "2024-01-01T00:00:00.000Z", author: AUTHOR },
        status: "expired"
      },
      {
        rule: "rule-b",
        target: "b",
        reason: "expiring one, still needed",
        owner: "@b",
        expires: "2025-07-10",
        added: { commit: c2, date: "2024-02-01T00:00:00.000Z", author: AUTHOR },
        status: "expiring"
      },
      {
        rule: "rule-c",
        target: "c",
        reason: "active one",
        owner: "@c",
        expires: "2025-12-31",
        added: { commit: c1, date: "2024-01-01T00:00:00.000Z", author: AUTHOR },
        status: "active"
      },
      {
        rule: "rule-d",
        target: "d",
        reason: "no expiry",
        owner: "@d",
        expires: null,
        added: { commit: c1, date: "2024-01-01T00:00:00.000Z", author: AUTHOR },
        status: "no-expiry"
      }
    ]);

    const windowed = auditJson(dir, ["--as-of", "2025-06-15", "--since", "2024-02-01"]);
    assert.deepEqual(
      windowed.current.exceptions.map((entry) => entry.added),
      [null, { commit: c2, date: "2024-02-01T00:00:00.000Z", author: AUTHOR }, null, null]
    );
  });
});

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test("CSV: exact header, RFC 4180 quoting and formula injection", async () => {
  await withRepo("archtour-audit-log-csv-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", EXCEPTIONS_ONE);
    const c1 = commitAll(dir, { message: "add exceptions", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:
  - rule: no-privileged-containers
    target: service:db
    reason: 'he said "no", twice'
    owner: "@alice"
    expires: "2025-12-31"
`);
    const c2 = commitAll(dir, { message: "=SUM(1,2)", date: "2024-01-02T00:00:00+0000" });

    const result = runCli(["audit-log", dir, "--csv"]);
    assert.equal(result.status, 0, result.stderr);
    const rows = parseCsv(result.stdout);

    assert.deepEqual(rows[0], [
      "date",
      "commit",
      "author",
      "email",
      "subject",
      "kind",
      "file",
      "key",
      "weakened",
      "before",
      "after",
      "message"
    ]);

    assert.deepEqual(rows[1], [
      "2024-01-02T00:00:00.000Z",
      c2,
      AUTHOR,
      EMAIL,
      "'=SUM(1,2)",
      "exception-changed",
      ".archtour/exceptions.yml",
      "no-privileged-containers service:db",
      "false",
      JSON.stringify({ reason: "legacy database" }),
      JSON.stringify({ reason: 'he said "no", twice' }),
      ""
    ]);

    assert.deepEqual(rows[2], [
      "2024-01-01T00:00:00.000Z",
      c1,
      AUTHOR,
      EMAIL,
      "add exceptions",
      "exception-added",
      ".archtour/exceptions.yml",
      "no-privileged-containers service:db",
      "true",
      "",
      JSON.stringify({ reason: "legacy database", owner: "@alice", expires: "2025-12-31" }),
      ""
    ]);
  });
});

test("default text report: header, event line, current exceptions, counts", async () => {
  await withRepo("archtour-audit-log-text-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", EXCEPTIONS_ONE);
    const c1 = commitAll(dir, { message: "add exceptions", date: "2024-01-01T00:00:00+0000" });
    const short = c1.slice(0, 7);

    const result = runCli(["audit-log", dir, "--as-of", "2025-06-15"]);
    assert.equal(result.status, 0, result.stderr);

    const expected = [
      `Repository: ${path.resolve(dir)}`,
      "Branch: HEAD",
      `Tip: ${c1}`,
      "Range: - .. -",
      "As of: 2025-06-15",
      "",
      "Events (newest first):",
      `2024-01-01T00:00:00.000Z ${short} ${AUTHOR} exception-added no-privileged-containers service:db - -> {"reason":"legacy database","owner":"@alice","expires":"2025-12-31"} [WEAKENED]`,
      "",
      "Current exceptions:",
      "RULE | TARGET | REASON | OWNER | EXPIRES | STATUS | ADDED",
      `no-privileged-containers | service:db | legacy database | @alice | 2025-12-31 | active | ${short}`,
      "",
      "Counts by kind: exception-added=1",
      "Weakened events: 1"
    ].join("\n");

    assert.equal(result.stdout, `${expected}\n`);
  });
});

test("--out writes the chosen output to a file without a BOM and nothing to stdout", async () => {
  await withRepo("archtour-audit-log-out-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", EXCEPTIONS_ONE);
    commitAll(dir, { message: "add exceptions", date: "2024-01-01T00:00:00+0000" });

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-audit-log-outfiles-"));
    try {
      const jsonPath = path.join(outDir, "report.json");
      const jsonRun = runCli(["audit-log", dir, "--json", "--out", jsonPath]);
      assert.equal(jsonRun.status, 0, jsonRun.stderr);
      assert.equal(jsonRun.stdout, "");
      const jsonBytes = fs.readFileSync(jsonPath);
      assert.notDeepEqual([...jsonBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const jsonText = jsonBytes.toString("utf8");
      assert.equal(jsonText.endsWith("\n"), true);
      const parsed = JSON.parse(jsonText);
      assert.equal(parsed.events.length, 1);
      assert.equal(parsed.summary.weakened, 1);

      const csvPath = path.join(outDir, "report.csv");
      const csvRun = runCli(["audit-log", dir, "--csv", "--out", csvPath]);
      assert.equal(csvRun.status, 0, csvRun.stderr);
      assert.equal(csvRun.stdout, "");
      const csvText = fs.readFileSync(csvPath, "utf8");
      assert.equal(
        csvText.split("\n")[0],
        "date,commit,author,email,subject,kind,file,key,weakened,before,after,message"
      );

      const textPath = path.join(outDir, "report.txt");
      const textRun = runCli(["audit-log", dir, "--out", textPath]);
      assert.equal(textRun.status, 0, textRun.stderr);
      assert.equal(textRun.stdout, "");
      const textText = fs.readFileSync(textPath, "utf8");
      assert.match(textText, /^Repository: /);
      assert.equal(textText.endsWith("\n"), true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

test("errors: exit 3 with one stderr line", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-audit-log-norepo-"));
  try {
    const notRepo = runCli(["audit-log", plain, "--json"]);
    assert.equal(notRepo.status, 3);
    assert.equal(notRepo.stdout, "");
    assert.equal(notRepo.stderr, `archtour: not a git repository: ${plain}\n`);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }

  await withRepo("archtour-audit-log-errors-", async (dir) => {
    writeFile(dir, "README.md", "one\n");
    commitAll(dir, { message: "start", date: "2024-01-01T00:00:00+0000" });

    const unknownBranch = runCli(["audit-log", dir, "--branch", "nope"]);
    assert.equal(unknownBranch.status, 3);
    assert.equal(unknownBranch.stdout, "");
    assert.match(unknownBranch.stderr, /^archtour: unknown branch: nope\n$/);

    const badSince = runCli(["audit-log", dir, "--since", "not-a-date"]);
    assert.equal(badSince.status, 3);
    assert.match(badSince.stderr, /^archtour: invalid --since date: not-a-date\n$/);

    const badUntil = runCli(["audit-log", dir, "--until", "2025-13-01"]);
    assert.equal(badUntil.status, 3);
    assert.match(badUntil.stderr, /^archtour: invalid --until date: 2025-13-01\n$/);

    const badAsOf = runCli(["audit-log", dir, "--as-of", "2025-02-30"]);
    assert.equal(badAsOf.status, 3);
    assert.match(badAsOf.stderr, /^archtour: invalid --as-of date: 2025-02-30\n$/);

    const both = runCli(["audit-log", dir, "--json", "--csv"]);
    assert.equal(both.status, 3);
    assert.equal(both.stdout, "");
    assert.match(both.stderr, /^archtour: --json and --csv cannot be combined\n$/);

    const unknownOption = runCli(["audit-log", dir, "--nope"]);
    assert.equal(unknownOption.status, 3);
    assert.equal(unknownOption.stdout, "");
    assert.match(unknownOption.stderr, /^archtour: unknown option --nope \(run 'archtour help audit-log'\)\n$/);
  });
});

test("a repository with no policy files has no events and exits 0", async () => {
  await withRepo("archtour-audit-log-empty-", async (dir) => {
    writeFile(dir, "README.md", "one\n");
    const head = commitAll(dir, { message: "start", date: "2024-01-01T00:00:00+0000" });

    const result = auditJson(dir);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.current, { exceptions: [] });
    assert.deepEqual(result.summary, { byKind: {}, weakened: 0 });
    assert.equal(result.head, head);
    assert.equal(result.asOf, new Date().toISOString().slice(0, 10));

    const text = runCli(["audit-log", dir]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\nEvents \(newest first\):\nnone\n\nCurrent exceptions:\nnone\n\nCounts by kind: none\nWeakened events: 0\n$/);
  });
});

test("--since, --until and --max-commits filter the walked commits", async () => {
  await withRepo("archtour-audit-log-window-", async (dir) => {
    writeFile(dir, ".archtour/exceptions.yml", `exceptions:\n  - rule: rule-a\n    target: a\n    reason: one\n    owner: "@a"\n    expires: "2025-12-31"\n`);
    commitAll(dir, { message: "january", date: "2024-01-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:\n  - rule: rule-a\n    target: a\n    reason: one\n    owner: "@a"\n    expires: "2025-12-31"\n  - rule: rule-b\n    target: b\n    reason: two\n    owner: "@b"\n    expires: "2025-12-31"\n`);
    commitAll(dir, { message: "february", date: "2024-02-01T00:00:00+0000" });

    writeFile(dir, ".archtour/exceptions.yml", `exceptions:\n  - rule: rule-a\n    target: a\n    reason: one\n    owner: "@a"\n    expires: "2025-12-31"\n  - rule: rule-b\n    target: b\n    reason: two\n    owner: "@b"\n    expires: "2025-12-31"\n  - rule: rule-c\n    target: c\n    reason: three\n    owner: "@c"\n    expires: "2025-12-31"\n`);
    commitAll(dir, { message: "march", date: "2024-03-01T00:00:00+0000" });

    const since = auditJson(dir, ["--since", "2024-02-01"]);
    assert.deepEqual(since.events.map((event) => event.key), ["rule-c c", "rule-b b"]);

    const until = auditJson(dir, ["--until", "2024-02-28"]);
    assert.deepEqual(until.events.map((event) => event.key), ["rule-b b", "rule-a a"]);

    const window = auditJson(dir, ["--since", "2024-02-01", "--until", "2024-02-28"]);
    assert.deepEqual(window.events.map((event) => event.key), ["rule-b b"]);

    const maxTwo = auditJson(dir, ["--max-commits", "2"]);
    assert.deepEqual(maxTwo.events.map((event) => event.key), ["rule-c c", "rule-b b"]);

    const maxOne = auditJson(dir, ["--max-commits", "1"]);
    assert.deepEqual(maxOne.events.map((event) => event.key), ["rule-c c"]);
  });
});

test("help audit-log is wired and the global help names the command", () => {
  const help = runCli(["help", "audit-log"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage: archtour audit-log /);
  for (const option of ["--branch", "--since", "--until", "--max-commits", "--as-of", "--json", "--csv", "--out"]) {
    assert.match(help.stdout, new RegExp(`^  ${option.replace("-", "\\-")}(?: <[^>]+>)?\\s`, "m"));
  }

  const global = runCli(["help"]);
  assert.equal(global.status, 0, global.stderr);
  assert.match(global.stdout, /^  audit-log \[<repoDir>\] +Audit policy changes/m);
});

// Orchestrator (T-134 review): a broken file that later commits do not touch gives one parse-error, not one per commit.
test("an untouched unparsable file is not reported again by later commits", async () => {
  await withRepo("archtour-audit-log-untouched-", async (dir) => {
    writeFile(dir, ".archtour/rules.yml", "version: 1\nrules: [\n");
    const c1 = commitAll(dir, { message: "broken rules", date: "2024-02-01T00:00:00+0000" });
    writeFile(dir, ".archtour/baseline.json", "{\"rule-a\": 2}\n");
    const c2 = commitAll(dir, { message: "baseline", date: "2024-02-02T00:00:00+0000" });

    const result = auditJson(dir);
    assert.deepEqual(result.events.map((event) => [event.commit, event.kind, event.file]), [
      [c2, "baseline-raised", ".archtour/baseline.json"],
      [c1, "parse-error", ".archtour/rules.yml"]
    ]);
  });
});
