// Archtour policy audit log
// Reads the policy files of a repository from its first-parent git history and reports every
// exception, rule, extends and baseline change with commit, date, author and reason.

import path from "node:path";
import YAML from "yaml";

import { runGit } from "./history.mjs";

const POLICY_PATHS = [
  ".archtour/exceptions.yml",
  ".archtour/exceptions.yaml",
  ".archtour/rules.yml",
  ".archtour/rules.yaml",
  ".archtour/baseline.json"
];

const LOGICAL_FILES = [
  { name: "exceptions", candidates: [".archtour/exceptions.yml", ".archtour/exceptions.yaml"] },
  { name: "rules", candidates: [".archtour/rules.yml", ".archtour/rules.yaml"] },
  { name: "baseline", candidates: [".archtour/baseline.json"] }
];

const LEVEL_SEVERITY = {
  off: 0,
  advisory: 1,
  warn: 2,
  soft: 3,
  hard: 4
};

export class AuditLogError extends Error {
  constructor(message, exitCode = 3) {
    super(message);
    this.name = "AuditLogError";
    this.exitCode = exitCode;
  }
}

function firstLine(text) {
  return String(text == null ? "" : text).split(/\r?\n/)[0].trim();
}

function toIsoUtc(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function parseDateArg(value, endOfDay = false) {
  const text = String(value == null ? "" : value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (
      utc.getUTCFullYear() !== year ||
      utc.getUTCMonth() !== month - 1 ||
      utc.getUTCDate() !== day
    ) {
      return null;
    }
    let time = utc.getTime();
    if (endOfDay) time += 24 * 60 * 60 * 1000 - 1;
    return { time, dateOnly: true };
  }
  const time = Date.parse(text);
  if (Number.isNaN(time)) return null;
  return { time, dateOnly: false };
}

function parseAsOf(value) {
  const text = String(value == null ? "" : value);
  if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(text)) return null;
  const parsed = parseDateArg(text, false);
  if (!parsed) return null;
  return text;
}

function emptyState(name) {
  if (name === "exceptions") return { map: new Map(), list: [] };
  if (name === "rules") return { extends: [], map: new Map() };
  return { map: new Map() };
}

function normalizeOwners(value) {
  if (value == null) return null;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function parseExceptionsContent(content) {
  let doc;
  try {
    doc = YAML.parse(content, { merge: true, logLevel: "error" });
  } catch (err) {
    return { error: `Failed to parse YAML: ${firstLine(err && err.message).slice(0, 200)}` };
  }

  let entries;
  if (doc == null) entries = [];
  else if (Array.isArray(doc)) entries = doc;
  else if (typeof doc === "object" && Array.isArray(doc.exceptions)) entries = doc.exceptions;
  else return { error: 'exceptions must be a list or an object with an "exceptions" list' };

  const map = new Map();
  const list = [];
  for (const item of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "exception entry must be an object" };
    }
    if (typeof item.rule !== "string" || typeof item.target !== "string") {
      return { error: "exception entry needs a rule and a target" };
    }
    const key = `${item.rule} ${item.target}`;
    const value = {
      reason: item.reason === undefined ? null : item.reason,
      owner: item.owner === undefined ? null : item.owner,
      expires: item.expires === undefined ? null : item.expires
    };
    map.set(key, value);
    list.push({ rule: item.rule, target: item.target, ...value });
  }
  return { value: { map, list } };
}

