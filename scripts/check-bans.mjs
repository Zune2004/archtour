import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SCRIPT_FILE));
const DIR_ARG = process.argv[2];
const DIR = DIR_ARG && isAbsolute(DIR_ARG) ? DIR_ARG : join(ROOT, DIR_ARG || "tools");
const PACKAGE_PATH = process.env.ARCHTOUR_BANS_PACKAGE || join(ROOT, "package.json");

const PROCESS_OWNERS = [
  { file: "changed.mjs", reason: "runs git via execFile/spawn to enumerate changed files" },
  { file: "history.mjs", reason: "runs git via execFile to read commit history" },
  { file: "helm-render.mjs", reason: "runs helm via execFile to render charts" },
];
const PROCESS_OWNER_FILES = new Set(PROCESS_OWNERS.map((o) => o.file));

const FS_WRITERS = [
  { file: "changed.mjs", reason: "temporary folders for rendering + writes rendered chart files" },
  { file: "cli.mjs", reason: "output files the user asked for with -o/--md-out and JSON specs" },
  { file: "facts-cache.mjs", reason: "the facts cache" },
  { file: "helm-render.mjs", reason: "temporary folders for rendering" },
  { file: "override.mjs", reason: "appends to GITHUB_ENV / GITHUB_OUTPUT in CI" },
];
const FS_WRITER_FILES = new Set(FS_WRITERS.map((w) => w.file));

const NETWORK_MODULES = ["http", "https", "net", "tls", "dns", "dgram", "http2"];
const WRITE_CALLS = [
  "writeFileSync", "writeFile", "appendFileSync", "appendFile", "mkdirSync", "mkdtempSync",
  "rmSync", "rm", "renameSync", "copyFileSync", "cpSync", "unlinkSync", "createWriteStream",
];
const WRITE_CALL_RE = new RegExp("\\b(" + WRITE_CALLS.join("|") + ")\\b\\(");

function stripComments(text) {
  const lines = text.split("\n");
  const out = new Array(lines.length).fill("");
  let inBlock = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let i = 0;
    let cur = "";

    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          i = line.length;
        } else {
          i = end + 2;
          inBlock = false;
        }
      } else {
        const slash = line.indexOf("//", i);
        const star = line.indexOf("/*", i);

        let next = -1;
        let isLineComment = false;
        let isBlockComment = false;

        if (slash !== -1 && star !== -1) {
          next = Math.min(slash, star);
          isLineComment = slash <= star;
          isBlockComment = star < slash;
        } else if (slash !== -1) {
          next = slash;
          isLineComment = true;
        } else if (star !== -1) {
          next = star;
          isBlockComment = true;
        } else {
          cur += line.slice(i);
          break;
        }

        cur += line.slice(i, next);

        if (isLineComment) {
          break;
        } else if (isBlockComment) {
          i = next + 2;
          inBlock = true;
        }
      }
    }

    out[lineIdx] = cur;
  }

  return out;
}

function importModule(line) {
  const m = /from\s*["'](node:)?([^"']+)["']/.exec(line);
  return m ? m[2] : null;
}

