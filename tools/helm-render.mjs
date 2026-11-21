import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

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

function helmConfigError(message) {
  const err = new Error(`Invalid Helm configuration (.archtour/helm.yml): ${message}`);
  err.exitCode = 3;
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A values path is relative to the chart folder and must stay inside it.
function isSafeChartRelativePath(p) {
  if (typeof p !== "string" || !p.trim()) return false;
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return false;
  return !norm.split("/").includes("..");
}

/**
 * Loads and validates the optional `.archtour/helm.yml` (or `.archtour/helm.yaml`) from the policy folder.
 * Returns { version: 1, charts: { "<chart dir>": { values: [...], set: {...} } } } or null when absent.
 */
export function loadHelmConfig(policyDir) {
  const archtour = path.join(policyDir, ".archtour");
  const file = [path.join(archtour, "helm.yml"), path.join(archtour, "helm.yaml")].find(f => fs.existsSync(f));
  if (!file) return null;

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"), { merge: true, logLevel: "error" });
  } catch (err) {
    throw helmConfigError(`failed to parse YAML in "${file}": ${err.message}`);
  }

  if (!isPlainObject(doc)) throw helmConfigError(`expected a mapping with "version: 1" in "${file}"`);
  for (const key of Object.keys(doc)) {
    if (key !== "version" && key !== "charts") throw helmConfigError(`unknown key "${key}" in "${file}"`);
  }
  if (doc.version !== 1) throw helmConfigError(`"version" must be 1 in "${file}"`);
  if (doc.charts != null && !isPlainObject(doc.charts)) throw helmConfigError(`"charts" must be a mapping in "${file}"`);

  const charts = {};
  for (const [chartDir, entry] of Object.entries(doc.charts || {})) {
    if (!chartDir.trim()) throw helmConfigError(`empty chart folder in "${file}"`);
    if (!isPlainObject(entry)) throw helmConfigError(`chart "${chartDir}" must be a mapping`);
    for (const key of Object.keys(entry)) {
      if (key !== "values" && key !== "set") throw helmConfigError(`unknown key "${key}" for chart "${chartDir}"`);
    }
    const values = entry.values == null ? [] : (Array.isArray(entry.values) ? entry.values : null);
    if (!values) throw helmConfigError(`"values" for chart "${chartDir}" must be a list`);
    for (const valueFile of values) {
      if (!isSafeChartRelativePath(valueFile)) {
        throw helmConfigError(`values file "${valueFile}" for chart "${chartDir}" must be relative to the chart folder and stay inside it`);
      }
    }
    const set = entry.set == null ? {} : entry.set;
    if (!isPlainObject(set)) throw helmConfigError(`"set" for chart "${chartDir}" must be a mapping`);
    for (const [key, value] of Object.entries(set)) {
      if (!key.trim()) throw helmConfigError(`empty "set" key for chart "${chartDir}"`);
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw helmConfigError(`"set" value for "${key}" in chart "${chartDir}" must be a string, number or boolean`);
      }
    }
    charts[chartDir] = { values: [...values], set: { ...set } };
  }
  return { version: 1, charts };
}

/**
 * Renders a Helm chart folder with `helm template`.
 * Returns { ok: true, docs: [{ source, content }] } or { ok: false, error: "<first stderr line>" }.
 */
export async function renderChart(chartDirOnDisk, opts = {}) {
  const helmBin = opts.helmBin || "helm";
  const helmHome = createHelmEnv();
  try {
    const args = ["template", "archtour", chartDirOnDisk, "--namespace", "default"];
    for (const valuesFile of opts.valuesFiles || []) {
      args.push("-f", valuesFile);
    }
    for (const [key, value] of Object.entries(opts.set || {})) {
      // Values files come from the base branch; `set` values are part of the same base policy.
      if (typeof value === "string") args.push("--set-string", `${key}=${value}`);
      else args.push("--set", `${key}=${value}`);
    }
    const { file, args: fileArgs } = helmCommand(helmBin, args);
    let stdout;
    try {
      ({ stdout } = await execFileAsync(file, fileArgs, {
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
