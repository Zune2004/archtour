// Markdown escaping for text that goes into the PR comment and reports.

export function mdText(value, max = 200, opts = {}) {
  let isCode = false;
  let maxLen = 200;

  if (typeof max === "boolean") {
    isCode = max;
    maxLen = 200;
  } else if (typeof max === "object" && max !== null) {
    isCode = Boolean(max.code);
    maxLen = typeof max.max === "number" ? max.max : 200;
  } else {
    maxLen = typeof max === "number" ? max : 200;
    if (typeof opts === "boolean") {
      isCode = opts;
    } else if (typeof opts === "object" && opts !== null) {
      isCode = Boolean(opts.code);
      if (typeof opts.max === "number") maxLen = opts.max;
    }
  }

  let str = value == null ? "" : String(value);
  str = str.replace(/[\r\n\t]+/g, " ");

  if (str.length > maxLen) {
    str = str.slice(0, maxLen) + "…";
  }

  if (isCode) {
    const matches = str.match(/`+/g);
    let maxRun = 0;
    if (matches) {
      for (const m of matches) {
        if (m.length > maxRun) maxRun = m.length;
      }
    }
    const fenceLen = Math.max(1, maxRun + 1);
    const fence = "`".repeat(fenceLen);
    const needsSpace = str.startsWith("`") || str.endsWith("`");
    return needsSpace ? `${fence} ${str} ${fence}` : `${fence}${str}${fence}`;
  }

  // Outside code spans:
  // Neutralise @ mentions and #123 issue refs
  str = str.replace(/@(?=\w)/g, "@\u200B");
  str = str.replace(/#(?=\d)/g, "#\u200B");

  // Never emit raw HTML from user text
  str = str.replace(/&/g, "&amp;");
  str = str.replace(/</g, "&lt;");
  str = str.replace(/>/g, "&gt;");

  // Escape markdown characters: \ ` * _ [ ] | # ! ~
  str = str.replace(/\\/g, "\\\\");
  str = str.replace(/`/g, "\\`");
  str = str.replace(/\*/g, "\\*");
  str = str.replace(/_/g, "\\_");
  str = str.replace(/\[/g, "\\[");
  str = str.replace(/\]/g, "\\]");
  str = str.replace(/\|/g, "\\|");
  str = str.replace(/#/g, "\\#");
  str = str.replace(/!/g, "\\!");
  str = str.replace(/~/g, "\\~");

  return str;
}

export function mdCode(value, max = 200) {
  return mdText(value, max, { code: true });
}