function hitsForFile(name, lines) {
  const hits = [];
  const childProcess = /from\s*["'](node:)?child_process["']/.test(lines.join("\n"));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const module = importModule(line);

    if (module && NETWORK_MODULES.includes(module)) {
      hits.push({ line: i + 1, id: "no-network", what: `imports "${module}"` });
    }
    if (/\bfetch\(/.test(line)) {
      hits.push({ line: i + 1, id: "no-network", what: "calls fetch()" });
    }

    const isImport = /^\s*import\b/.test(line);

    if (childProcess && isImport) {
      if (/\bexecSync\b/.test(line)) {
        hits.push({ line: i + 1, id: "no-shell", what: "imports execSync from child_process" });
      } else if (/\bexec\b/.test(line)) {
        hits.push({ line: i + 1, id: "no-shell", what: "imports exec from child_process" });
      }
    }
    if (childProcess && /(?:^|[^\w.])execSync\s*\(/.test(line)) {
      hits.push({ line: i + 1, id: "no-shell", what: "calls execSync()" });
    }
    if (childProcess && /(?:^|[^\w.])exec\s*\(/.test(line)) {
      hits.push({ line: i + 1, id: "no-shell", what: "calls exec()" });
    }
    if (/shell\s*:\s*true/.test(line)) {
      hits.push({ line: i + 1, id: "no-shell", what: "passes shell: true" });
    }

    if (childProcess && !PROCESS_OWNER_FILES.has(name) && module === "child_process") {
      hits.push({ line: i + 1, id: "process-owners", what: "imports child_process" });
    }

    const writeMatch = WRITE_CALL_RE.exec(line);
    if (writeMatch && !FS_WRITER_FILES.has(name)) {
      hits.push({ line: i + 1, id: "fs-writers", what: `calls ${writeMatch[1]}()` });
    }

    if (module === "assert" || module === "node:assert") {
      hits.push({ line: i + 1, id: "no-test-detection", what: 'imports assert from node:assert' });
    }
    if (module === "test" || module === "node:test") {
      hits.push({ line: i + 1, id: "no-test-detection", what: 'imports from node:test' });
    }
    if (/\.stack/.test(line)) {
      hits.push({ line: i + 1, id: "no-test-detection", what: "reads Error().stack" });
    }
    if (/NODE_TEST_CONTEXT/.test(line)) {
      hits.push({ line: i + 1, id: "no-test-detection", what: "reads NODE_TEST_CONTEXT" });
    }
    if (/process\.argv/.test(line) && /--test/.test(line)) {
      hits.push({ line: i + 1, id: "no-test-detection", what: 'compares process.argv with "--test"' });
    }
  }
  return hits;
}

const FIXES = {
  "no-network": "Archtour runs offline and never downloads or uploads anything -> read what you need from the repo or from git",
  "no-shell": "a shell would parse file names that come from the pull request -> use execFile or spawn with an argument array",
  "process-owners": `only ${PROCESS_OWNERS.map((o) => o.file).join(", ")} start processes -> call a function from one of them, or add this file to PROCESS_OWNERS with a reason`,
  "fs-writers": `only ${FS_WRITERS.map((w) => w.file).join(", ")} write files -> return the data and let the caller write it, or add this file to FS_WRITERS with a reason`,
  "no-test-detection": "production code must not detect or depend on the test runner -> change the behaviour so the test passes for real",
};

function runtimeDepsHit() {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  } catch {
    return { line: 1, id: "runtime-deps", what: "cannot read package.json" };
  }
  const deps = pkg.dependencies || {};
  const keys = Object.keys(deps);
  const allowed = ["graphql", "yaml"];
  const extras = keys.filter((k) => !allowed.includes(k));
  const missing = allowed.filter((k) => !(k in deps));
  if (extras.length === 0 && missing.length === 0) return null;
  const what = extras.length > 0 ? `extra dependency${extras.length > 1 ? "s" : ""} ${extras.join(", ")}` : `missing dependency${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`;
  const name = extras.length > 0 ? extras.join(", ") : missing.join(", ");
  return { line: 1, id: "runtime-deps", what, fixName: name };
}

function main() {
  const hits = [];
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => statSync(join(DIR, f)).isFile())
    .sort();

  for (const name of files) {
    const text = readFileSync(join(DIR, name), "utf8");
    for (const h of hitsForFile(name, stripComments(text))) {
      hits.push({ file: name, ...h });
    }
  }

  const depHit = runtimeDepsHit();
  if (depHit) {
    hits.unshift({
      file: "package.json",
      line: depHit.line,
      id: depHit.id,
      what: depHit.what,
      fixName: depHit.fixName,
    });
  }

  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  for (const h of hits) {
    let fix;
    if (h.id === "runtime-deps") {
      fix = `Archtour keeps two runtime dependencies -> use a node: built-in, or ask the owner before adding ${h.fixName}`;
    } else {
      fix = FIXES[h.id];
    }
    console.log(`${h.file}:${h.line}: ${h.id}: ${h.what} -> ${fix}`);
  }

  if (hits.length > 0) {
    console.log(`check-bans: ${hits.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check-bans: ok (${files.length} files)`);
  process.exit(0);
}

main();