function parseRulesContent(content) {
  let doc;
  try {
    doc = YAML.parse(content, { merge: true, logLevel: "error" });
  } catch (err) {
    return { error: `Failed to parse YAML: ${firstLine(err && err.message).slice(0, 200)}` };
  }

  if (doc == null) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { error: "rules file must be an object" };
  }

  let extendsList = [];
  if (doc.extends != null) {
    if (typeof doc.extends === "string") {
      extendsList = [doc.extends];
    } else if (Array.isArray(doc.extends) && doc.extends.every((entry) => typeof entry === "string")) {
      extendsList = [...doc.extends];
    } else {
      return { error: '"extends" must be a string or a list of strings' };
    }
  }

  let rules = [];
  if (doc.rules != null) {
    if (!Array.isArray(doc.rules)) return { error: '"rules" must be a list' };
    rules = doc.rules;
  }

  const map = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.id !== "string" || !rule.id) {
      return { error: 'rule entry must be an object with an "id"' };
    }
    map.set(rule.id, {
      level: rule.level === undefined ? null : rule.level,
      enforce_from: rule.enforce_from === undefined ? null : rule.enforce_from,
      owners: normalizeOwners(rule.owners),
      adjustable: rule.adjustable === undefined ? null : rule.adjustable,
      where: rule.where === undefined ? null : rule.where
    });
  }

  return { value: { extends: extendsList, map } };
}

function parseBaselineContent(content) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    return { error: `Failed to parse JSON: ${firstLine(err && err.message).slice(0, 200)}` };
  }
  if (doc == null) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { error: "baseline must be a JSON object of rule counts" };
  }
  const map = new Map();
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: `baseline count for "${key}" must be a number` };
    }
    map.set(key, value);
  }
  return { value: { map } };
}

function parseFor(name, content) {
  if (name === "exceptions") return parseExceptionsContent(content);
  if (name === "rules") return parseRulesContent(content);
  return parseBaselineContent(content);
}

function sortedUnionKeys(beforeMap, afterMap) {
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
}

function ruleSnapshot(state) {
  return {
    level: state.level,
    enforce_from: state.enforce_from,
    owners: state.owners,
    adjustable: state.adjustable
  };
}

function diffExceptions(before, after) {
  const events = [];
  for (const key of sortedUnionKeys(before.map, after.map)) {
    const oldValue = before.map.get(key);
    const newValue = after.map.get(key);
    if (!oldValue && newValue) {
      events.push({ kind: "exception-added", key, after: { ...newValue }, weakened: true });
      continue;
    }
    if (oldValue && !newValue) {
      events.push({ kind: "exception-removed", key, before: { ...oldValue }, weakened: false });
      continue;
    }
    if (!oldValue || !newValue) continue;
    const beforeFields = {};
    const afterFields = {};
    for (const field of ["reason", "owner", "expires"]) {
      if (oldValue[field] !== newValue[field]) {
        beforeFields[field] = oldValue[field];
        afterFields[field] = newValue[field];
      }
    }
    if (Object.keys(beforeFields).length === 0) continue;
    let weakened = false;
    if (oldValue.expires !== newValue.expires) {
      if (oldValue.expires == null) {
        weakened = false;
      } else if (newValue.expires == null) {
        weakened = true;
      } else if (String(newValue.expires) > String(oldValue.expires)) {
        weakened = true;
      }
    }
    events.push({ kind: "exception-changed", key, before: beforeFields, after: afterFields, weakened });
  }
  return events;
}

