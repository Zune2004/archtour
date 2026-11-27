// Import adapter for Squawk, oasdiff and buf output files.
// Reads the machine output a team's CI already produced and turns each item
// into an Archtour finding. It never runs the tools and never writes anything.

import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_TOOLS = ["squawk", "oasdiff", "buf"];

function importError(message) {
  const err = new Error(message);
  err.exitCode = 3;
  return err;
}

function normalizeImportPath(rawPath, checkedFolder) {
  if (!rawPath || typeof rawPath !== "string") return rawPath;
  let normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (path.isAbsolute(normalized) && checkedFolder) {
    const checkedAbs = path.resolve(checkedFolder).replace(/\\/g, "/");
    const normalizedAbs = path.resolve(normalized).replace(/\\/g, "/");
    const checkedLower = checkedAbs.toLowerCase();
    const normalizedLower = normalizedAbs.toLowerCase();
    if (normalizedLower.startsWith(checkedLower + "/") || normalizedLower === checkedLower) {
      // Preserve original casing from normalizedAbs for the relative portion
      normalized = normalizedAbs.slice(checkedAbs.length + 1);
    }
  }
  return normalized;
}

export function validateImportArg(arg) {
  if (typeof arg !== "string" || arg === "") {
    throw importError('--import: expected "tool:path"');
  }
  const colonIdx = arg.indexOf(":");
  if (colonIdx <= 0) {
    throw importError(`--import ${arg}: expected "tool:path"`);
  }
  const tool = arg.slice(0, colonIdx);
  const filePath = arg.slice(colonIdx + 1);
  if (!SUPPORTED_TOOLS.includes(tool)) {
    throw importError(`--import ${arg}: unknown tool "${tool}" (supported: ${SUPPORTED_TOOLS.join(", ")})`);
  }
  if (!filePath) {
    throw importError(`--import ${arg}: missing file path`);
  }
  return { tool, filePath };
}

function readText(filePath, tool, displayPath) {
  if (!fs.existsSync(filePath)) {
    throw importError(`--import ${tool}:${displayPath}: file not found`);
  }
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // Strip UTF-8 BOM if present
    return content.replace(/^\uFEFF/, "");
  } catch {
    throw importError(`--import ${tool}:${displayPath}: cannot read file`);
  }
}

