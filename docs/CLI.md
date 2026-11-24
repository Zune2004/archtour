# Archtour CLI Reference

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | OK |
| 1 | Hard finding (blocking) |
| 2 | Soft finding (warning) |
| 3 | Config or usage error |

## For agents

An agent needs only three commands:

1. `archtour check --changed-from <ref> . --json` — run the CI gate on the current change
2. `archtour facts <dir> --json` — extract normalized architecture facts
3. `archtour help <command>` — get options for any command

The `--json` output always includes `verdict` ("passed" | "warning" | "failed"), `exitCode` (0/1/2/3), and `findings` (array of finding objects).

---

## check

Architecture guardrails for a change (the CI gate).

| Option | What it does |
|--------|--------------|
| `--changed-from <ref>` | Compare working tree against git ref |
| `--state <dir>` | Check current state of directory |
| `--strict` | Treat soft findings as hard in --state mode |
| `--baseline <file>` | Baseline file for ratchet (default: <dir>/.archtour/baseline.json) |
| `--exceptions <file>` | Exceptions file (default: <dir>/.archtour/exceptions.yml) |
| `--max-files <n>` | Maximum candidate files to examine (default: 20000) |
| `--migration-dir <path>` | Extra folder whose .sql files are migrations (repeatable) |
| `--max-file-size <MB>` | Skip files larger than this (default: 5; Terraform plan JSON: 50) |
| `--render-helm <mode>` | Render Helm charts: auto\|on\|off (default: auto) |
| `--helm-bin <path>` | Helm binary to use (default: helm) |
| `--json` | Output machine-readable JSON |
| `--md` | Write markdown report to file (alias for --markdown) |
| `--markdown <file>` | Write markdown report to file |
| `--log-all` | Print every finding to stderr (job log), even if the report is not capped |
| `--brief` | One line per finding (`<level> <ruleId> <entity> <file>:<line>`), verdict last; cannot combine with --json |
| `--only <levels>` | Comma-separated levels to list: hard,soft,warn,advisory (counts, verdict and exit code still cover all findings) |
| `--limit <n>` | Maximum findings to show (>= 1); a `showing ...; next: --offset N` line follows while more remain |
| `--offset <n>` | Skip the first N findings (>= 0) |
| `--rules <file>` | Custom rules file |
| `--include-untracked` | Include untracked files with --changed-from |
| `--cache-dir <dir>` | Directory to cache extracted facts |
| `--override <rule>` | Override a soft finding (repeatable) |
| `--override-by <user>` | Override author |
| `--override-reason <text>` | Override reason |
| `--override-sha <sha>` | Override commit SHA |
| `--pr-author <user>` | PR author |
| `--policy-from <base\|head>` | Base or head policy to use |
| `--head-sha <sha>` | Head commit SHA |

---

## baseline

Lock in current architecture debt counts to baseline.json.

| Option | What it does |
|--------|--------------|
| `--out <file>` | Output path for baseline (default: <dir>/.archtour/baseline.json) |
| `--rules <file>` | Custom rules file |
| `--max-files <n>` | Maximum candidate files to examine (default: 20000) |
| `--migration-dir <path>` | Extra folder whose .sql files are migrations (repeatable) |
| `--max-file-size <MB>` | Skip files larger than this (default: 5; Terraform plan JSON: 50) |

---

## facts

Extract and display normalized architecture facts.

| Option | What it does |
|--------|--------------|
| `--json` | Output machine-readable JSON |
| `--max-files <n>` | Maximum candidate files to examine (default: 20000) |
| `--migration-dir <path>` | Extra folder whose .sql files are migrations (repeatable) |
| `--max-file-size <MB>` | Skip files larger than this (default: 5; Terraform plan JSON: 50) |

---

## changes

Show architecture changes and events between two directories.

| Option | What it does |
|--------|--------------|
| `--json` | Output machine-readable JSON |
| `--max-files <n>` | Maximum candidate files to examine (default: 20000) |
| `--migration-dir <path>` | Extra folder whose .sql files are migrations (repeatable) |
| `--max-file-size <MB>` | Skip files larger than this (default: 5; Terraform plan JSON: 50) |

---

## audit-history

Audit architectural violations across git commit history.

| Option | What it does |
|--------|--------------|
| `--max-commits <n>` | Maximum commits to inspect (default: 200) |
| `--since <date>` | Audit commits since date |
| `--branch <name>` | Branch to audit (default: HEAD) |
| `--repo-url <url>` | Git remote URL for link generation |
| `--md` | Write markdown report to file (alias for --markdown) |
| `--markdown <file>` | Write markdown report to file |
| `--json` | Output machine-readable JSON |

---

## scan

List the architecture sources found and write a normalized spec JSON.

| Option | What it does |
|--------|--------------|
| `--out <file>` | Output path (must end in .json) |
| `--json` | Write JSON (the default output) |
| `--ignore <path>` | Path or folder to ignore (repeatable) |
| `--include-tests` | Scan test, fixture and example directories |
| `--max-files <n>` | Maximum candidate files to examine (default: 20000) |
| `--migration-dir <path>` | Extra folder whose .sql files are migrations (repeatable) |
| `--max-file-size <MB>` | Skip files larger than this (default: 5; Terraform plan JSON: 50) |
| `--max-nodes <n>` | Split large specs at n nodes (default: 15) |
| `--max-depth <n>` | Maximum directory depth to walk (default: 12) |
| `--no-split` | Do not split large specs into multiple files |