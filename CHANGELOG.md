# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- **Leftovers from the diagram toolkit:** the undocumented `diff-repo` command and the old Mermaid, DSL and visual-diff
  code are gone from the package. The CLI file is now `tools/cli.mjs`; `node tools/diagram.mjs ...` still works.

### Added
- **Helm charts are rendered** with `helm template` when helm is installed (it is on GitHub's Linux runners), so a chart
  whose templates or `values.yaml` change is checked like any other manifest (a `privileged: true` set only in
  `values.yaml` is now caught). `--render-helm auto|on|off` (default `auto`), `--helm-bin`, Action input `render-helm`.
  A chart that cannot be rendered (required values, dependencies not vendored in `charts/`) still blocks with
  `changed-file-not-checked`, and the reason now quotes helm's error.
- **Real-world charts render:** values come from an optional `.archtour/helm.yml` (`set` and `values` per chart) or the
  chart's `ci/*-values.yaml` (the chart-testing convention), and are always read from the base branch, so a PR cannot
  pick the values it is checked with. Local `file://` dependencies are copied from the repo; remote ones that are not
  vendored in `charts/` are left out (nothing is ever downloaded) with one advisory notice per chart. A change to
  `helm.yml` is reported as a policy change.

### Fixed
- **`audit-history` now gives the same result as `check`** for each past commit: it replays the migrations folder,
  multi-file Prisma schemas and GraphQL folders, and uses the policy of the commit's parent, like the gate. Before, it
  read only each commit's changed files and could report far fewer findings (one real commit: 27 vs 191). It is also
  faster (umami, 399 commits: 64 s -> 26 s). A commit that cannot be evaluated is now reported with its error instead
  of looking like "nothing found".
- **Line endings:** a commit that only changes LF to CRLF (Windows checkouts with `core.autocrlf`) no longer looks like
  a schema change.
- **ClickHouse projections:** `ADD` / `DROP` / `MATERIALIZE` / `CLEAR PROJECTION` are no longer read as a column (a
  `DROP PROJECTION` was reported as a dropped column).
- **One finding per real removal:** a Prisma model or field removed together with its `DROP TABLE` / `DROP COLUMN`
  is now reported once (the SQL finding, with the Prisma rule under "Also matched"), also when the names differ through
  `@map` / `@@map`. Before, it was reported twice, and a removed model was never merged with its `DROP TABLE`.

## [0.3.0] - 2026-11-20

### Added
- **More migration folders:** `.sql` files directly in a `drizzle/` folder (Drizzle) and under `db/changelog/` (Liquibase
  formatted SQL) are read as migrations.
- **`--migration-dir <path>`** (repeatable or comma-separated; Action input `migration-dirs`): any other folder whose `.sql`
  files are migrations, e.g. Sqitch's `deploy/`. Paths are relative to the checked folder and case-sensitive.
- **`--max-file-size <MB>`** (Action input `max-file-size`, default 5): the size cap for one file. Terraform plan JSON keeps
  its 50 MB cap unless this is higher. A value outside 0-1024 exits 3.

### Changed
- **Shorter PR comment:** changed files in folders skipped by default (tests, examples, fixtures) are listed in one collapsed
  `<details>` block instead of a 4-line entry each.
- **Clearer CLI error:** `check <base> <head>` given a file instead of a folder says `head is a file, expected a directory`
  (exit 3) instead of "does not exist".
- **README:** leads with the migration and API-contract gate; lists the migration folders it reads.
- The Action's `ignore` input now works (it was ignored before).
- The recommended workflow re-runs the check when a PR's base branch changes.

### Fixed
- **Never "Passed" without looking** (found by an independent review):
  - a `-- migrate:down` / `-- +goose Down` marker inside a Prisma, Drizzle or Liquibase migration no longer hides the
    statements after it (those tools run the whole file);
  - a UTF-16 (or binary) migration or manifest is no longer read as garbage and passed: it blocks with
    `changed-file-not-checked` ("save it as UTF-8 to have it checked");
  - Kubernetes `kind: List` files and JSON manifests are checked like any other manifest;
  - checking a subfolder (`check --changed-from main services/api`) uses the nearest `.archtour/` above it, read from
    the base branch, instead of falling back to the built-in rules.
- **Fewer false alarms on real repos** (measured with `audit-history` on 12 public TypeScript/Prisma repos, 399 commits
  each: blocking PRs 45 -> 38, all 7 removed were false alarms):
  - a `TEMP`/`TEMPORARY` table created and dropped inside one migration is not a dropped table;
  - `DROP TABLE` of a view or materialized view created in the migrations is not a dropped table;
  - removing or renaming a Prisma relation field (`posts Post[]`, `brand Brand?`) is not a removed database field, also
    when the schema is split across `prisma/schema/*.prisma` files; the scalar foreign key is still checked;
  - changing only the container side of a published port (`3180:80` -> `3180:${ALT:-80}`) is not a new public port;
  - declaring a path parameter that is already in the route (`{orgId}`) is not a new required parameter.
- **Compose ports with interpolation:** `"${PORT:-8080}:8080"` and `"0.0.0.0:${PORT:-8080}:8080"` are read as public ports;
  an unresolved host IP (`${HOST}`) counts as all interfaces; `127.0.0.1` defaults stay loopback.
- **GraphQL operation files:** client `query`/`mutation`/`fragment` files are no longer built into the schema, so adding or
  editing them no longer blocks a PR.
- **Ratchet / state mode:** loopback-only ports are no longer counted as public ports.
- **SQLite table rebuilds:** `CREATE new_x; INSERT ...; DROP TABLE x; ALTER TABLE new_x RENAME TO x` in one migration is no
  longer reported as dropping `x`; column changes of the rebuilt table are still compared.
- **CONCURRENTLY:** the PostgreSQL-only index warning is not given for MySQL/MariaDB/SQLite migrations (by path, or a Prisma
  `migration_lock.toml` provider).
- **Route parameters:** renaming a path parameter (`/users/{id}` -> `/users/{userId}`) is not a route removal. Route ids now
  use `{}` for parameters (`api.route:GET /users/{}`); exceptions or baselines that named a route id need the new form.
- **Docs:** "Check locally before you push" now says the local check uses the base branch's policy, like the Action;
  Liquibase XML/YAML changelogs listed as not read yet (Drizzle `.sql` and Liquibase formatted `.sql` under `db/changelog/` are read).

### Removed
- The diagram toolkit, sharing server and visual diff mode moved to a separate project; Archtour is guardrails-only.
- Dependencies: `graphql` and `yaml` only.

## [0.2.10] - 2026-11-18

### Fixed
- **`privileged` written other ways:** compose and Kubernetes `privileged: yes`, `on` or `y`, and compose interpolation
  `${VAR:-true}` / `${VAR-true}` count as privileged; `${VAR}` with no default is treated as privileged (fail closed).
- **SQL block comments:** a comment between tokens (`DROP/**/TABLE orders;`) no longer hides the statement.
- **Kubernetes:** `ReplicationController` workloads are checked, and resources named with `generateName` are no longer skipped.

### Changed
- **Docs:** README "What it protects against": Archtour catches risky changes made by mistake and is not a security boundary
  against deliberate evasion; known gaps listed (Helm values.yaml, compose extends/include, UTF-16, OpenAPI external $ref,
  Kubernetes JSON and kind: List).

## [0.2.9] - 2026-11-17

### Changed
- **Changed files the check cannot read are blocking (soft) by default:** a new or edited Helm template or oversized file gives
  `changed-file-not-checked` (soft), whether or not it sits in a chart. This closes the class of bypasses where a privileged
  manifest passed by looking like a template (a `Chart.yaml` above it, a template token in a value). Teams that scan rendered
  charts elsewhere can lower the rule to `advisory` in their base-branch policy.

### Fixed
- **Renames:** a renamed file inherits base content only from a path the check reads; renaming an unchecked file (for example
  `docker-compose.yml.dist`) to a checked name is checked as a new file.
- **Skipped folders:** a changed candidate file under a folder skipped by default (`tests/`, `vendor/`, dot-folders, ...) gives
  an advisory `file-not-checked` naming the folder instead of nothing.
- **Action:** the `include-tests` input now reaches the check step.
- **Docs:** Kubernetes JSON manifests and `kind: List` files are listed as not checked yet.

## [0.2.8] - 2026-11-17

### Fixed
- **Chart.yaml must be a real file:** a folder named `Chart.yaml/` or a file named `chart.yaml` (lowercase) no longer counts as a Helm chart; a Pod with `"{{ .Values.x }}"` added alongside such a folder or lowercase file now correctly gives a soft `file-not-checked` (exit 2) instead of being silently advisory.
- **Deleted GraphQL schemas:** removing a schema file (e.g. `git rm graph/schema.graphql`) now reports a `gql-breaking` finding via `--changed-from`; moving a schema with identical content to a new folder (e.g. `git mv graph/schema.graphql api/schema.graphql`) passes with no GraphQL finding; moving and editing (e.g. removing a field) correctly reports `gql-breaking`.
- **Override bound to full head SHA:** the "To override:" line now prints the full head commit SHA (was 12 hex characters); `resolveOverride` and `applyOverrides` accept only the full head SHA (case-insensitive) instead of any 12-character prefix, closing a brute-force vector.

### Changed
- **Override SHA error wording:** a short or partial SHA in a PR comment is still parsed and refused with reason `sha_too_short` (resolver) / "must be the full head commit SHA" (CLI), keeping the existing behaviour but with clearer wording.

## [0.2.7] - 2026-11-17

### Fixed
- **Renamed-away applied migrations:** renaming or moving an applied migration to a path the check does not read (`.bak`,
  `.txt`, `.down.sql`, `docs/`, or out of the scanned folder) is now treated like deleting it (hard `sql-no-migration-edited`),
  including Prisma per-folder migrations. Renames between two checked paths keep their existing handling.
- **Helm skip:** template tokens inside YAML comments, including trailing comments, no longer make a file a Helm template; and in
  `--changed-from` mode a `Chart.yaml` added by the same change does not make a new file "inside a chart" (it stays a soft
  `file-not-checked`, not advisory).

### Changed
- **Override SHA:** approvals bind at least 12 hex characters of the PR head SHA (was 7, which a commit generated offline can
  match). The PR comment prints 12; a shorter SHA is refused (`sha_too_short` in the resolver, ignored with a notice by the CLI).
- **Docs:** README "Check locally before you push": the same check as the Action from the CLI, a pre-push hook that
  stops only on hard findings, and a VS Code task. There is no editor extension; the CLI is the editor integration.
- **Docs:** GUARDRAILS 7.7 states that a size or template skip can turn a hard finding into a soft (overridable) one, and that
  such findings mean "not checked", not approval-ready.

## [0.2.6] - 2026-11-17

### Fixed
- **Override argv bypass (security blocker):** `check` now treats a run as a help request only when `--help`/`-h` is a flag in an option position, the subcommand is `help`, or the first argument after the subcommand is `help`. An option value is never a help request, so `--override help` and `--override-reason -h` run the check instead of printing usage and exiting 0. The Action passes override values as `--flag=value`, and fails the step with exit 3 when `check-result.json` is not valid JSON, printing the first lines of what the CLI wrote.
- **Override resolver validation:** `resolveOverride` rejects rule ids that are not in the loaded policy (inactive, reason `unknown_rule_id: ...`) and rejects an override whose approver is the PR author (reason `pr_author_cannot_override`), even when the label, the comment, the commit SHA and write permission all line up.
- **Prisma per-folder migrations on `--changed-from`:** For `prisma/migrations/<timestamp>_<name>/migration.sql`, the PR path now replays every sibling `*/migration.sql` under the `migrations` folder (folder-name order), so non-concurrent indexes and column type narrowing are reported the same way as with a flat migrations folder.
- **New Helm-skipped manifests (fail-open):** A file that is NEW in the change and skipped as a Helm template with no `Chart.yaml` in any ancestor folder now gives a soft `file-not-checked` (exit 2) instead of an advisory. Files inside a real chart stay advisory. Skipped files are also carried through `--changed-from` facts, where they were previously dropped.
- **Oversized or unparsable base version:** When the base version of a candidate file was skipped for size (or could not be parsed) and the head version parsed, `check` emits a soft `file-not-checked` saying the base version was not checked, so removals cannot be detected. A 6 MB OpenAPI base cut to 2,000 routes no longer passes silently.

### Changed
- The 20-per-rule cap in the PR comment now applies to warn and advisory groups as well as soft, matching the 0.2.5 CHANGELOG claim. Hard findings remain uncapped.
- `docs/GUARDRAILS.md` 7.6/7.7 now describe what the code does for oversized base, new and existing files.

## [0.2.5] - 2026-11-17

### Fixed
- **Newline-path bypass (blocker, Linux):** `git cat-file --batch` reader now sends only paths without `\n`/`\r` through the batch; paths containing them are read with the per-file fallback (`git show <ref>:<path>` with the path as one argv element). Queries are de-duplicated, and the batch reader rejects any stream that does not carry exactly one answer per requested object. `batchCatFile` rejects when a query has no entry, and `check` turns that rejection into a clear `archtour:` error with exit 3 (the same path as other git errors) instead of carrying on. A PR where one changed file name contains a newline no longer bypasses hard rules; a misaligned batch can no longer make an edited migration look new.
- **`.graphqls` in `--changed-from` mode (blocker):** `isGraphQLFile` now accepts `*.graphqls` in any folder, making candidate detection identical in both `--changed-from` and two-directory modes for `.graphql`, `.gql` and `.graphqls` files.
- **Full findings in the job log (blocker):** When the markdown report is capped (20 per rule, or the 60,000-char cut) or `--log-all` is given, every finding is printed to **stderr** as a plain line (`<level> <ruleId> <entity> <file:line> <message>`). stderr is what the GitHub Action shows in the job log (it redirects stdout to `check-result.json`), so "see the job log" is now accurate in both `--json` and markdown modes; stdout stays valid JSON. Capping is detected from the report itself (`(see the job log`), not from a size heuristic. Hard findings are never capped in the comment; the 20-per-rule cap applies only to soft/warn/advisory findings.
- **Team owners with `paths:` policies (regression):** The override resolver now looks for `.archtour/rules.yml` under each `paths:` input in addition to the workspace root, so owners declared in a policy that applies to a `paths:` slice resolve the same way as root-level owners.
- **`scan-truncated` is now hard and non-overridable:** The `scan-truncated` finding is now `level: hard` with `adjustable: false`, matching the behavior of other hard rules. The fix for truncated scans is to raise `--max-files`.

### Changed
- Added `--log-all` to `archtour check` (and to `check --help`): every finding is printed to stderr as a plain line even when the report is not capped.
- `scan-truncated` documentation is now consistent: README, `docs/GUARDRAILS.md` and the recommended pack all describe it as `hard`, not adjustable, not overridable, fixed by raising `--max-files`. `GUARDRAILS.md` also states that `check` pushes this finding directly (there is no `scan.truncated` diff event).

## [0.2.4] - 2026-11-16

### Added
- **Fail-Closed Truncation (Blocker):** Discovery candidate cap (previously 500) replaced by configurable `--max-files <n>` defaulting to 20,000 candidate files across `check` and `baseline`. Scans reaching the cap fail closed: `check` adds a soft finding `scan-truncated` ("N candidate files were not checked; raise --max-files") and logs a notice to stderr; `baseline` exits 3 to prevent recording invalid baselines over partial scans; reports never render "Passed" when truncated.
- **CLI Subcommand Help Safety (Blocker):** `--help` / `-h` across all subcommands (`check`, `baseline`, `facts`, `changes`, `audit-history`, `selftest`, `doctor`, `init`) prints usage and immediately exits 0 without creating files or running side effects in the current directory.
- **Batched Git Reads (Scale):** In `getChangedFacts` and `expandDirectoryCandidates`, batched base file versions using a single streaming `git cat-file --batch` process instead of sequential per-file `git show` calls.
- **Flyway Repeatable Migrations:** Editing Flyway repeatable migrations (`R__*.sql`) is permitted without triggering `sql-no-migration-edited` (Flyway re-runs them by design), while statements within them are evaluated as new statements. Versioned migrations (`V*__`) remain strictly protected against deletion or modification.
- **Mass Folder Moves:** Moving applied migration files with identical content across directories emits a single soft `sql-migrations-moved` finding per folder ("N migrations moved from A to B") rather than hard per-file history-rewrite findings.
- **PR Comment Size Cap:** `formatMarkdownReport` guarantees reports stay under GitHub's 60,000 character limit, capping findings per rule at 20 with `- ... and N more <ruleId> findings (see the job log)`.
- **Targeted Team Membership Queries (Scale):** `getUserTeams` checks team membership per named team (`GET /orgs/{org}/teams/{team_slug}/memberships/{username}`) for the specific rules being overridden instead of querying all organization teams, with strict `api.github.com` URL validation.

## [0.2.3] - 2026-11-16

### Added
- **Override Commit Pinning (Blocker 1):** Overrides must name the PR head commit SHA (`/archtour override <ruleId> <sha> <reason>`) with at least 7 hex characters; pushing a new commit changes the head SHA and automatically invalidates the override.
- **Universal Event Labeller Check:** Overrides on all event types (including `synchronize` and `reopened`) verify via GitHub issue events pagination that the comment author matches the actor who added the `archtour-override` label.
- **GraphQL Extension Expansion:** Added `.graphqls` support across file discovery and facts extraction.
- **CLI Check Help:** Added `archtour check --help` (also `-h` and `help`) listing all check flags and options, exiting 0.
- **Honest Zero-Candidate-Files Title:** When no candidate architecture files are examined, reports render `## ℹ️ Architecture Guardrails: No architecture files changed` with exit 0 instead of "Passed".

### Fixed
- **Unedited Comment Requirement:** Overrides are rejected if the comment has been edited (`updated_at !== created_at`).
- **Code-Span Markdown Escaping (Blocker 3):** File paths, entity IDs, and rule IDs within backtick code spans are no longer backslash-escaped for `_` and `*`, preventing literal backslash artifacts in PR comments and reports.
- **Honest README Checks Table (Blocker 2):** Split the README checks table into distinct "Blocks (exit 1 or 2)" and "Warns (exit 0)" columns based on actual enforcement levels in `archtour:recommended`.
- **Goose and Sql-Migrate Down Sections:** `-- +goose Down` and `-- +migrate Down` sections are stripped when a matching Up section is present in non-Flyway files.
- **Flyway Undo Migrations:** Flyway undo migration files (`U<version>__*.sql`) are ignored as down migrations.
- **Exit 2 Title Clarity:** Soft violation title updated from "Soft Warning" to `## ⚠️ Architecture Guardrails: Blocked (soft)`.

## [0.2.2] - 2026-11-16

### Added
- **CI Pack & Install Test:** Added `pack-install` job on ubuntu-latest and macos-latest verifying tarball installation, CLI binary execution, and ensuring no puppeteer Chrome cache is created.
- **Prisma `@map` and `@@map` Renames:** Field renames mapped via `@map("<old column>")` and model renames mapped via `@@map("<old table>")` are reported as advisory rename events (`db.field_renamed`, `db.model_renamed`) instead of removals.

### Fixed
- **CLI Executable Symlink (B1):** Fixed bin entry point execution when invoked through POSIX symlinks (e.g. `node_modules/.bin/archtour` on Linux/macOS).
- **Puppeteer Chrome Download (B2):** Switched from puppeteer to puppeteer-core to avoid 728 MB Chromium downloads on npm 10/11.
- **Action Facts Cache (B3):** Facts cache is disabled on pull requests and merge queues to prevent untrusted cache poisoning.
- **Package Metadata Links:** Added repository, homepage, and bugs fields to package.json, and absolute documentation and image URLs for npm package view.
- **Oversize New Files (N1/B4):** Any new candidate architecture file skipped for exceeding the size limit emits a blocking `soft` `file-not-checked` finding instead of advisory.
- **Non-Adjustable Rule Overrides (N6):** Downstream rule overrides attempting to weaken rules with `adjustable: false` via `where`, `enforce_from`, `on`, or `owners` are rejected with a configuration error (exit 3).
- **Wildcard Exceptions Rejection (N7):** Exceptions with `rule: "*"` (or globs matching multiple rules) or `target: "*"` on hard rules are rejected with exit code 3.
- **GitHub Teams Pagination:** `getUserTeams` follows `Link: rel="next"` headers up to 30 pages to discover team memberships across large organizations.
- **Documentation & Claims:** Clarified API change detection boundaries (recommending oasdiff for deep OpenAPI diffs), documented untracked file handling in quickstart, corrected `--changed-from` git requirement (exit 3 outside git), aligned quickstart sample output with CLI markdown format, and updated override workflow documentation to emphasize same-person labeling on `labeled` trigger.

## [0.2.1] - 2026-11-16

### Fixed
- **PR base after the base branch moves:** `actions/checkout` tests the PR merged into the *current* base branch, while
  `pull_request.base.sha` can be older. The Action now uses the test merge's first parent as the base, so a PR is no longer
  blamed for changes merged into the base branch after it was opened (found by running the README workflow verbatim).

## [0.2.0] - 2026-11-16

### Added
- **Base Policy Enforcement (`--policy-from base`):** Policy configuration (`.archtour/rules.yml`, `.archtour/exceptions.yml`, `.archtour/baseline.json`) is loaded from the base branch so pull requests cannot loosen rules or approve themselves. Policy modifications in a PR are reported as `policy-changed` findings.
- **Database Migrations & SQL DDL Inspection:** Replays DDL statements across PostgreSQL and MySQL migrations to block destructive operations: dropped tables (`sql.drop_table`), dropped columns (`sql.drop_column`), type narrowing (`sql.type_narrowed`), unsafe `NOT NULL` constraints without `DEFAULT` (`sql.not_null_without_default`), non-concurrent index creation on existing tables (`sql.index_without_concurrently`), table/column renames (`sql.rename`), and editing previously applied migration files (`sql.migration_edited`).
- **Kubernetes Manifests Guardrails:** Multi-document manifest inspection for workloads, containers, services, and ingresses, enforcing policies against privileged containers, hostNetwork/hostPID, hostPath mounts, running as root, privilege escalation, removed Ingress TLS, and public service exposure.
- **GraphQL & Protocol Buffers / gRPC:** Schema diffing catching breaking GraphQL changes (`gql.breaking` via `graphql-js`), dangerous changes, Protobuf field number reuse, field number modification, unreserved field removal, and removed gRPC services/methods.
- **Terraform Plan Inspection:** Pre-deployment analysis of `terraform show -json` plan files (`tfplan.json`) catching dropped or replaced stateful databases (RDS, Cloud SQL, DynamoDB, S3), public security group ingress (`0.0.0.0/0`), public S3 buckets, and disabled encryption or deletion protection.
- **Architecture Debt Ratchet (`archtour baseline`):** Lock in baseline violation counts across repositories; debt increases are blocked, while reductions trigger celebrations to ratchet down tech debt.
- **Expiring Exceptions (`.archtour/exceptions.yml`):** Time-bound, auditable exceptions with mandatory owner, target, reason, and expiration date (max 365 days). Expired exceptions automatically flag as warnings.
- **Owner Overrides & In-PR Workflow:** `/archtour override <rule> <reason>` commands in PR comments allow authorized owners to override soft findings directly in CI when paired with the `archtour-override` label.
- **Repository History Audit (`archtour audit-history`):** Fast, read-only inspection of git commit history to discover historical architectural violations.
- **Fast Path & Content Caching:** Fast git candidate discovery (`--changed-from <ref>`) and blob SHA caching (`--cache-dir`) avoiding full-tree walks on large codebases.

### Fixed
- **Policy Loosening Detection (Review 2 F1):** Any modification to an existing rule (owner changes, `where` filter added/changed, `enforce_from` added/delayed, `on` changes, `adjustable` changes, `extends` changes, or rule removals) produces a `policy-changed` finding attributing BASE owners; only pure tightening (raising level with no other changes) passes without a finding.
- **Owner Self-Approval Prevention (Review 2):** When `--pr-author` is set, PR authors can never self-approve or override findings on their own pull requests even if listed as a rule owner.
- **GitHub Action Fail-Open Protection (Review 2 F4/F5):** Action check step now fails on any non-0/1/2/3 exit code with `::error::Archtour check crashed (exit code N)`; execution mode is validated upfront, failing with exit code 3 on invalid inputs.
- **GitHub Action PR Comment Pagination (Review 2 F8):** Comment resolution now follows `Link: rel="next"` headers up to 30 pages to support high-activity PRs.
- **Down Migrations & Temp Tables (Review 2 FP1/FP2/FP3):** Golang-migrate `*.down.sql` files and dbmate `-- migrate:down` sections are ignored; temporary tables created and dropped within the same migration do not emit drop findings.
- **Large Candidate Files (Review 2 F3):** New SQL migration files exceeding the file size cap emit a blocking `soft` `file-not-checked` finding instead of passing as advisory.
- **Documentation & Claims (Review 2):** Fixed broken documentation anchors (`#kubernetes`, `#graphql`, `#protobuf--grpc`, `#file-not-checked`, `#parse-errors`), corrected Action default mode to `check`, clarified team owner token requirements (`Members: read`), and documented workflow file protection recommendations.
- **Review 1 Fixes:** Addressed bootstrap policy bypass, Helm template skipping, Terraform large plan headers, empty CLI arguments, migration rename/delete tracking, port binding evaluation, and public API route severity.

## [0.1.0] - 2026-11-14

### Added
- Interactive single-file explorer, 7 styles, nested diagrams, tour, presenter mode, Mermaid and text input, deep links, embeds.
- `archtour scan`: map a whole repo (overview + drill-ins + tour, `--ignore`).
- Code-sync: real schema detail (Prisma fields/keys/relations, Compose `depends_on` all forms, env names only, OpenAPI routes), field-level diffs, clean PR markdown.
- Brand kit: commit `.archtour-brand.json` and every render (interactive, scan, from-code, diff, diff-repo) uses its canvas, ink, primary colour, font and logo (`--no-brand` to skip); `brand init --from` imports CSS custom properties or W3C design tokens; `brand audit --ci` and the Action's `brand-check` input fail CI on contrast or colour violations.
- GitHub Action (`uses: Zune2004/archtour@v0`): architecture diff of every PR as one updated comment plus a downloadable visual diff; fork-safe.
- Big schemas split into readable groups (`--no-split`, `--max-nodes`); OpenAPI and Compose from YAML or JSON.
- Archtour server (beta, `server/v2`): GitHub login, workspaces, members and explicit invites, CI tokens, `archtour push` from CI, build history, signed sandboxed content (optionally on a separate content origin), Docker image, backup/restore, optional Stripe billing (off without keys).

### Changed
- Renamed to Archtour; installable package (`npx archtour`), still depended on puppeteer (which downloads Chrome on npm 10/11).
- Focus on the diagrams core + code-sync; `publish` has no built-in endpoint.

### Security
- Sharing server hardened (ids, password unlock via cookie, embed check, private catalogue, escaping, limits, CSP, localhost bind).
- Server beta: fixes from an independent security review (role escalation through invites, owner removal by admins, plan-limit bypass, invite-only bypass, spoofable rate limits, secret key checks, uniform 404s, `no-store`, `__Host-` cookies, dev-login bind check, Stripe event checks, storage caps).
- The Action only updates its own PR comment.

### Experimental
- `ai`, `publish`, and `video` marked experimental.
