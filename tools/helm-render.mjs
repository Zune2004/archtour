import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;
const TIMEOUT_MS = 60000;

// A .mjs/.js helm binary is a Node script (used by tests and by hooks): run it with the current node.
function helmCommand(helmBin, args) {
  const bin = helmBin || "helm";
  if (/\.(?:mjs|js)$/i.test(bin)) {
    return { file: process.execPath, args: [bin, ...args] };
  }
  return { file: bin, args };
}

// Fresh Helm homes per call: no user plugins, repositories or post-renderers are used.
function createHelmEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-helm-home-"));
  const env = {
    ...process.env,
    HELM_CACHE_HOME: path.join(home, "cache"),
    HELM_CONFIG_HOME: path.join(home, "config"),
    HELM_DATA_HOME: path.join(home, "data")
  };
  for (const dir of [env.HELM_CACHE_HOME, env.HELM_CONFIG_HOME, env.HELM_DATA_HOME]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    env,
    cleanup: () => {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  };
}

function firstLine(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function stripChartName(source) {
  const norm = String(source || "").replace(/\\/g, "/").trim();
  const slash = norm.indexOf("/");
  return slash === -1 ? norm : norm.slice(slash + 1);
}

function cleanDocContent(lines) {
  let start = 0;
  let end = lines.length;
  const isBlankOrSeparator = (line) => /^\s*$/.test(line) || /^\s*---\s*$/.test(line);
  while (start < end && isBlankOrSeparator(lines[start])) start++;
  while (end > start && isBlankOrSeparator(lines[end - 1])) end--;
  return lines.slice(start, end).join("\n");
}

// `helm template` prints every rendered manifest after a `# Source: <chart>/templates/<file>` comment.
function splitDocuments(stdout) {
  const docs = [];
  let current = null;

  const push = () => {
    if (!current) return;
    docs.push({ source: stripChartName(current.source), content: cleanDocContent(current.lines) });
    current = null;
  };

  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^#\s*Source:\s*(.+?)\s*$/.exec(line);
    if (match) {
      push();
      current = { source: match[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  push();

  return docs;
}

/**
 * Renders a Helm chart folder with `helm template`.
 * Returns { ok: true, docs: [{ source, content }] } or { ok: false, error: "<first stderr line>" }.
 */
export async function renderChart(chartDirOnDisk, opts = {}) {
  const helmBin = opts.helmBin || "helm";
  const helmHome = createHelmEnv();
  try {
    const { file, args } = helmCommand(helmBin, ["template", "archtour", chartDirOnDisk, "--namespace", "default"]);
    let stdout;
    try {
      ({ stdout } = await execFileAsync(file, args, {
        env: helmHome.env,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }));
    } catch (err) {
      const error = firstLine(err.stderr) || firstLine(err.message) || "helm template failed";
      return { ok: false, error };
    }
    return { ok: true, docs: splitDocuments(stdout) };
  } finally {
    helmHome.cleanup();
  }
}

/**
 * True when `<helm> version --short` exits 0.
 */
export async function helmAvailable(helmBin = "helm") {
  const helmHome = createHelmEnv();
  try {
    const { file, args } = helmCommand(helmBin, ["version", "--short"]);
    await execFileAsync(file, args, {
      env: helmHome.env,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  } finally {
    helmHome.cleanup();
  }
}