function readJsonArray(filePath, tool, displayPath, shape) {
  const content = readText(filePath, tool, displayPath);
  if (!content.trim()) {
    throw importError(`--import ${tool}:${displayPath}: not ${shape}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw importError(`--import ${tool}:${displayPath}: not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw importError(`--import ${tool}:${displayPath}: not ${shape}`);
  }
  return parsed;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSquawkViolation(item) {
  return isPlainObject(item) &&
    typeof item.rule_name === "string" && item.rule_name.trim() !== "" &&
    typeof item.file === "string" && item.file.trim() !== "" &&
    Number.isInteger(item.line) && item.line >= 0 &&
    (item.level === "Warning" || item.level === "Error");
}

function isOasdiffChange(item) {
  return isPlainObject(item) &&
    typeof item.id === "string" && item.id.trim() !== "" &&
    (item.level === 1 || item.level === 2 || item.level === 3);
}

function isBufAnnotation(item) {
  return isPlainObject(item) &&
    typeof item.type === "string" && item.type.trim() !== "" &&
    Number.isInteger(item.start_line) && item.start_line >= 1;
}

function importedFinding(ruleId, level, message, file, line, entity, eventType, kind) {
  return {
    ruleId,
    level,
    message,
    source: { file, line },
    entity,
    entityId: entity,
    event: { type: eventType, entityId: entity, kind, source: { file, line }, message },
    owners: [],
    docs: null,
    adjustable: true
  };
}

function squawkToFindings(items, displayPath, checkedFolder) {
  return items.map((item, index) => {
    if (!isSquawkViolation(item)) {
      throw importError(`--import squawk:${displayPath}: item ${index + 1} is not a Squawk violation`);
    }
    const file = normalizeImportPath(item.file, checkedFolder);
    const line = item.line + 1; // Squawk is 0-based
    const entity = `file:${file}`;
    const message = typeof item.message === "string" ? item.message : "";
    const level = item.level === "Error" ? "hard" : "soft";
    return importedFinding(
      `squawk/${item.rule_name}`,
      level,
      message,
      file,
      line,
      entity,
      "imported.squawk",
      "file"
    );
  });
}

function oasdiffToFindings(items, displayPath, checkedFolder) {
  return items.map((item, index) => {
    if (!isOasdiffChange(item)) {
      throw importError(`--import oasdiff:${displayPath}: item ${index + 1} is not an oasdiff change`);
    }
    const level = item.level === 3 ? "soft" : item.level === 2 ? "warn" : "advisory";
    const baseSource = isPlainObject(item.baseSource) ? item.baseSource : null;
    const revisionSource = isPlainObject(item.revisionSource) ? item.revisionSource : null;
    // Prefer revisionSource (the PR's file) over baseSource
    const source = revisionSource || baseSource;
    const file = source && typeof source.file === "string" && source.file ? normalizeImportPath(source.file, checkedFolder) : "unknown";
    const line = source && Number.isInteger(source.line) && source.line > 0 ? source.line : 1;
    const operation = typeof item.operation === "string" ? item.operation : "";
    const apiPath = typeof item.path === "string" ? item.path : "";
    const entity = operation && apiPath
      ? `api.route:${operation} ${apiPath}`
      : `api.route:${apiPath || operation || "unknown"}`;
    const message = typeof item.text === "string" && item.text
      ? item.text
      : (typeof item.comment === "string" && item.comment ? item.comment : item.id);
    return importedFinding(
      `oasdiff/${item.id}`,
      level,
      message,
      file,
      line,
      entity,
      "imported.oasdiff",
      "api.route"
    );
  });
}

function bufToFindings(items, displayPath, checkedFolder) {
  return items.map((item, index) => {
    if (!isBufAnnotation(item)) {
      throw importError(`--import buf:${displayPath}: annotation ${index + 1} is not a buf annotation`);
    }
    const file = normalizeImportPath(typeof item.path === "string" && item.path ? item.path : "unknown", checkedFolder);
    const line = item.start_line;
    const entity = `file:${file}`;
    const message = typeof item.message === "string" && item.message ? item.message : item.type;
    return importedFinding(
      `buf/${item.type}`,
      "soft",
      message,
      file,
      line,
      entity,
      "imported.buf",
      "file"
    );
  });
}

function readBufAnnotations(filePath, displayPath) {
  const content = readText(filePath, "buf", displayPath);
  if (!content.trim()) return []; // buf writes nothing when there are no findings
  const items = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw importError(`--import buf:${displayPath}: line ${i + 1}: not valid JSON`);
    }
    if (!isBufAnnotation(parsed)) {
      throw importError(`--import buf:${displayPath}: line ${i + 1}: not a buf annotation`);
    }
    items.push(parsed);
  }
  return items;
}

export function loadImportedFindings(importArgs, checkedFolder) {
  const allFindings = [];
  for (const arg of importArgs) {
    const { tool, filePath } = validateImportArg(arg);
    const absPath = path.resolve(filePath);

    if (tool === "squawk") {
      const items = readJsonArray(absPath, tool, filePath, "a Squawk JSON array");
      const findings = squawkToFindings(items, filePath, checkedFolder);
      for (const f of findings) allFindings.push(f);
    } else if (tool === "oasdiff") {
      const items = readJsonArray(absPath, tool, filePath, "an oasdiff JSON array");
      const findings = oasdiffToFindings(items, filePath, checkedFolder);
      for (const f of findings) allFindings.push(f);
    } else {
      const items = readBufAnnotations(absPath, filePath);
      const findings = bufToFindings(items, filePath, checkedFolder);
      for (const f of findings) allFindings.push(f);
    }
  }
  return allFindings;
}