function diffRules(before, after) {
  const events = [];

  if (JSON.stringify(before.extends) !== JSON.stringify(after.extends)) {
    const removed = before.extends.some((entry) => !after.extends.includes(entry));
    events.push({
      kind: "extends-changed",
      key: "extends",
      before: [...before.extends],
      after: [...after.extends],
      weakened: removed
    });
  }

  for (const id of sortedUnionKeys(before.map, after.map)) {
    const oldRule = before.map.get(id);
    const newRule = after.map.get(id);
    if (!oldRule && newRule) {
      events.push({ kind: "rule-added", key: id, after: ruleSnapshot(newRule), weakened: false });
      continue;
    }
    if (oldRule && !newRule) {
      events.push({ kind: "rule-removed", key: id, before: ruleSnapshot(oldRule), weakened: true });
      continue;
    }
    if (!oldRule || !newRule) continue;

    const beforeFields = {};
    const afterFields = {};
    let weakening = false;

    if (oldRule.level !== newRule.level) {
      beforeFields.level = oldRule.level;
      afterFields.level = newRule.level;
      if ((LEVEL_SEVERITY[newRule.level] ?? 0) < (LEVEL_SEVERITY[oldRule.level] ?? 0)) weakening = true;
    }

    if (oldRule.enforce_from !== newRule.enforce_from) {
      beforeFields.enforce_from = oldRule.enforce_from;
      afterFields.enforce_from = newRule.enforce_from;
      if (oldRule.enforce_from == null && newRule.enforce_from != null) {
        weakening = true;
      } else if (
        oldRule.enforce_from != null &&
        newRule.enforce_from != null &&
        String(newRule.enforce_from) > String(oldRule.enforce_from)
      ) {
        weakening = true;
      }
    }

    if (oldRule.adjustable !== newRule.adjustable) {
      beforeFields.adjustable = oldRule.adjustable;
      afterFields.adjustable = newRule.adjustable;
      if (oldRule.adjustable === false && newRule.adjustable === true) weakening = true;
    }

    if (canonicalJson(oldRule.where) !== canonicalJson(newRule.where)) {
      beforeFields.where = oldRule.where;
      afterFields.where = newRule.where;
    }

    if (JSON.stringify(oldRule.owners) !== JSON.stringify(newRule.owners)) {
      beforeFields.owners = oldRule.owners;
      afterFields.owners = newRule.owners;
    }

    if (Object.keys(beforeFields).length === 0) continue;

    let weakened;
    if (weakening) {
      weakened = true;
    } else if (
      beforeFields.level !== undefined ||
      beforeFields.enforce_from !== undefined ||
      beforeFields.adjustable !== undefined
    ) {
      weakened = false;
    } else {
      weakened = null;
    }

    events.push({ kind: "rule-changed", key: id, before: beforeFields, after: afterFields, weakened });
  }

  return events;
}

function diffBaseline(before, after) {
  const events = [];
  for (const key of sortedUnionKeys(before.map, after.map)) {
    const oldCount = before.map.get(key) ?? 0;
    const newCount = after.map.get(key) ?? 0;
    if (newCount > oldCount) {
      events.push({ kind: "baseline-raised", key, before: oldCount, after: newCount, weakened: true });
    } else if (newCount < oldCount) {
      events.push({ kind: "baseline-lowered", key, before: oldCount, after: newCount, weakened: false });
    }
  }
  return events;
}

function diffFor(name, before, after) {
  if (name === "exceptions") return diffExceptions(before, after);
  if (name === "rules") return diffRules(before, after);
  return diffBaseline(before, after);
}

function makeEvent(commit, kind, file, key, weakened, before, after, message) {
  const event = {
    date: toIsoUtc(commit.date),
    commit: commit.sha,
    author: commit.author,
    email: commit.email,
    subject: commit.subject,
    kind,
    file,
    key,
    weakened
  };
  if (before !== undefined) event.before = before;
  if (after !== undefined) event.after = after;
  if (message !== undefined) event.message = message;
  return event;
}

function parseLog(output) {
  const commits = [];
  for (const chunk of String(output || "").split("\u001e")) {
    if (!chunk) continue;
    const [header, ...fileLines] = chunk.split("\n");
    const parts = header.split("\u001f");
    if (parts.length < 6) continue;
    const sha = parts[0].trim();
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    const parents = parts[1].trim() ? parts[1].trim().split(" ") : [];
    commits.push({
      sha,
      parents,
      date: parts[2],
      author: parts[3],
      email: parts[4],
      subject: parts[5],
      files: new Set(fileLines.map((line) => line.trim()).filter(Boolean))
    });
  }
  return commits;
}

