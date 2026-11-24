import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI_PATH = resolve("tools/cli.mjs");
const DOCS_PATH = resolve("docs/CLI.md");

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
  return { stdout: result.stdout || "", stderr: result.stderr || "", code: result.status };
}

function getHelpOutput(command) {
  const result = runCli(["help", command]);
  if (result.code !== 0) {
    throw new Error(`help ${command} failed with code ${result.code}: ${result.stderr}`);
  }
  return result.stdout;
}

function getGlobalHelp() {
  const result = runCli(["--help"]);
  if (result.code !== 0) {
    throw new Error(`--help failed with code ${result.code}: ${result.stderr}`);
  }
  return result.stdout;
}

function parseOptionsFromHelp(helpText) {
  const options = new Set();
  const lines = helpText.split("\n");
  let inOptions = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Options:") {
      inOptions = true;
      continue;
    }
    if (inOptions && trimmed === "") break;
    if (inOptions) {
      const match = trimmed.match(/^(--[\w-]+)(?:\s+<[^>]+>)?(?:\s|,|$)/);
      if (match) {
        options.add(match[1]);
      }
      const shortMatch = trimmed.match(/^-[a-zA-Z],\s+(--[\w-]+)/);
      if (shortMatch) {
        options.add(shortMatch[1]);
      }
      const longPairMatch = trimmed.match(/^--[\w-]+,\s+(--[\w-]+)/);
      if (longPairMatch) {
        options.add(longPairMatch[1]);
      }
    }
  }
  return options;
}

function parseCommandsFromGlobalHelp(helpText) {
  const commands = [];
  const lines = helpText.split("\n");
  let inCommands = false;
  for (const line of lines) {
    if (line.trim() === "Commands:") {
      inCommands = true;
      continue;
    }
    if (inCommands && line.trim() === "") break;
    if (inCommands) {
      const match = line.match(/^\s+(\w+(?:-\w+)?)\s/);
      if (match) commands.push(match[1]);
    }
  }
  return commands;
}

function parseOptionsFromDocs(docsContent) {
  const optionsByCommand = new Map();
  const lines = docsContent.split("\n");
  let currentCommand = null;
  for (const line of lines) {
    const cmdMatch = line.match(/^##\s+(\w+(?:-\w+)?)/);
    if (cmdMatch) {
      currentCommand = cmdMatch[1];
      optionsByCommand.set(currentCommand, new Set());
      continue;
    }
    if (currentCommand && line.trim().startsWith("|")) {
      const cells = line.split("|").map(c => c.trim()).filter(c => c);
      if (cells.length >= 2 && cells[0].startsWith("`--")) {
        const optMatch = cells[0].match(/`(--[\w-]+)(?:\s|`)/);
        if (optMatch) {
          optionsByCommand.get(currentCommand).add(optMatch[1]);
        }
      }
    }
  }
  return optionsByCommand;
}

function hasForAgentsSection(docsContent) {
  return docsContent.includes("## For agents") || docsContent.includes("# For agents");
}

