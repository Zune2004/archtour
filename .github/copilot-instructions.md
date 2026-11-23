# Archtour

Archtour is an architecture guardrails CLI and GitHub Action.
Node ESM, no build.

Entry point:
- CLI entry: `tools/cli.mjs`
- Commands: `check`, `baseline`, `audit-history`, `facts`, `changes`, `scan`

Structure:
- `tools/`: CLI and guardrails implementation
- Recommended rules: `tools/rules-recommended.mjs`
- `tests/`: test suite run with `npm test`
- Documentation: `docs/GUARDRAILS.md`
