<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Zune2004/archtour/main/docs/brand/logo-dark.svg"><img src="https://raw.githubusercontent.com/Zune2004/archtour/main/docs/brand/logo.svg" alt="Archtour" width="300"></picture></p>
<p align="center"><b>The review step for changes you can't undo.</b></p>

# Archtour

[![CI](https://github.com/Zune2004/archtour/actions/workflows/ci.yml/badge.svg)](https://github.com/Zune2004/archtour/actions/workflows/ci.yml)

Archtour is **one required pull-request check for the changes you can't take back: database migrations and API contracts.**
It blocks a dropped column, an edited migration that already ran, a removed API route, a reused protobuf field number.

- **The PR cannot loosen its own rules:** the policy is read from the base branch.
- **Blocks are lifted by people, on the record:** a soft block clears only with an owner's `/archtour override`, bound to
  the PR's exact head commit; exceptions expire.
- **Existing debt is grandfathered:** a ratchet blocks increases, not what is already there.

It also checks Docker Compose, Kubernetes and Terraform plans for privileged containers, public ports and deleted databases.
Free and open source, runs offline in your CI.

## Quickstart

Run Archtour directly in your repository to check changed files against your base branch:

Needs Node.js 22.12 or newer.

```bash
npx archtour check --changed-from origin/main .
```

> [!NOTE]
> Untracked files are not checked unless `--include-untracked`; commit (or pass the flag) first.

Not on npm yet? Run it from a clone: `git clone https://github.com/Zune2004/archtour && cd archtour && npm ci`, then
`node tools/cli.mjs check --changed-from origin/main /path/to/your/repo`.

To audit past commits across your repository history, run `audit-history` as the second command:

```bash
node tools/cli.mjs audit-history . --max-commits 200
```

> [!NOTE]
> Run `audit-history` on a **full** git clone (shallow clones blame all existing debt on the oldest commit in the shallow boundary).

On a clean branch or a branch with no risky changes, Archtour prints a pass:

```markdown
## ✅ Architecture Guardrails: Passed (0 blocking, 0 overridden, 0 excepted, 0 warnings, 0 advisory)

No architecture rule violations detected.
```

What the output looks like when a breaking change is introduced (e.g. dropping a database column):

```markdown
## ⚠️ Architecture Guardrails: Blocked (soft) (1 blocking, 0 overridden, 0 excepted, 0 warnings, 0 advisory)

### ⚠️ Soft (1)
- **Dropping a database column is destructive and breaks running queries. - Column 'users.email' was dropped** (`sql-no-drop-column`)
  - Entity: `db.column:users.email`
  - File: `migrations/0002_drop_email.sql:1 (also migrations/0001_init.sql:1)`
  - Owners: none
  - Also matched: `no-db-field-removed`
  - Docs: [docs](https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended)

To override: `/archtour override sql-no-drop-column <sha> <reason>`
```

## GitHub Action

Add Archtour to your repository (`uses: Zune2004/archtour@v0`) to enforce architecture guardrails on pull requests and merge queues:

```yaml
name: Archtour Guardrails

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, edited]
  merge_group:

permissions:
  contents: read
  pull-requests: write

jobs:
  guardrails:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Zune2004/archtour@v0
        with:
          mode: check
```

`edited` re-runs the check when the PR is moved to another base branch (title and description edits re-run it too,
with the same result). Do not skip the job with an `if:`: GitHub counts a skipped required check as passed.

Optional inputs: `paths`, `ignore`, `include-tests`, `migration-dirs` (extra migration folders, comma-separated, e.g.
`db/deploy`), `max-file-size` (MB, default 5) and `render-helm` (`auto` by default; `on` fails with exit 3 when helm is
missing, `off` keeps the raw-template behaviour).

- **`hard` findings** (e.g. privileged container, removing API route security, deleting databases in Terraform): exit code `1`, blocks merge, cannot be overridden in pull requests.
- **`soft` findings** (e.g. dropped database columns, removed API routes): exit code `2`, blocks merge unless overridden by an authorized owner.
- Summarizes findings in a single updated pull request comment and GitHub workflow annotations.

## Check locally before you push

Run the same check as the Action on your branch before pushing:

```bash
npx archtour check --changed-from origin/main .
```

This compares your branch with `origin/main` and, like the Action, uses the policy committed on `origin/main` (`.archtour/` there), so a branch cannot loosen its own rules. To try a policy change you are making on your branch, add `--policy-from head`. The exit codes are the same as in the Action: `0` pass, `2` soft, `1` hard, `3` config.

### Git pre-push hook

Stop a push on hard findings (exit `1`); soft findings and warnings are printed and the push goes ahead. Put this in `.git/hooks/pre-push` and make it executable (`chmod +x .git/hooks/pre-push`):

```sh
#!/bin/sh
npx archtour check --changed-from origin/main .
[ $? -ne 1 ]
```

### VS Code task

Add a task to `.vscode/tasks.json` that runs the same command:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Archtour check",
      "type": "shell",
      "command": "npx",
      "args": [
        "archtour",
        "check",
        "--changed-from",
        "origin/main",
        "."
      ],
      "problemMatcher": []
    }
  ]
}
```

There is no editor extension; the CLI is the editor integration.

## Rules, owners, exceptions, overrides, ratchet

- **Rules (`.archtour/rules.yml`):** Define repository rules or extend `archtour:recommended` across 5 enforcement levels (`hard`, `soft`, `warn`, `advisory`, `off`).
- **Base policy enforcement:** Policy is read from the base branch (`--policy-from base`), ensuring a pull request cannot approve itself or loosen its own rules. Protect `.archtour/` and `.github/workflows/` with CODEOWNERS or a ruleset, because the workflow file itself comes from the PR.
- **Owners:** Findings name the owning team (`owners: ["@team"]`) in the PR comment, and only owners can override; recommend CODEOWNERS for review requests. Team owners (`@org/team`) need a token that can read org team membership (a GitHub App or fine-grained PAT with `Members: read`) passed as `github-token`; the default `GITHUB_TOKEN` cannot.
- **Exceptions (`.archtour/exceptions.yml`):** Auditable temporary exemptions requiring a target, reason, owner, and mandatory expiry date (capped at 365 days).
- **Overrides:** A rule's owners (or, for rules without owners, anyone with write access who is not the PR author) can unblock a soft finding by commenting `/archtour override <ruleId> <sha> <reason>`, where `<sha>` is the full SHA of the PR's current head commit (the PR comment prints the command with it). The comment must be unedited (`updated_at` equals `created_at`). The same person must add the `archtour-override` label; on every run (including subsequent pushes), the label must be present and its latest labeller must match the unedited comment's author. Pushing a new commit changes the head SHA, automatically invalidating stale overrides (like GitHub's "dismiss stale approvals"). A PR author can never override their own PR, even when listed as an owner (a PR cannot approve itself; another owner must).
- **Ratchet (`.archtour/baseline.json`):** Locks in existing technical debt counts (`archtour baseline .`); violation counts can stay flat or decrease, but increases are blocked.

See [`docs/GUARDRAILS.md`](https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md) for the complete configuration reference, rule catalog, and CLI options.

## What it checks

| Format | Blocks (exit 1 or 2) | Warns (exit 0) |
|---|---|---|
| **SQL migrations** (`.sql` in `migrations/`, `db/migrate/`, `sql/migrations/`, `flyway/`, Flyway `V1__*.sql`, Prisma `migrations/*/migration.sql`, Drizzle `drizzle/`, Liquibase `db/changelog/`; add any other folder with `--migration-dir`) | Dropped tables (`DROP TABLE`), dropped columns (`DROP COLUMN`), renaming columns, editing already-applied migrations. | Unsafe `NOT NULL` without `DEFAULT`, non-concurrent index creation on existing tables, column type narrowing, renaming tables. |
| **Prisma** (`schema.prisma`) | Removed models, removed fields. | Column type changes, changing optional fields to required, renamed models or fields. |
| **OpenAPI** (`.yaml`, `.json`) | Removed routes/methods, removed security schemes (`security: []`). | New required query or body parameters added, new public routes without security. (Note: response-field and type changes and multi-file OpenAPI `$ref`s are not checked; for deep OpenAPI checks use oasdiff.) |
| **GraphQL** (`.graphql`, `.gql`, `.graphqls`) | Breaking type and field removals, newly required arguments. | Dangerous enum value changes. |
| **Protocol Buffers** (`.proto`) | Reused field numbers, changed field numbers, removed fields without reserving, removed gRPC services or RPC methods, field type changes. | None. |
| **Docker Compose** (`compose.yaml`) | Privileged containers (`privileged: true`), Docker socket mounts (`/var/run/docker.sock`), host network mode (`network_mode: host`), public interface port bindings (`0.0.0.0`). | External or untrusted container registry, container image changes, new service dependencies. |
| **Kubernetes** (`.yaml`) | Privileged containers, running as root (`runAsUser: 0`, or no `runAsNonRoot: true`, so every new workload must set it), hostPath volume mounts, removing Ingress TLS, exposing services via LoadBalancer or NodePort. | Allowing privilege escalation, adding Linux capabilities, external registry, removing resource limits, new containers without limits. |
| **Terraform Plans** (`tfplan.json`) | Deleting stateful databases (RDS, Cloud SQL, DynamoDB), replacing stateful databases, public security group ingress (`0.0.0.0/0`), public S3 buckets, disabled encryption or deletion protection. | Deleting non-stateful resources, wildcard IAM policies. |

## Big repositories

For large monorepos and enterprise codebases:
- **Use the PR fast path (`--changed-from`):** The default Action and CLI `--changed-from <base>` inspects only files modified in the PR without walking the full tree.
- **Candidate limits (`--max-files`):** Full-tree scans (`check` and `baseline`) default to 20,000 candidate files. Scans hitting the cap fail closed: `check` emits a `hard` finding `scan-truncated` ("N candidate files were not checked; raise --max-files"), which is not adjustable and cannot be overridden; `baseline` exits 3 to prevent recording incomplete baselines. The fix is to raise `--max-files <n>`.
- **File size cap (`--max-file-size <MB>`):** files over 5 MB are not parsed (Terraform plan JSON: 50 MB). Raise it for large
  generated specs; a changed file over the cap is reported as `changed-file-not-checked`, never passed silently.
- **What is slow:** Touching very large migration folders (thousands of migration files in a single directory) requires git history inspection across that directory. Keep migration directories partitioned by service or domain where possible.
- **One approver per PR run:** Override resolution accepts the latest valid comment from the most recent user who applied the `archtour-override` label. When multiple team rules are touched, the overriding user must belong to all required owner teams, or changes should be split across PRs.

## What it protects against

Archtour catches risky changes made **by mistake**: a dropped column, an edited migration that already ran, a removed API route or field, a privileged container or a public port. It is not a security boundary against someone who is deliberately trying to get a change past it; that needs code review and branch protection as well.

Known gaps (the check does not see these changes):

- **Helm charts** are rendered with `helm template` when helm is available (it is on GitHub's Linux runners); charts whose dependencies are not vendored in `charts/` cannot be rendered and still block with `changed-file-not-checked`.
- **Compose `extends:` / `include:`:** files pulled in from elsewhere are not merged into the service that uses them.
- **OpenAPI `$ref` to other files:** routes defined in a referenced file are not followed.
- **Liquibase XML/YAML changelogs and kustomize inline patches:** not read.
- **Views created outside the migration folders** (for example in a `schema.sql`): a later `DROP TABLE` of that view
  is reported as a dropped table. (Liquibase formatted SQL under `db/changelog/` is.)
- **Migrations in a folder Archtour does not know** (for example Sqitch's `deploy/`): add it with `--migration-dir`
  (Action input `migration-dirs`), or they are not checked.

## Files it cannot read

A new or edited file that Archtour cannot read (a Helm template, a file over the size cap, a UTF-16 file) blocks the PR with a soft `changed-file-not-checked` finding: its rules did not run, so it is never reported as "nothing found". If you render Helm charts and scan the output in another step, lower that rule to `advisory` in the base branch's `.archtour/rules.yml` (see [GUARDRAILS 7.7](https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#file-not-checked)).

## How it compares

Specialist tools go deeper on one format each. Archtour is the merge gate around them: one required check across
migrations and API specs, with base-branch policy, named owners, overrides bound to the head commit, expiring exceptions
and a ratchet. Use both: the specialist linter for depth, Archtour to decide what may merge.

- **Squawk:** Deep PostgreSQL migration linter; use Squawk if you only need Postgres lock and migration safety checks. Archtour provides a unified governance layer across SQL, Prisma, and API contracts.
- **oasdiff:** Comprehensive OpenAPI breaking-change detector. Archtour catches breaking API contract changes: removed routes/methods, removed security, and new required params/body fields (as well as GraphQL breaking changes and Protobuf field/rpc changes). Response-field and type changes and multi-file OpenAPI `$ref`s are not checked: for deep OpenAPI checks use oasdiff.
- **buf:** The industry standard for Protobuf linting and breaking changes; use `buf breaking` if you only need Protobuf checks.
- **Checkov / kube-linter:** Deep infrastructure policy scanners with far more rules than Archtour; use them if you only need broad Kubernetes and cloud security scanning.
- **CODEOWNERS:** GitHub's path-based pull request review router; use CODEOWNERS if you only need file-level ownership. Archtour adds semantically typed rule-level ownership, expiring exceptions, and an automated technical debt ratchet.

## Offline and private

The `check` command runs offline with pure Node.js parsers: no browser, no network calls, and no source code, schemas or plans
uploaded anywhere. In GitHub Actions, the only network calls are to the GitHub API, to read override comments and post the PR comment, and installing its two npm dependencies.

The diagram toolkit that used to ship here is now a separate project.