function getAllParserFlags() {
  const content = readFileSync(CLI_PATH, "utf8");
  const flags = new Set();
  const lines = content.split("\n");
  for (const line of lines) {
    const startsWithMatches = line.matchAll(/\.startsWith\("(--[\w-]+)"\)/g);
    for (const m of startsWithMatches) {
      flags.add(m[1]);
    }
    const eqMatches = line.matchAll(/===?\s*"(--[\w-]+)"/g);
    for (const m of eqMatches) {
      flags.add(m[1]);
    }
    const literalMatches = line.matchAll(/"(--[\w-]+)"/g);
    for (const m of literalMatches) {
      const flag = m[1];
      if (flag.length > 2 && flag !== "undefined") flags.add(flag);
    }
    const shortFlagMatches = line.matchAll(/(^|\s)(-[a-zA-Z])(?:\s|\||=|,|$|'|")/g);
    for (const m of shortFlagMatches) {
      const flag = m[2];
      if (flag.length === 2) flags.add(flag);
    }
    const shortFlagEqMatches = line.matchAll(/===?\s*"(-[a-zA-Z])"/g);
    for (const m of shortFlagEqMatches) {
      flags.add(m[1]);
    }
  }
  return flags;
}

const INTERNAL_FLAGS = new Map([
  ["-o", "short form of --out"],
  ["--now", "fixed clock for tests"],
  ["--owner-teams", "passed by action.yml"],
  ["--override-permission", "passed by action.yml"],
  ["-h", "help"],
  ["--help", "help"],
  ["-v", "version"],
  ["--version", "version"],
]);

describe("CLI feature map test", () => {
  test("every command has a ## section in docs/CLI.md and For agents section exists", () => {
    const docsContent = readFileSync(DOCS_PATH, "utf8");
    const globalHelp = getGlobalHelp();
    const commands = parseCommandsFromGlobalHelp(globalHelp);
    for (const cmd of commands) {
      assert.ok(
        docsContent.includes(`## ${cmd}`),
        `Command "${cmd}" from --help has no "## ${cmd}" section in docs/CLI.md`
      );
    }
    assert.ok(
      hasForAgentsSection(docsContent),
      'docs/CLI.md is missing a "For agents" section'
    );
  });

  test("every --option from help <command> appears in docs/CLI.md for that command", () => {
    const docsContent = readFileSync(DOCS_PATH, "utf8");
    const docsOptions = parseOptionsFromDocs(docsContent);
    const globalHelp = getGlobalHelp();
    const commands = parseCommandsFromGlobalHelp(globalHelp);
    for (const cmd of commands) {
      const helpText = getHelpOutput(cmd);
      const helpOptions = parseOptionsFromHelp(helpText);
      const docsOpts = docsOptions.get(cmd) || new Set();
      for (const opt of helpOptions) {
        assert.ok(
          docsOpts.has(opt),
          `${opt} is in "help ${cmd}" but not in docs/CLI.md under ## ${cmd} -> add it to the ${cmd} table`
        );
      }
    }
  });

  test("every --option in docs/CLI.md appears in help <command> (no stale docs)", () => {
    const docsContent = readFileSync(DOCS_PATH, "utf8");
    const docsOptions = parseOptionsFromDocs(docsContent);
    const globalHelp = getGlobalHelp();
    const commands = parseCommandsFromGlobalHelp(globalHelp);
    for (const cmd of commands) {
      const helpText = getHelpOutput(cmd);
      const helpOptions = parseOptionsFromHelp(helpText);
      const docsOpts = docsOptions.get(cmd) || new Set();
      for (const opt of docsOpts) {
        assert.ok(
          helpOptions.has(opt),
          `${opt} is in docs/CLI.md under ## ${cmd} but not in "help ${cmd}" -> remove it from the ${cmd} table or add to help`
        );
      }
    }
  });

  test("every --option string literal in tools/cli.mjs appears in at least one help <command> output (except INTERNAL_FLAGS)", () => {
    const parserFlags = getAllParserFlags();
    const globalHelp = getGlobalHelp();
    const commands = parseCommandsFromGlobalHelp(globalHelp);
    const allHelpOptions = new Set();
    for (const cmd of commands) {
      const helpText = getHelpOutput(cmd);
      const helpOptions = parseOptionsFromHelp(helpText);
      for (const opt of helpOptions) allHelpOptions.add(opt);
    }
    for (const flag of parserFlags) {
      if (INTERNAL_FLAGS.has(flag)) continue;
      assert.ok(
        allHelpOptions.has(flag),
        `${flag} is parsed in tools/cli.mjs but does not appear in any "help <command>" output -> add it to the relevant command's help or add to INTERNAL_FLAGS with a reason`
      );
    }
  });

  test("every INTERNAL_FLAGS key is really parsed by tools/cli.mjs", () => {
    const parserFlags = getAllParserFlags();
    for (const [flag, reason] of INTERNAL_FLAGS) {
      assert.ok(
        parserFlags.has(flag),
        `INTERNAL_FLAGS entry ${flag} ("${reason}") is not parsed by tools/cli.mjs -> remove it from INTERNAL_FLAGS`
      );
    }
  });

  test("no command's docs table lists the same option twice", () => {
    const docsContent = readFileSync(DOCS_PATH, "utf8");
    const docsOptions = parseOptionsFromDocs(docsContent);
    for (const [cmd, options] of docsOptions) {
      const seen = new Set();
      const lines = docsContent.split("\n");
      let currentCommand = null;
      for (const line of lines) {
        const cmdMatch = line.match(/^##\s+(\w+(?:-\w+)?)/);
        if (cmdMatch) {
          currentCommand = cmdMatch[1];
          continue;
        }
        if (currentCommand === cmd && line.trim().startsWith("|")) {
          const cells = line.split("|").map(c => c.trim()).filter(c => c);
          if (cells.length >= 2 && cells[0].startsWith("`--")) {
            const optMatch = cells[0].match(/`(--[\w-]+)(?:\s|`)/);
            if (optMatch) {
              const opt = optMatch[1];
              assert.ok(
                !seen.has(opt),
                `${cmd} table in docs/CLI.md lists ${opt} more than once`
              );
              seen.add(opt);
            }
          }
        }
      }
    }
  });
});