function statusFor(expires, asOf) {
  if (typeof expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return "no-expiry";
  const expiresMs = Date.UTC(
    Number(expires.slice(0, 4)),
    Number(expires.slice(5, 7)) - 1,
    Number(expires.slice(8, 10))
  );
  const asOfMs = Date.UTC(
    Number(asOf.slice(0, 4)),
    Number(asOf.slice(5, 7)) - 1,
    Number(asOf.slice(8, 10))
  );
  const days = Math.round((expiresMs - asOfMs) / (24 * 60 * 60 * 1000));
  if (days < 0) return "expired";
  if (days <= 30) return "expiring";
  return "active";
}

export async function auditLog(repoDir = ".", opts = {}) {
  const dir = path.resolve(repoDir);
  const branch = opts.branch ? String(opts.branch) : "HEAD";
  const maxCommits = opts.maxCommits == null ? 1000 : Number(opts.maxCommits);

  if (!Number.isInteger(maxCommits) || maxCommits < 1) {
    throw new AuditLogError("--max-commits must be a whole number >= 1");
  }

  let since = null;
  if (opts.since != null) {
    since = parseDateArg(opts.since, false);
    if (!since) throw new AuditLogError(`invalid --since date: ${opts.since}`);
  }
  let until = null;
  if (opts.until != null) {
    until = parseDateArg(opts.until, true);
    if (!until) throw new AuditLogError(`invalid --until date: ${opts.until}`);
  }
  const asOf = opts.asOf != null ? parseAsOf(opts.asOf) : new Date().toISOString().slice(0, 10);
  if (!asOf) throw new AuditLogError(`invalid --as-of date: ${opts.asOf}`);

  try {
    await runGit(dir, ["rev-parse", "--git-dir"]);
  } catch {
    throw new AuditLogError(`not a git repository: ${repoDir}`);
  }

  if (branch.startsWith("-")) throw new AuditLogError(`unknown branch: ${branch}`);

  let head;
  try {
    head = (await runGit(dir, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
  } catch {
    throw new AuditLogError(`unknown branch: ${branch}`);
  }

  const logArgs = [
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--name-only",
    "--format=%x1e%H%x1f%P%x1f%cI%x1f%an%x1f%ae%x1f%s",
    branch,
    "--",
    ...POLICY_PATHS
  ];

  let logOutput;
  try {
    logOutput = await runGit(dir, logArgs);
  } catch (err) {
    throw new AuditLogError(`git log failed: ${firstLine(err && err.message)}`);
  }

  const commits = parseLog(logOutput).filter((commit) => {
    const time = Date.parse(commit.date);
    if (Number.isNaN(time)) return true;
    if (since && time < since.time) return false;
    if (until && time > until.time) return false;
    return true;
  }).slice(0, maxCommits);

  const contentCache = new Map();
  async function readAt(ref, filePath) {
    const cacheKey = `${ref}\u0000${filePath}`;
    if (contentCache.has(cacheKey)) return contentCache.get(cacheKey);
    let content = null;
    try {
      content = await runGit(dir, ["show", `${ref}:${filePath}`]);
    } catch {
      content = null;
    }
    contentCache.set(cacheKey, content);
    return content;
  }

  async function readLogical(ref, logical) {
    for (const candidate of logical.candidates) {
      const content = await readAt(ref, candidate);
      if (content !== null) return { path: candidate, content };
    }
    return null;
  }

  const events = [];

  for (const commit of commits) {
    const parent = commit.parents[0] || null;

    for (const logical of LOGICAL_FILES) {
      // Orchestrator: only the files this commit changed; an untouched file has no events (and an untouched
      // unparsable file must not give a parse-error again on every later commit).
      if (!logical.candidates.some((candidate) => commit.files.has(candidate))) continue;
      const afterRead = await readLogical(commit.sha, logical);
      let afterPath = afterRead ? afterRead.path : null;
      let afterValue = emptyState(logical.name);
      let afterError = null;
      if (afterRead) {
        const parsed = parseFor(logical.name, afterRead.content);
        if (parsed.error) afterError = parsed.error;
        else afterValue = parsed.value;
      }

      const beforeRead = parent ? await readLogical(parent, logical) : null;
      let beforeValue = emptyState(logical.name);
      if (beforeRead) {
        const parsed = parseFor(logical.name, beforeRead.content);
        if (!parsed.error) beforeValue = parsed.value;
      }

      if (afterError) {
        events.push(makeEvent(commit, "parse-error", afterPath, "", null, undefined, undefined, afterError));
        continue;
      }
      if (!afterRead && !beforeRead) continue;

      const file = afterPath || beforeRead.path;
      for (const change of diffFor(logical.name, beforeValue, afterValue)) {
        events.push(
          makeEvent(commit, change.kind, file, change.key, change.weakened, change.before, change.after)
        );
      }
    }
  }

  const tipRead = await readLogical(head, LOGICAL_FILES[0]);
  let tipExceptions = { map: new Map(), list: [] };
  if (tipRead) {
    const parsed = parseExceptionsContent(tipRead.content);
    if (!parsed.error) tipExceptions = parsed.value;
  }

  const addedByKey = new Map();
  for (const event of events) {
    if (event.kind !== "exception-added" && event.kind !== "exception-changed") continue;
    if (addedByKey.has(event.key)) continue;
    addedByKey.set(event.key, {
      commit: event.commit,
      date: event.date,
      author: event.author
    });
  }

  const currentExceptions = tipExceptions.list.map((entry) => {
    const key = `${entry.rule} ${entry.target}`;
    return {
      rule: entry.rule,
      target: entry.target,
      reason: entry.reason,
      owner: entry.owner,
      expires: entry.expires,
      added: addedByKey.get(key) || null,
      status: statusFor(entry.expires, asOf)
    };
  });

  const byKind = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] || 0) + 1;
  const sortedByKind = {};
  for (const kind of Object.keys(byKind).sort()) sortedByKind[kind] = byKind[kind];

  return {
    repo: dir,
    branch,
    head,
    since: opts.since == null ? null : String(opts.since),
    until: opts.until == null ? null : String(opts.until),
    asOf,
    events,
    current: { exceptions: currentExceptions },
    summary: {
      byKind: sortedByKind,
      weakened: events.filter((event) => event.weakened === true).length
    }
  };
}

function displayValue(value) {
  if (value === undefined) return "-";
  return JSON.stringify(value);
}

export function formatAuditLogText(result) {
  const lines = [
    `Repository: ${result.repo}`,
    `Branch: ${result.branch}`,
    `Tip: ${result.head}`,
    `Range: ${result.since ?? "-"} .. ${result.until ?? "-"}`,
    `As of: ${result.asOf}`,
    "",
    "Events (newest first):"
  ];

  if (result.events.length === 0) {
    lines.push("none");
  } else {
    for (const event of result.events) {
      const marker = event.weakened === true ? " [WEAKENED]" : "";
      const message = event.kind === "parse-error" ? ` (${event.message})` : "";
      lines.push(
        `${event.date} ${event.commit.slice(0, 7)} ${event.author} ${event.kind} ` +
          `${event.key || "-"} ${displayValue(event.before)} -> ${displayValue(event.after)}${marker}${message}`
      );
    }
  }

  lines.push("", "Current exceptions:");
  if (result.current.exceptions.length === 0) {
    lines.push("none");
  } else {
    lines.push("RULE | TARGET | REASON | OWNER | EXPIRES | STATUS | ADDED");
    for (const entry of result.current.exceptions) {
      lines.push(
        `${entry.rule} | ${entry.target} | ${entry.reason ?? "-"} | ${entry.owner ?? "-"} | ` +
          `${entry.expires ?? "-"} | ${entry.status} | ${entry.added ? entry.added.commit.slice(0, 7) : "-"}`
      );
    }
  }

  const kinds = Object.keys(result.summary.byKind);
  lines.push(
    "",
    `Counts by kind: ${kinds.length === 0 ? "none" : kinds.map((kind) => `${kind}=${result.summary.byKind[kind]}`).join(", ")}`,
    `Weakened events: ${result.summary.weakened}`
  );

  return lines.join("\n");
}

function csvCell(value) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatAuditLogCsv(result) {
  const rows = [
    ["date", "commit", "author", "email", "subject", "kind", "file", "key", "weakened", "before", "after", "message"]
  ];
  for (const event of result.events) {
    rows.push([
      event.date,
      event.commit,
      event.author,
      event.email,
      event.subject,
      event.kind,
      event.file,
      event.key,
      event.weakened === null ? "null" : String(event.weakened),
      event.before === undefined ? "" : JSON.stringify(event.before),
      event.after === undefined ? "" : JSON.stringify(event.after),
      event.message === undefined ? "" : event.message
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}
