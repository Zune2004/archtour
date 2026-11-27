# Archtour Guardrails

Archtour Guardrails enforce architectural rules, security boundaries, and schema stability across codebases in CI/CD and pull requests without launching a browser or blocking developers unnecessarily.

---

**Scope.** These rules catch risky architecture changes made by mistake. They are not a security boundary against a
contributor who is deliberately evading them; keep code review and branch protection. See the README section "What it
protects against" for the known gaps.

## 1. Rules File (`.archtour/rules.yml`)

Rules are declared in `.archtour/rules.yml` at the repository root (evaluated from the base side by default in pull requests).

```yaml
version: 1
extends: [archtour:recommended, ./policies/org.yml]   # built-in pack name or relative path (no network)
rules:
  - id: no-privileged-containers        # unique identifier
    on: service.privileged_enabled      # one or a list of event types (from facts-diff)
    where: { name: "!*-dev" }           # optional: glob matchers on entity name / source file / attrs (string attrs only)
    level: hard                         # off | advisory | warn | soft | hard
    owners: ["@acme/platform"]          # team/individual responsible (used for review and soft-overrides)
    message: "Privileged containers are not allowed."
    docs: https://wiki.example/arch/privileged
    adjustable: false                   # whether repos or downstream configs may loosen this rule
```

### Schema Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | Integer | Yes | Configuration schema version (must be `1`). |
| `extends` | Array / String | No | Built-in pack names (e.g. `archtour:recommended`) or relative local file paths. No network imports (`http://`, `https://`, `git://`) are permitted. |
| `rules` | Array | No | List of rule definition / override objects. |

### Rule Object Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | String | Yes | Unique rule identifier. |
| `on` | String / Array | Yes* | Event type or list of event types emitted by `diffFacts`. (*Required for new rules; optional when overriding an extended rule). |
| `level` | String | Yes | Enforcement level: `off`, `advisory`, `warn`, `soft`, `hard`. |
| `where` | Object | No | Key-value glob matchers against entity name, source file, or string attributes. Supports `*`, `?`, `**`, and leading `!` negation. |
| `owners` | Array / String | No | Team handles or usernames (e.g. `["@acme/platform"]`). Mentions are neutralised in generated Markdown reports. |
| `message` | String | No | Human-readable explanation of why the rule fired and how to resolve it. |
| `docs` | String | No | Reference link or URL providing architectural documentation. |
| `adjustable` | Boolean | No | In packs or shared policies: whether downstream repositories may loosen the level. Defaults to `true` (`false` on sensitive hard rules). |
| `enforce_from` | String | No | ISO date (`YYYY-MM-DD`) from which full enforcement begins. Before this date, `soft` or `hard` rules report as `warn` with `(becomes <level> on <date>)`. |

---

## 2. Enforcement Levels & Merging

Archtour Guardrails support 5 enforcement levels in ascending order of severity:

$$\text{off} < \text{advisory} < \text{warn} < \text{soft} < \text{hard}$$

| Level | Purpose | Impact on PR / CI |
|---|---|---|
| `off` | Rule is disabled. | Never produces findings. |
| `advisory` | Informational change notification (e.g. new service dependency). | Reported in output; exit code `0`. |
| `warn` | Potential hazard requiring developer attention (e.g. external registry). | Reported in output; exit code `0`. |
| `soft` | Soft-mandatory guardrail (e.g. host network mode, dropped DB model). | Blocked (soft) - requires review/override; exit code `2`. |
| `hard` | Hard-mandatory guardrail (e.g. privileged container, Docker socket mount). | Blocks merge; cannot be overridden in PR; exit code `1`. |

### Merge Order & Loosening Rules

Configs are evaluated in the following order:
1. **Built-in pack** (e.g. `archtour:recommended`)
2. **`extends` in order** (e.g. `./policies/org.yml`)
3. **Repository rules** (`.archtour/rules.yml`)

When a downstream rule overrides an existing rule:
- **Tightening is always permitted**: A later rule may always increase the level to a stricter level (e.g. `warn` -> `hard`), even if `adjustable: false`.
- **Loosening requires `adjustable: true`**: A later rule may loosen the level (e.g. `hard` -> `warn`, or `soft` -> `off`) **only** if the base rule was declared with `adjustable: true`.
- **Blocked level loosening is ignored with a warning**: If `adjustable` is `false` (or not `true`), any attempt to loosen the level is ignored, the stricter level is retained, and a warning is reported.
- **Non-adjustable rules cannot be weakened via other fields**: A rule with `adjustable: false` in a base pack or `archtour:recommended` cannot be weakened or modified by downstream configs through `where`, `enforce_from`, `on`, or `owners`. Any downstream override attempting to set or change these fields on a non-adjustable rule is rejected as a configuration error (exit code 3) naming the rule and offending field.

---

## 3. Built-in Pack (`archtour:recommended`)

The built-in `archtour:recommended` pack provides day-one value across Docker Compose, Prisma ORM, OpenAPI, SQL migrations, Kubernetes manifests, GraphQL, and Protocol Buffers without requiring any initial configuration:

| Rule ID | Event Type (`on`) | Default Level | Adjustable | Description |
|---|---|---|---|---|
| `no-privileged-containers` | `service.privileged_enabled` | `hard` | `false` | Privileged containers are not allowed. |
| `no-docker-socket-mount` | `service.docker_socket_mounted` | `hard` | `false` | Mounting Docker socket (`/var/run/docker.sock`) is not allowed. |
| `no-host-network` | `service.host_network_enabled` | `soft` | `true` | Host network mode should not be used in services. |
| `no-all-interfaces-port-binding` | `service.port_published`, `compose.port_exposed` | `soft` | `true` | Publishing ports bound to all interfaces should be avoided (host IPs `127.0.0.1`, `::1`, and `localhost` are loopback and not flagged; `0.0.0.0`, `::`, or missing host IP bind to all interfaces; changing existing port from loopback to all interfaces is flagged; includes `where: { environment: "!dev" }`). |
| `no-external-registry` | `service.registry_changed` | `warn` | `true` | Container registry changed to an external or untrusted registry. |
| `service-image-changed` | `service.image_changed` | `advisory` | `true` | Container image changed. |
| `no-db-model-removed` | `db.model_removed` | `soft` | `true` | Database model was removed. |
| `db-model-renamed` | `db.model_renamed` | `advisory` | `true` | Database model was renamed. |
| `no-db-field-removed` | `db.field_removed` | `soft` | `true` | Database field was removed. |
| `db-field-renamed` | `db.field_renamed` | `advisory` | `true` | Database field was renamed. |
| `db-field-type-changed` | `db.field_type_changed` | `warn` | `true` | Database field type was changed. |
| `db-field-made-required` | `db.field_made_required` | `warn` | `true` | Database field was changed from optional to required. |
| `no-api-route-removed` | `api.route_removed` | `soft` | `true` | API route was removed. |
| `no-api-param-required-added` | `api.param_required_added` | `warn` | `true` | New required parameter added to API route. |
| `no-api-request-required-added` | `api.request_required_added` | `warn` | `true` | New required body property added to API route. |
| `no-api-security-removed` | `api.security_removed` | `hard` | `false` | Security requirement removed from existing API route. |
| `api-new-route-public` | `api.route_public` | `warn` | `true` | New API route was defined without security (public route). |
| `service-dependency-added` | `service.dependency_added` | `advisory` | `true` | New service dependency added. |
| `sql-no-drop-table` | `sql.drop_table` | `soft` | `true` | Dropping a database table is destructive and breaks running services. |
| `sql-no-drop-schema` | `sql.drop_schema` | `hard` | `false` | Dropping a database schema is destructive and breaks running services. |
| `sql-no-drop-database` | `sql.drop_database` | `hard` | `false` | Dropping a database is destructive and causes permanent data loss. |
| `sql-no-truncate` | `sql.truncate` | `soft` | `true` | Truncating a database table is destructive and deletes all rows. |
| `sql-no-delete-all` | `sql.delete_all` | `soft` | `true` | Deleting all rows from a table without a WHERE clause is destructive. |
| `sql-no-drop-column` | `sql.drop_column` | `soft` | `true` | Dropping a database column is destructive and breaks running queries. |
| `sql-type-narrowed` | `sql.type_narrowed` | `warn` | `true` | Narrowing a column type risks data truncation or migration failures. |
| `sql-not-null-without-default` | `sql.not_null_without_default` | `warn` | `true` | Adding or setting a NOT NULL column without a DEFAULT will fail on non-empty tables. |
| `sql-index-without-concurrently` | `sql.index_without_concurrently` | `warn` | `true` | Creating an index on an existing table without CONCURRENTLY locks the table against writes. |
| `sql-no-rename` | `sql.rename` | `warn` | `true` | Renaming a database table or column breaks running queries during zero-downtime deploys. |
| `sql-migrations-moved` | `sql.migrations_moved` | `soft` | `true` | Applied migration files were moved with identical content (folder move). |
| `sql-no-migration-edited` | `sql.migration_edited` | `hard` | `false` | Previously applied migration was edited, deleted, or renamed in head (migration history rewrite). |
| `no-k8s-privileged-containers` | `k8s.privileged_enabled` | `hard` | `false` | Privileged containers are not allowed in Kubernetes workloads. |
| `no-k8s-host-network-or-pid` | `k8s.host_network_enabled`, `k8s.host_pid_enabled` | `soft` | `true` | Host network and host PID should not be used in Kubernetes workloads. |
| `no-k8s-host-path-mount` | `k8s.host_path_added` | `soft` | `true` | Mounting hostPath volumes in Kubernetes containers should be avoided. |
| `no-k8s-run-as-root` | `k8s.run_as_root` | `soft` | `true` | Containers in Kubernetes should not run as root. |
| `no-k8s-privilege-escalation` | `k8s.privilege_escalation_allowed` | `warn` | `true` | Allowing privilege escalation in Kubernetes containers should be avoided. |
| `no-k8s-capability-added` | `k8s.capability_added` | `warn` | `true` | Adding Linux capabilities to Kubernetes containers should be reviewed. |
| `no-k8s-service-exposed` | `k8s.service_exposed` | `soft` | `true` | Exposing Kubernetes services via LoadBalancer or NodePort requires review. |
| `no-k8s-ingress-tls-removed` | `k8s.ingress_tls_removed` | `hard` | `false` | Removing TLS configuration from Kubernetes Ingress is not allowed. |
| `k8s-ingress-host-added` | `k8s.ingress_host_added` | `advisory` | `true` | New host added to Kubernetes Ingress. |
| `no-k8s-external-registry` | `k8s.registry_changed` | `warn` | `true` | Container registry changed in Kubernetes workload. |
| `no-k8s-limits-removed` | `k8s.limits_removed` | `warn` | `true` | Resource limits were removed from a Kubernetes container. |
| `k8s-limits-missing-new` | `k8s.limits_missing_new` | `advisory` | `true` | New Kubernetes container defined without resource limits. |
| `gql-breaking` | `gql.breaking` | `soft` | `true` | GraphQL schema breaking change detected. |
| `gql-dangerous` | `gql.dangerous` | `warn` | `true` | GraphQL schema dangerous change detected. |
| `proto-field-number-reused` | `proto.field_number_reused` | `hard` | `false` | Protobuf field number was reused. |
| `proto-field-number-changed` | `proto.field_number_changed` | `hard` | `false` | Protobuf field number was changed. |
| `proto-field-removed` | `proto.field_removed` | `soft` | `true` | Protobuf field was removed without reserving its field number. |
| `proto-field-type-changed` | `proto.field_type_changed` | `soft` | `true` | Protobuf field type was changed. |
| `proto-rpc-removed` | `proto.rpc_removed` | `soft` | `true` | gRPC RPC method was removed. |
| `proto-rpc-signature-changed` | `proto.rpc_signature_changed` | `soft` | `true` | gRPC RPC signature was changed. |
| `proto-service-removed` | `proto.service_removed` | `soft` | `true` | gRPC service was removed. |
| `proto-enum-value-removed` | `proto.enum_value_removed` | `warn` | `true` | Protobuf enum value was removed. |
| `proto-package-changed` | `proto.package_changed` | `warn` | `true` | Protobuf package was changed. |
| `proto-required-added` | `proto.required_added` | `warn` | `true` | Required protobuf field was added. |
| `tf-stateful-resource-deleted` | `tf.resource_deleted` | `hard` | `false` | Deleting a stateful resource causes permanent data loss. |
| `tf-stateful-resource-replaced` | `tf.resource_replaced` | `soft` | `true` | Replacing a stateful resource recreates it and risks data loss. |
| `tf-resource-deleted` | `tf.resource_deleted` | `warn` | `true` | Terraform resource was deleted. |
| `tf-public-ingress-added` | `tf.public_ingress_added` | `soft` | `true` | Security group or firewall rule opens public ingress (0.0.0.0/0 or ::/0). |
| `tf-bucket-public` | `tf.bucket_public` | `hard` | `false` | Storage bucket public access restrictions disabled or public ACL granted. |
| `tf-encryption-disabled` | `tf.encryption_disabled` | `soft` | `true` | Resource encryption was disabled. |
| `tf-deletion-protection-disabled` | `tf.deletion_protection_disabled` | `soft` | `true` | Deletion protection was disabled for resource. |
| `tf-iam-wildcard` | `tf.iam_wildcard` | `warn` | `true` | IAM policy allows every action, or a whole service on every resource. |
| `parse-error-head` | `parse.error_head` | `soft` | `true` | File that parsed in base failed to parse in head. |
| `parse-error-new-file` | `parse.error_new_file` | `soft` | `true` | New candidate file failed to parse. |
| `parse-error-unchanged` | `parse.error_unchanged` | `warn` | `true` | File failed to parse in both base and head. |
| `file-not-checked` | `file.not_checked` | `advisory` | `true` | Candidate architecture file was not checked. |
| `changed-file-not-checked` | `file.not_checked` | `soft` | `true` | A new or changed architecture file was not checked (Helm template, over the size cap). Lower it in the base-branch policy if you scan rendered charts elsewhere. |
| `scan-truncated` | *(no diff event; the finding is pushed directly by `check`)* | `hard` | `false` | Candidate file scan was truncated due to the `--max-files` limit. Not adjustable and not overridable; a hard failure. Fix: raise `--max-files`. |

---

## 4. CLI: `archtour check` and `archtour baseline`

```bash
# PR change check (judges changes introduced between base and head)
archtour check <baseDir> <headDir> [--max-files <n>] [--policy-from base|head] [--rules <file>] [--baseline <file>] [--exceptions <file>] [--override <ruleIds>] [--override-by <user>] [--override-reason <text>] [--owner-teams <teams>] [--json] [--md <file>]

# Fast path for git repositories (evaluates only changed files without full-tree walk)
archtour check --changed-from <git-ref> [<dir>] [--cache-dir <dir>] [--include-untracked] [--policy-from base|head] [--rules <file>] [--baseline <file>] [--exceptions <file>] [--override <ruleIds>] [--override-by <user>] [--override-reason <text>] [--owner-teams <teams>] [--json] [--md <file>]

# Current-state evaluation (evaluates all existing code for dashboards)
archtour check --state <dir> [--strict] [--max-files <n>] [--rules <file>] [--json]

# Lock in current baseline counts
archtour baseline <dir> [-o .archtour/baseline.json] [--max-files <n>]
```

1. Discovers architecture source files in `baseDir` and `headDir` (Prisma, Compose, OpenAPI, SQL, Kubernetes, GraphQL, Protobuf). In `--changed-from` mode, discovers only candidate files changed between `<git-ref>` merge-base and `HEAD`.
2. Extracts normalised architecture facts (with `--cache-dir`, hits keyed by git blob SHA skip parsing).
3. Computes the facts diff (or state events in `--state` mode).
4. Loads and merges rules from `.archtour/rules.yml` (or `--rules <file>`, falling back to `archtour:recommended`).
5. Checks baseline ratchet if `.archtour/baseline.json` exists.
6. Evaluates rules, dedupes twin findings, and applies exceptions (`.archtour/exceptions.yml`) and overrides.
7. Outputs Markdown or machine-readable JSON.

### 4.1 Fast Path for Big Repositories (`--changed-from` and `--cache-dir`)

For large repositories with tens of thousands of files:
- **Changed Files Only (`--changed-from <git-ref> [<dir>]`)**: Runs inside a git repository, listing files changed between `<git-ref>` merge-base and `HEAD` (`git diff -M --name-status -z <mergebase> HEAD`, including untracked files when `--include-untracked` is passed). Git rename detection tracks file moves: for moved candidate files (such as Compose or Kubernetes manifests), base versions are read from their old paths and evaluated under their new paths, so unchanged moved files produce no events. Applied migrations deleted or renamed in head are still detected and raised as hard findings (`sql-no-migration-edited`). Migration content is compared with CRLF normalized to LF (ignoring trailing newline differences), so line ending conversions do not trigger history rewrite findings. The base version is retrieved with `git show <mergebase>:<path>` (missing = added) and the head version from disk (missing = removed). Outside a git repository, `--changed-from` exits 3 (no fallback).
- **Cumulative Format Expansion**: When any SQL migration file in a migrations directory changes, all migration files in that directory are loaded on both base and head to replay cumulative schema state. Similarly, multi-file GraphQL SDL schemas in the same directory are unified.
- **Facts Cache (`--cache-dir <dir>`)**: Stores extracted facts per file keyed by git blob SHA (`git rev-parse <ref>:<path>` / `git hash-object`). Cache hits skip parsing completely. Cache entries are versioned JSON and invalidated when the Archtour version changes.
- **Scope and policy**: `<dir>` limits the check to files under that folder, with paths relative to it (as a full scan of that
  folder). The base policy is `<dir>/.archtour/` at `<git-ref>`, plus the files its `extends` point to inside `<dir>`; an `extends`
  outside `<dir>` cannot be loaded in this mode and stops the check with a configuration error (exit 3), never with other rules.
  A ref that does not resolve is also exit 3.
- **Known difference from a full scan**: each changed file is read on its own, so when two files define a service with the same
  name, ids are not renamed `name-2` as in a full scan. Findings are the same; exceptions written against a renamed id may not match.
- **Ratchet Cost**: Ratchet checks require evaluating full current facts across the repository to verify that violation counts have not increased. This cost is incurred only when a baseline file (`.archtour/baseline.json`) exists. When no baseline file is present, `--changed-from` stays 100% on the fast path.

### Exit Codes

| Exit Code | Meaning | Condition |
|---|---|---|
| `0` | **Passed** | Clean run, findings only at `advisory` / `warn` levels, all soft findings overridden, or `--state` without `--strict`. |
| `1` | **Hard Failure** | At least one active finding at `hard` level (cannot be overridden). |
| `2` | **Soft Warning** | No `hard` findings, but at least one active, un-overridden finding at `soft` level. |
| `3` | **Configuration Error** | Missing directories, YAML parse errors, invalid schema, network `extends`, or invalid exceptions file. |

---

### Agent output (AI/CLI consumption)

`archtour check` supports machine-friendly output modes for AI agents and scripts:

| Flag | Description |
|---|---|
| `--brief` | One line per finding: `<level> <ruleId> <entity> <file>:<line>`. No markdown. Last line is the verdict: `verdict: <passed|warning|failed> (exit <code>): <hard> hard, <soft> soft, <warn> warn, <advisory> advisory`. Cannot combine with `--json`. |
| `--only <levels>` | Comma-separated list of levels to list (`hard,soft,warn,advisory`). Filters which findings appear in the output (both `--brief` and default markdown). The verdict line and summary counts **always reflect ALL findings**, not just the filtered ones. |
| `--limit <n>` | Maximum findings to show (integer `>= 1`). Applies after `--only` filter. |
| `--offset <n>` | Skip first N findings (integer `>= 0`, default `0`). Applies after `--only` filter. |

**Pagination in `--brief`**: When `--limit` or `--offset` is used, a `showing <start>-<end> of <total>; next: --offset <next>` line is printed before the verdict line.

**JSON output with pagination**: When `--limit` or `--offset` is used, the JSON includes a `shown` field:
```json
"shown": { "offset": 0, "limit": 2, "matched": 5 }
```
The `findings` array contains the filtered/paginated results; `summary` is unchanged (all findings).

**Error cases (exit 3, one-line stderr, no stack trace)**:
- `--brief --json` combined: `--brief cannot be combined with --json`
- `--only` with invalid level: `--only takes hard, soft, warn, advisory (comma-separated)`
- `--limit` with invalid value (`< 1` or non-integer): `--limit takes a whole number >= 1`
- `--offset` with invalid value (`< 0` or non-integer): `--offset takes a whole number >= 0`

---

## 5. Flexibility & Escape Valves

Archtour Guardrails are designed to guide developers rather than create roadblocks. Five auditable escape valves provide pragmatic flexibility:

### 5.1 New-Only Judging & State Evaluation (`--state`)

- **New-Only by Default**: Normal PR checks evaluate only events introduced by diffs between `base` and `head`. Pre-existing violations in the repository never fail a pull request.
- **State Audits**: `archtour check --state <dir>` evaluates rules across all current facts as if every entity was added. Useful for dashboards and baseline generation. Exits `0` for informational reporting unless `--strict` is passed.

```bash
archtour check --state . --strict
```

### 5.2 Baseline Ratchet (`archtour baseline`)

To prevent tech debt from increasing while avoiding mass-refactor blockers on legacy codebases, Archtour supports ratcheting:

1. Run `archtour baseline <dir> [-o .archtour/baseline.json]` to record existing violation counts per rule.
2. During `archtour check`, if a baseline exists:
   - A violation count that went **UP** generates a ratchet finding at the rule's level (`ratchet: <rule> 3 -> 4`).
   - A violation count that went **DOWN** prints a celebration notice reminding developers to run `archtour baseline` to lock in the improvement.

```json
{
  "no-host-network": 2,
  "no-all-interfaces-port-binding": 5
}
```

> [!NOTE]
> **Performance Cost**: When a baseline file exists, `archtour check` evaluates current-state ratchet counts across the repository to verify that existing violation counts have not increased. This requires extracting full current facts across the repository. In repositories without a baseline file, fast-path checks (`--changed-from`) skip this full-tree walk completely and evaluate only changed candidate files.

### 5.3 Exceptions with Expiry (`.archtour/exceptions.yml`)

Exceptions declare intentional, temporary exemptions from specific rules. They must be registered in `.archtour/exceptions.yml` (typically guarded via `CODEOWNERS`):

```yaml
- rule: no-host-network
  target: "service:legacy-agent-*"
  reason: "Required for raw packet sniffing during Q1 migration"
  owner: "@platform-team"
  expires: "2026-12-31"
```

- **Required Fields**: `rule`, `target` (entity ID or glob), `reason`, `owner`, `expires` (`YYYY-MM-DD`).
- **Maximum Duration**: An exception cannot expire more than 365 days into the future.
- **Expiry Enforcement**: An expired exception stops suppressing and immediately emits an `exception-expired` finding at `warn` level.
- **Wildcard Restrictions**: An exception whose `rule` is `*` (or a glob matching more than one rule) or whose `target` is `*` is rejected (exit 3) unless it names exactly one rule and the rule is not `hard`. Hard rules (such as `no-privileged-containers`) can be excepted only per target (no `*` target).
- **Invalid Entries**: Any missing required field, bad date, excessive duration, or disallowed wildcard results in a configuration error (exit `3`) reporting the offending line number.

### 5.4 Gradual Rollout (`enforce_from`)

New architectural guardrails can be introduced in advisory/warn mode before turning into blocking gates:

```yaml
rules:
  - id: no-all-interfaces-port-binding
    enforce_from: "2027-01-01"
    level: soft
```

- Before `enforce_from`, `soft` and `hard` rules report as `warn` with `(becomes <level> on <date>)` and exit code `0`.
- On or after `enforce_from`, the rule takes effect at its full configured level.

### 5.5 Soft-Rule Overrides (`--override`)

Developers can override `soft` findings directly in CI when permitted by the rule's designated owners:

```bash
archtour check base head \
  --override no-host-network \
  --override-sha 9e6e4607b2a1c0d3e5f7a9b1c3d5e7f9a1b3c5d7 \
  --head-sha 9e6e4607b2a1c0d3e5f7a9b1c3d5e7f9a1b3c5d7 \
  --override-by alice \
  --override-permission write \
  --owner-teams @acme/platform \
  --override-reason "Emergency hotfix approved in incident #412"
```

- **Soft Rules Only**: `hard` rules (such as privileged containers) can never be overridden. Attempts to override hard rules are refused.
- **Commit Pinning (`--override-sha` & `--head-sha`)**: The override must specify the commit SHA it approves (the full SHA, equal to `--head-sha`; a shorter or different SHA is refused). Pushing a new commit changes the head SHA, automatically invalidating stale overrides (like GitHub's "dismiss stale approvals").
- **Unedited Comment Requirement**: In pull requests, override comments must be unedited (`updated_at` must equal `created_at`). Edited comments are rejected.
- **Universal Event Labeller Check**: The comment author must be the actor who added the `archtour-override` label (verified via issue events on all PR events).
- **Owner Verification & Self-Approval Prevention**: `--override-by` must match one of the rule's `owners` (or an `@org/team` matching `--owner-teams`). When `--pr-author` is set, the PR author can never override their own PR, even when listed as an owner (a PR cannot approve itself; another owner must). When a rule has empty owners (`owners: []`), an override is accepted from a user marked with write access via `--override-permission write|maintain|admin` other than the PR author (users with `read` or `triage` are refused). Rules with designated owners require an owner match. Team owners (`@org/team`) need a token with permissions to read organization team memberships (a GitHub App or fine-grained PAT with `Members: read`) passed as `github-token`; the default `GITHUB_TOKEN` cannot.
- **Routing vs Review Requests**: Findings name the owning team in the PR comment, and only owners can override; recommend `CODEOWNERS` for automated review requests.
- **Audit Logging**: Every approved override is prominently shown in Markdown reports and recorded in the JSON summary output for auditing.

---

## 6. Policy is read from the base branch

In pull request comparisons (`archtour check <baseDir> <headDir>`), the architecture gate reads its policy from the **base** branch by default (`--policy-from base`):
- Rules (`.archtour/rules.yml`) and any relative `extends` files
- Exceptions (`.archtour/exceptions.yml`)
- Ratchet baseline counts (`.archtour/baseline.json`)

### Why? A PR cannot approve itself
If policy were read from the HEAD branch of a pull request, a pull request could introduce a privileged container or remove a security requirement and simultaneously add an exception for it (or delete the rule entirely) in the same PR, bypassing the gate. Secure gates evaluate PR changes against the already-reviewed and approved policy of the base branch.

Protect `.archtour/` and `.github/workflows/` with `CODEOWNERS` or a repository ruleset, because the workflow file itself comes from the pull request merge commit.

### Flags & Escape Valves
- `--policy-from base` (default): Policy is loaded from the base directory.
- `--policy-from head`: Evaluates using policy from the HEAD branch. Intended for local development experiments and testing policy changes before opening a PR.
- **Bootstrap case**: If the base branch has no `.archtour/` directory at all (e.g. the first PR introducing Archtour into a repository), Archtour judges the PR using the built-in recommended rules (`archtour:recommended`). If HEAD adds or changes `.archtour/`, Archtour emits a `policy-changed` finding (`soft` level) indicating that a new policy takes effect after merge, and prints a notice:
  ```
  notice: base has no .archtour/, using the built-in recommended rules (a new policy applies after merge)
  ```

### Policy Changes as Findings
Any changes to policy files under `.archtour/` in a PR are evaluated:
- **Tightening is always permitted**: Pure tightening changes (e.g. only raising a rule level from `warn` -> `soft` -> `hard` with no other field changes, adding a brand-new rule, shortening exception expiries, removing exceptions, or lowering baseline counts) do not produce a policy finding.
- **Loosening generates a finding**: Any modification to an existing rule (changing owners, adding or modifying `where` matchers, adding or moving `enforce_from` later, changing `on`, changing `adjustable`, changing `extends`, or removing a rule), loosening rule levels, adding exceptions, extending exception expiries, or raising baseline counts generates a `policy-changed` finding at `soft` level. The finding names the rule and changed fields, assigning owners from the rule's base owners.
- Generated Markdown reports include a dedicated **"Policy changes in this PR (apply after merge)"** section detailing all policy modifications.

---

## 7. Importing other linters

`archtour check` and `archtour baseline` can turn the machine output of tools your CI already runs into normal Archtour findings. Pass one `--import <tool>:<path>` per file (repeatable):

```
archtour check --changed-from origin/main . \
  --import squawk:squawk.json \
  --import oasdiff:oasdiff.json \
  --import buf:buf.jsonl
```

| Tool | Accepted format | Level |
|---|---|---|
| Squawk | JSON array (`squawk --reporter json`) | `Warning` -> `soft`, `Error` -> `hard` |
| oasdiff | JSON array (`oasdiff breaking --format json`) | level 3 -> `soft`, 2 -> `warn`, 1 -> `advisory` |
| buf | JSON Lines (`buf breaking --error-format json`) | every annotation -> `soft` |

Imported rule ids are `<tool>/<id>` (`squawk/ban-drop-column`, `oasdiff/api-path-removed-without-deprecation`, `buf/FIELD_SAME_TYPE`). They support the same owners, exceptions, overrides, needs-human, baseline ratchet and Markdown report as built-in rules. The baseline ratchet also counts imported ids that `rules.yml` does not declare.

### Setting levels and owners for imported ids

Add a rule with the imported id (no `on` field is needed) or a `<tool>/*` wildcard. An explicit id wins over the wildcard. Both accept the normal `where` matchers; imported findings expose `level`, `file`, `line`, `ruleId`, `entity`, `tool` and `message`.

```yaml
version: 1
extends: [archtour:recommended]
rules:
  - id: squawk/ban-drop-column
    level: hard
    owners: ["@db-team"]
    message: "Column drops need a backfill plan"
  - id: oasdiff/*
    level: off
    where:
      level: warn
```

The second rule turns off every oasdiff WARN item (level 2) and leaves oasdiff ERR items at `soft`.

### Running the linters in CI

Run each linter in an earlier step without failing the job on findings, then pass the output to Archtour via `--import`. This keeps the single required check in Archtour while the linters do the deep analysis.

GitHub runs `shell: bash` steps with `set -e`, so a linter's non-zero exit ends the step unless the command handles it.

**Squawk** exits 1 on findings. Use `|| true`: a Squawk run that failed leaves an empty or non-JSON file, and Archtour exits 3 on it. The `git diff` needs the base branch fetched (`actions/checkout` with `fetch-depth: 0`):
```yaml
- name: Run Squawk on changed migrations
  run: |
    # Only lint migrations the PR actually changes
    CHANGED_MIGRATIONS=$(git diff --name-only origin/main...HEAD -- 'migrations/*.sql' || true)
    if [ -n "$CHANGED_MIGRATIONS" ]; then
      echo "$CHANGED_MIGRATIONS" | xargs squawk --reporter json > squawk.json || true
    else
      echo "[]" > squawk.json
    fi
  shell: bash
- name: Archtour Guardrails
  uses: Zune2004/archtour@v0
  with:
    import: |
      squawk:squawk.json
```

**oasdiff** exits 0 unless `--fail-on` is used. Run without `--fail-on`:
```yaml
- name: Run oasdiff
  run: oasdiff breaking base.yaml head.yaml --format json > oasdiff.json
- name: Archtour Guardrails
  uses: Zune2004/archtour@v0
  with:
    import: |
      oasdiff:oasdiff.json
```

**buf** exits 100 on findings and 0 with no output when there are none. A crashed buf also leaves an empty file, which would read as "no findings". Accept only exit 0 or 100:
```yaml
- name: Run buf breaking
  run: |
    RC=0
    buf breaking --against '.git#branch=main' --error-format json > buf.jsonl || RC=$?
    if [ "$RC" -ne 0 ] && [ "$RC" -ne 100 ]; then
      echo "buf failed with exit code $RC"
      exit 1
    fi
  shell: bash
- name: Archtour Guardrails
  uses: Zune2004/archtour@v0
  with:
    import: |
      buf:buf.jsonl
```

### Exception targets for imported ids

Exception targets match the finding's entity ID or the part after the first colon:
- Squawk and buf: `file:<path>` or `<path>` (e.g. `file:migrations/0002.sql` or `migrations/0002.sql`)
- oasdiff: `api.route:<METHOD> <path>` or `<METHOD> <path>` (e.g. `api.route:GET /users` or `GET /users`)

The `rule` field in an exception may be an explicit id (`squawk/ban-drop-column`) or a tool wildcard (`buf/*`). A tool wildcard needs a specific target: `target: "*"` exits 3, because rules.yml can make imported ids `hard`, and hard findings are only excepted per target.

### `where` matchers for imported findings

Imported findings expose these `where` keys: `level` (after the default mapping: Squawk Warning=`soft`, Error=`hard`; oasdiff 3=`soft`, 2=`warn`, 1=`advisory`; buf=`soft`), `file` (normalised path), `line`, `ruleId`, `entity`, `tool` (`squawk`, `oasdiff`, `buf`), and `message`.

### `enforce_from` for imported ids

`enforce_from` works identically to built-in rules. A rule with `level: hard` and `enforce_from: 2027-06-01` reports as `warn` with `(becomes hard on 2027-06-01)` before that date, and `hard` on or after.

### Built-in rules overlap

Archtour's built-in SQL rules and Squawk rules can both fire on the same change (e.g. a dropped column produces `sql-no-drop-column` and `squawk/ban-drop-column`). To avoid duplicate findings, turn one off in your rules.yml:
```yaml
rules:
  - id: squawk/ban-drop-column
    level: off
```

### Fail closed

A missing file, invalid JSON, the wrong top-level shape, or an item that does not match the documented format exits `3` with a one-line `archtour: --import <tool>:<path>: ...` error naming the file and the tool. An empty Squawk or oasdiff file is not valid (both write `[]` when there are no findings); an empty buf file is valid and means no findings. Archtour never runs the linters: run them in an earlier CI step and pass their output files.

---

## 8. Formats

Archtour Guardrails supports offline parsing, facts extraction, and structural diffs across diverse architectural and schema definition formats.

### 8.1 SQL Migrations

Archtour Guardrails inspects database migration files across PostgreSQL and MySQL DDL to track schema changes and flag dangerous operations in pull requests before deployment.

#### What is Detected
- **Table / Column Removals**: `sql.drop_table` (dropping tables) and `sql.drop_column` (dropping columns), which cause irreversible data loss and break running services.
- **Type Narrowing**: `sql.type_narrowed` (e.g. `text` -> `varchar(n)`, `bigint` -> `int`, or any change to a smaller length/precision), risking silent data truncation or migration failures.
- **Unsafe NOT NULL Constraints**: `sql.not_null_without_default` (`ADD COLUMN ... NOT NULL` without a `DEFAULT`, or `ALTER COLUMN ... SET NOT NULL`), which will fail on non-empty production tables.
- **Unsafe Index Creation**: `sql.index_without_concurrently` (creating an index on an existing PostgreSQL table without `CONCURRENTLY`), which acquires an exclusive lock and blocks application traffic.
- **Renames**: `sql.rename` (renaming tables or columns), which breaks running queries during rolling deployments.
- **History Rewrites**: `sql.migration_edited` (editing an existing migration file that was already applied in the base branch), preventing schema drift and divergent environments.

#### Supported Statements & Candidates
- **Migration Discovery**: Automatically detects `*.sql` files inside directories named `migrations/`, `migration/`, `db/migrate/`, `sql/migrations/`, `flyway/`, matching Flyway `V<n>__*.sql`, matching `prisma/migrations/*/migration.sql`, directly inside a `drizzle/` folder (Drizzle), or anywhere under `db/changelog/` (Liquibase formatted SQL). Other folders are added with `--migration-dir <path>` (repeatable or comma-separated, relative to the checked folder, case-sensitive; Action input `migration-dirs`). Down migrations (`*.down.sql`) are never judged. Migrations are ordered via natural path sorting (`V2` before `V10`).
- **DDL Coverage**: `CREATE TABLE` (columns: name, type, NOT NULL, DEFAULT, PRIMARY KEY, UNIQUE), `DROP TABLE`, `ALTER TABLE ... ADD/DROP COLUMN`, `ALTER COLUMN ... TYPE / SET DATA TYPE / SET NOT NULL / DROP NOT NULL` (PostgreSQL), `MODIFY/CHANGE COLUMN` (MySQL), `RENAME TABLE/COLUMN`, `CREATE [UNIQUE] INDEX [CONCURRENTLY]`, `DROP INDEX`, and `ADD CONSTRAINT ... [NOT VALID]`.

#### Limits & Boundaries
- **No Procedural SQL**: Stored procedures, PL/pgSQL functions, triggers, conditionals (`IF/ELSE`), and custom control flow are skipped without error.
- **No Dialect-Specific Exotic DDL**: Partitioning DDL, tablespace assignments, custom type creation (`CREATE TYPE`), and vendor-specific storage engine options are ignored safely.

<a id="kubernetes"></a>
### 8.2 Kubernetes Manifests

Archtour Guardrails supports scanning multi-document Kubernetes YAML manifests (`---`), extracting workloads, containers, services, and ingresses, and evaluating security and operational guardrails offline.

#### Detected Facts & Entities
- **`k8s.workload`**: Identifies workloads across kinds: `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob` (`jobTemplate`), and `Pod`. Attributes include `{ kind, name, namespace }` (default namespace `"default"`).
- **`k8s.container`**: Identifies containers and init-containers within workloads. Attributes include `{ workload, name, image, registry, privileged, allowPrivilegeEscalation, runAsNonRoot, runAsUser, capAdd, hostNetwork, hostPID, hostPathMounts, hasCpuLimit, hasMemoryLimit, envNames }`. Secret data is never read, and environment variable values are never captured (only names).
- **`k8s.service`**: Identifies Kubernetes services. Attributes include `{ name, namespace, type, ports }`.
- **`k8s.ingress`**: Identifies Kubernetes ingresses. Attributes include `{ name, namespace, hosts, tls }`.

#### Built-in Guardrail Rules

| Rule ID | Event Type (`on`) | Default Level | Adjustable | Description |
|---|---|---|---|---|
| `no-k8s-privileged-containers` | `k8s.privileged_enabled` | `hard` | `false` | Privileged containers are not allowed in Kubernetes workloads. |
| `no-k8s-host-network-or-pid` | `k8s.host_network_enabled`, `k8s.host_pid_enabled` | `soft` | `true` | Host network and host PID should not be used in Kubernetes workloads. |
| `no-k8s-host-path-mount` | `k8s.host_path_added` | `soft` | `true` | Mounting hostPath volumes in Kubernetes containers should be avoided. |
| `no-k8s-run-as-root` | `k8s.run_as_root` | `soft` | `true` | Containers in Kubernetes should not run as root (`runAsNonRoot: false` or `runAsUser: 0`). |
| `no-k8s-privilege-escalation` | `k8s.privilege_escalation_allowed` | `warn` | `true` | Allowing privilege escalation in Kubernetes containers should be avoided. |
| `no-k8s-capability-added` | `k8s.capability_added` | `warn` | `true` | Adding Linux capabilities to Kubernetes containers should be reviewed. |
| `no-k8s-service-exposed` | `k8s.service_exposed` | `soft` | `true` | Exposing Kubernetes services via LoadBalancer or NodePort requires review. |
| `no-k8s-ingress-tls-removed` | `k8s.ingress_tls_removed` | `hard` | `false` | Removing TLS configuration from Kubernetes Ingress is not allowed. |
| `k8s-ingress-host-added` | `k8s.ingress_host_added` | `advisory` | `true` | New host added to Kubernetes Ingress. |
| `no-k8s-external-registry` | `k8s.registry_changed` | `warn` | `true` | Container registry changed to an external or untrusted registry. |
| `no-k8s-limits-removed` | `k8s.limits_removed` | `warn` | `true` | Resource limits were removed from a Kubernetes container. |
| `k8s-limits-missing-new` | `k8s.limits_missing_new` | `advisory` | `true` | New Kubernetes container defined without resource limits. |

#### Helm Limitation & Pre-rendering
A YAML file is treated as a Helm template only if:
1. It is inside a chart's `templates/` directory (an ancestor directory within the scanned root contains `Chart.yaml`), OR
2. It fails to parse as YAML and contains `{{`.

Otherwise, YAML files containing `{{` in comments or string literals parse normally as static manifests.

When a file is skipped as a Helm template, `check` emits a finding naming the file and the reason (soft
`changed-file-not-checked` when the file is new or edited in the change, advisory `file-not-checked` otherwise; see 7.7):
`"Helm template: render with `helm template` and scan the output"`

If a file was parsed (had entities) in base and is skipped in head, it is treated like an unparsable file in head (`parse-error-head` soft finding), preventing silent bypasses or treating resources as removed.

To scan Helm charts with Archtour Guardrails:
1. Render templates to static manifests:
   ```bash
   helm template my-release ./charts/my-chart > manifests.yaml
   ```
2. Scan or check the rendered manifest directory:
   ```bash
   archtour check ./base-manifests ./manifests
   ```

#### Helm values and dependencies

Real charts usually need values and dependencies, so the chart is rendered with the same inputs it has in CI. Values
and dependencies are described in an optional policy file, `.archtour/helm.yml`, read from the same policy folder as
`rules.yml` (the base branch by default):

```yaml
version: 1
charts:
  charts/formbricks:                 # chart folder, relative to the scanned folder
    values: [ci/qa-values.yaml]      # optional, files relative to the chart folder
    set:                             # optional; strings, numbers or booleans
      formbricks.webappUrl: https://qa.example.com
```

Without an entry, a chart with `ci/*-values.yaml` (the chart-testing convention) is rendered with the first such file
in sorted order. Otherwise it is rendered with its own `values.yaml` only.

**Values files are read from the base branch** and used for both sides, so a pull request cannot choose the overrides
it is checked with (editing `ci/default-values.yaml` to set `privileged: false` does not hide a `privileged: true` it
adds to `values.yaml`). A listed file that is missing in the base branch is reported with `changed-file-not-checked`
naming the file; the chart is not rendered. A chart that is new in the pull request has no base side, so it gets the
`helm.yml` values and no `ci/` fallback.

Local dependencies (`repository: file://../common`) are copied from the same side into `charts/<name>` of the temporary
chart. Dependencies that cannot be vendored locally are left out of the temporary `Chart.yaml` (and `Chart.lock`) and
recorded with one advisory `file-not-checked` finding naming them: `vendor them in charts/ to check them`. Advisory
findings never change the exit code, so an unvendored remote dependency does not block the pull request. Archtour
never downloads anything: no `helm repo` or `helm dependency` command is run, and only the temporary chart folders are
written to.

<a id="graphql"></a>
### 8.3 GraphQL

GraphQL schema guardrails analyze GraphQL SDL documents (`*.graphql`, `*.gql`, `*.graphqls`). Several files in one directory form a unified schema concatenated in path order.

#### Facts
- `gql.type`: `{ name, kind }` representing Object, Interface, Union, Enum, Input Object, or Scalar types.
- `gql.field`: `{ type, name, returnType, args: [{ name, type, required }] }` representing type fields, return signatures, and arguments.

#### Events
- `gql.breaking`: Breaking schema changes detected via graphql-js (`findBreakingChanges`), including removed fields, removed types, or newly required arguments.
- `gql.dangerous`: Dangerous schema changes detected via graphql-js (`findDangerousChanges`), such as adding values to enums or optional arguments.
- `entity.added` / `entity.removed`: Emitted for added or removed GraphQL types.

<a id="protobuf--grpc"></a>
### 8.4 Protocol Buffers / gRPC

Protobuf guardrails inspect proto2 and proto3 definition files (`*.proto`) without external dependencies.

#### Facts
- `proto.package`: `{ name }`
- `proto.message`: `{ package, name, fullName, reservedNumbers, reservedNames }` supporting nested messages and reserved definitions.
- `proto.field`: `{ package, message, name, fullName, number, type, label, oneof }` tracking field numbers, types, labels (`required`, `optional`, `repeated`), and `oneof` groups.
- `proto.enum`: `{ package, name, fullName, values: [{ name, number }] }`
- `proto.service`: `{ package, name, fullName, rpcs: [{ name, request, response, clientStreaming, serverStreaming }] }`

#### Events
- `proto.field_number_reused`: Field number reused that was previously assigned to a different field name or listed in `reserved` (`hard`).
- `proto.field_number_changed`: Field number was changed for an existing field name (`hard`).
- `proto.field_removed`: Field was removed without reserving its field number (`soft`).
- `proto.field_type_changed`: Field type changed (`soft`).
- `proto.rpc_removed`: RPC method was removed from a service (`soft`).
- `proto.rpc_signature_changed`: RPC request, response, or streaming signature changed (`soft`).
- `proto.service_removed`: Entire gRPC service was removed (`soft`).
- `proto.enum_value_removed`: Value removed from an enum (`warn`).
- `proto.enum_number_changed`: Number changed for an enum value (`warn`).
- `proto.package_changed`: Package declaration changed (`warn`).
- `proto.required_added`: New required field added or existing field changed to required (`warn`).

### 8.5 Docker Compose, Prisma & OpenAPI

Docker Compose, Prisma ORM schemas, and OpenAPI specification documents are foundational formats parsed natively.

#### Facts
- `service`: Container services defined in Compose files, tracking image, registry, ports, volumes, host network mode, and dependencies (`service.depends_on`).
- `db.model`: Database models in `schema.prisma`.
- `db.field`: Database columns and relations in `schema.prisma`, tracking type, optionality, uniqueness, and defaults.
- `api.route`: REST API operations in OpenAPI 3.0/3.1 specs, tracking path, method, parameters, request body schemas, and security requirements.

#### Events
- `service.privileged_enabled`, `service.docker_socket_mounted`, `service.host_network_enabled`, `service.port_published`, `service.registry_changed`, `service.image_changed`, `service.dependency_added`.
- `db.model_removed`, `db.field_removed`, `db.field_type_changed`, `db.field_made_required`, `db.field_unique_added`.
- `api.route_added`, `api.route_removed`, `api.param_required_added`, `api.request_required_added`, `api.security_removed`.

<a id="terraform"></a>
### 8.6 Terraform Plans

Archtour Guardrails inspects Terraform plan JSON files to enforce infrastructure guardrails before deployment.

#### How to Produce the Plan File in CI

Archtour analyzes planned changes output by Terraform:
```bash
terraform plan -out plan.out && terraform show -json plan.out > tfplan.json
```
Archtour discovers Terraform plan files in JSON format. Because `terraform show -json` outputs `variables`, `planned_values`, and metadata before `resource_changes`, detection requires the first 4 KB of the file to contain both `"format_version"` and `"terraform_version"`, followed by a full JSON parse and schema validation (`isTerraformPlanJson` ensuring `resource_changes` is an array). Files lacking `"terraform_version"` (such as `package.json` or arbitrary application configuration) are not detected as plans.

Candidate files passing the 4 KB Terraform token check are allowed up to 50 MB (other candidate architecture files retain a 5 MB cap). Change the cap with `--max-file-size <MB>` (Action input `max-file-size`, 0-1024); Terraform plan JSON keeps 50 MB unless the value is higher. Any candidate file skipped for exceeding the size limit produces a visible `file-not-checked` finding: `soft` when the file is new (see 7.7), `advisory` when an existing file that parsed in base is now over the cap in head, and `soft` when the base version was over the cap and the head version is small enough to parse.

In CI the plan file is generated, not committed. Write it inside the checked folder before the Archtour step; the Action's changed-files mode includes untracked files, so a generated plan is checked as a new file (make sure it is not in `.gitignore`).

#### What is Checked
- **Stateful Resource Deletion & Replacement**:
  - `tf.resource_deleted` (`hard` for stateful resources, `warn` for non-stateful): Deleting stateful resources (AWS RDS instances/clusters, DynamoDB tables, S3 buckets, Google Cloud SQL, Google Cloud Storage, Azure SQL/PostgreSQL/MySQL databases, Azure Storage accounts) causes permanent data loss.
  - `tf.resource_replaced` (`soft` for stateful resources): Re-creating a stateful resource destroys existing data and requires review.
- **Public Ingress Rules** (`tf.public_ingress_added`, `soft`):
  - Security groups and firewall rules opening ingress from `0.0.0.0/0` or `::/0` (AWS `aws_security_group` ingress blocks, `aws_security_group_rule` type ingress, `aws_vpc_security_group_ingress_rule` cidr_ipv4, GCP `google_compute_firewall` source_ranges, Azure `azurerm_network_security_rule` source_address_prefix `*`, `Internet`, or `0.0.0.0/0`) where the previous configuration did not.
- **Public Bucket Access** (`tf.bucket_public`, `hard`):
  - `aws_s3_bucket_public_access_block` deleted or any of the four public access block flags set to `false`.
  - `aws_s3_bucket_acl` set to `public-read` or `public-read-write`, or Google Cloud Storage IAM (`google_storage_bucket_iam_*`) granting access to `allUsers` or `allAuthenticatedUsers`.
- **Encryption Disabled** (`tf.encryption_disabled`, `soft`):
  - `storage_encrypted` or `encrypted` explicitly `false` on create; `storage_encrypted`, `encrypted` or `kms_key_id` going from set/true to false/null on update. Values that are only "known after apply" are not treated as removed.
- **Deletion Protection Disabled** (`tf.deletion_protection_disabled`, `soft`):
  - `deletion_protection` transitioning from `true` to `false`.
- **Wildcard IAM Policies** (`tf.iam_wildcard`, `warn`):
  - AWS IAM policies (`aws_iam_policy`, `aws_iam_role_policy`, etc.) with `Effect: "Allow"` and `Action: "*"`, or a whole service (`"s3:*"`) on `Resource: "*"`. `Resource: "*"` with specific actions (`ec2:Describe*`) is common and not flagged.

#### What Cannot Be Seen
- **`prevent_destroy`**: Terraform lifecycle arguments such as `prevent_destroy` are evaluated locally by the Terraform CLI when computing plans and are not serialized into the plan JSON format.
- **Unknown-After-Apply Values**: Values that can only be determined by cloud providers during apply (e.g. dynamic IP assignments, generated resource IDs, or computed ARNs in `after_unknown`) cannot be inspected before apply.

#### Offline & Zero Credentials
Archtour never runs `terraform`, never connects to cloud APIs or networks, never reads Terraform remote state files, and never accesses cloud credentials or secret values. Sensitive attributes marked in plans are redacted to `(sensitive)` and never appear in reports.

<a id="file-not-checked"></a>
### 8.7 File Not Checked

Candidate architecture files that cannot be scanned (e.g. Helm templates or files exceeding the size cap) emit a `file-not-checked` finding naming the file and the reason. The level depends on what the skip hides:

- **New or edited file that cannot be read (Helm template, over the size cap):** blocking `soft` `changed-file-not-checked`
  (exit code 2), whether or not it sits in a Helm chart. Its rules did not run, so a privileged container in it would not be
  seen; the check never treats "could not read it" as "nothing to report". Teams that render their Helm charts and scan the
  output in another step can lower this rule in the **base branch** policy:
  ```yaml
  # .archtour/rules.yml on the base branch
  version: 1
  extends: archtour:recommended
  rules:
    - id: changed-file-not-checked
      level: advisory
  ```
- **Unchanged file that cannot be read** (full scans only): `advisory` `file-not-checked`.
- **Changed file in a folder skipped by default** (dot-folders, `build/`, `out/`, `dist/`, `target/`, `vendor/`, `test(s)/`,
  `e2e/`, `examples/`, `sample(s)/`): `advisory` `file-not-checked` naming the folder. Pass `--include-tests` (Action input
  `include-tests: true`) or point `paths` at it to check it.
- **Existing file that parsed in base and is now skipped or unparsable in head:** `advisory` `file-not-checked` plus the `soft` `parse-error-head` finding (see 7.8). Removals from that file are not reported as removed.
- **Base version skipped for size or unparsable, head version parsed:** blocking `soft` `file-not-checked` stating that the base version was not checked, so removals cannot be detected. Without it, a 6 MB base spec cut down to a handful of routes passed with no finding at all.

A skip never turns a check into a pass: every `soft` case exits 2.

A renamed file inherits its base content only from a path the check reads. Renaming an unchecked file (for example
`docker-compose.yml.dist`) to a checked name is treated as adding a new file, so everything in it is checked.

**Not checked yet:** Kubernetes manifests written as JSON, and `kind: List` files. Convert them to YAML documents or render
them before the check.

**A skip can turn a hard finding into a soft one.** If a file grows past the size limit, or an existing manifest gains a
template token (`{{ ... }}`), the rules that would have fired on it (for example a privileged container) do not run; the
change shows up as a soft `file-not-checked` or `parse-error-head` finding instead, and soft findings can be overridden.
Reviewers should read these findings as "this file was not checked", never as approval-ready: render templates or split the
file, and let the check run on the real content before overriding.

<a id="parse-errors"></a>
### 8.8 Parse Errors

When a candidate file fails to parse, Archtour isolates the error to prevent crashes:
- `parse-error-head` (`soft`): A file that parsed successfully in base failed to parse in head.
- `parse-error-new-file` (`soft`): A new candidate file added in this PR failed to parse.
- `parse-error-unchanged` (`warn`): A file that was already unparsable in base remains unparsable in head.

---

## 9. Security & Markdown Escaping

- **No Network / No Browser**: `archtour check` runs entirely offline with pure Node.js parsers.
- **Hostile Text Sanitisation**: All user text (service names, model names, routes) is passed through `mdText` escaping before Markdown generation:
  - HTML tags (`<`, `>`, `&`) are converted to entities (`&lt;`, `&gt;`, `&amp;`).
  - GitHub `@mentions` (e.g. `@everyone`, `@acme/team`) are neutralised using zero-width spaces (`@\u200B`).
  - Markdown control characters (`\`, `` ` ``, `*`, `_`, `[`, `]`, `|`, `#`, `!`, `~`) are escaped.

---

## 10. CI/CD Gate (GitHub Action)

Archtour Guardrails integrates directly into GitHub Actions via `uses: Zune2004/archtour@v0` to act as an automated architectural gate on pull requests, merge queues, and release tags.

### Supported Events & Base Resolution

| Event | Compared References | Guardrail Evaluation | Output Channels |
|---|---|---|---|
| `pull_request` | PR base SHA vs HEAD | Base policy (`--policy-from base`), PR overrides active | PR comment, step summary, annotations |
| `merge_group` | Target branch base vs queue HEAD | Re-evaluates against latest main branch | Step summary, annotations |
| `push` (tags `v*`) / `release` | Previous tag vs this tag | Release gate (`git describe --tags --abbrev=0 <tag>^`) | Step summary, annotations |
| `push` (branch) | Before SHA vs after SHA | Commit range evaluation | Step summary, annotations |

- **Safe Materialization**: The base tree is materialized into `$RUNNER_TEMP/archtour-base` via `git worktree add --detach`, never overwriting or modifying the active workspace checkout.
- **Shallow Clone Resiliency**: When run on shallow clones, the action automatically runs `git fetch --no-tags --depth=1 origin <baseSha>` to fetch missing base commits, and `git fetch --tags` before `git describe` on tag gates.

### Action Inputs

| Input | Description | Default |
|---|---|---|
| `mode` | `check` (the guardrails gate; the only mode) | `check` |
| `strict-release` | When `true`, un-overridden soft findings fail release, tag, or push runs | `false` |
| `github-token` | Token used for GitHub API checks (comments, collaborators, teams). Note: `@org/team` owners require a GitHub App or fine-grained PAT with `Members: read`. | `${{ github.token }}` |
| `comment` | Whether to post or update a PR comment | `true` |
| `needs-human-label` | Label to add when the PR needs human review (optional) | `""` |
| `import` | Newline-separated "tool:path" pairs for importing Squawk, oasdiff or buf output (e.g. `squawk:squawk.json`). Run those linters in an earlier step, before Archtour. | `""` |

### Action Outputs

| Output | Description |
|---|---|
| `needs-human` | Whether the PR needs human review (`true`/`false`) |
| `needs-human-reasons` | Semicolon-separated reasons why human review is needed |
| `verdict` | The guardrails verdict: `passed`, `warning`, or `failed` |

The PR needs a human when a file it changes is a database source (a SQL or ClickHouse migration, including
`--migration-dir` folders, or a Prisma schema), an API contract (OpenAPI, GraphQL or Protocol Buffers), a CI workflow
(`.github/workflows/`, `.github/actions/`) or anything under `.archtour/`, or when it has a blocking (hard or soft)
finding, also an overridden one. Only the files the PR changes count, not the rest of the repository; in `--state`
mode only blocking findings count. Migrations Archtour does not read (for example Rails `db/migrate/*.rb` or Django
`migrations/*.py`) and files outside the checked folder (the Action's `paths`) are not seen, so do not auto-merge on
`needs-human` alone in those repositories. In the Action, a check that did not finish (exit 3 or a crash) sets
`needs-human=true` with the reason `check did not complete (exit N)` and `verdict=error`. `needs-human` never changes
the verdict or the exit code. `--json` has it as `needsHuman: { value, reasons }`, and the markdown report has a line
under the title: `Needs a human: yes (<first reason>)` or `Needs a human: no`. Adding and removing the label needs
`pull-requests: write`.

`--brief`, `--only` and `--limit`/`--offset` list the active findings (not overridden or excepted) in report order:
grouped hard, soft, warn, advisory, in the check's own order inside each level. Without these flags the output is the
same as before.

### Required Status Check Setup with GitHub Rulesets

To enforce architecture rules as a required branch protection gate:

1. In your GitHub repository, open **Settings** > **Rules** > **Rulesets** > **New branch ruleset**.
2. Set Enforcement status to **Active** and target your default branch (e.g. `main`).
3. Under **Rules**, check **Require status checks to pass before merging**.
4. In the status checks list, add your guardrails workflow job name (e.g. `Archtour Guardrails`).
5. **Merge Queue**: When GitHub Merge Queue is enabled, GitHub automatically triggers `merge_group` runs with the same check name before merging code.

### In-PR Override Flow

When a pull request introduces an architectural change flagged at `soft` level (e.g. dropping a database model or removing an API route during a major migration):

1. **Post Override Comment**: An authorized approver (a rule owner, or a user with repository `write`, `maintain`, or `admin` permission who is not the PR author) posts a PR comment:
   ```
   /archtour override <ruleId>[,<ruleId>...] <sha> <reason>
   ```
   Example:
   ```
   /archtour override no-db-model-removed 9e6e460a1b2c3d4e5f67890123456789abcdef01 Migration to v2 customer accounts approved in RFC-88
   ```
   where `<sha>` is the full 40-character head commit SHA (`pull_request.head.sha`). A shorter SHA is refused
   (`sha_too_short`): a prefix, even 12 characters, can be matched by a commit generated offline. The comment must be unedited (`updated_at` equals `created_at`).
2. **Add Label**: The **same person** who posted the override comment adds the `archtour-override` label to the pull request. The `labeled` event starts the workflow run that applies the override (re-running an old job reuses the original event payload and does not see new labels). A PR opened before your workflow listened for `labeled` may need a push, or the label added a second time, before the first override run starts.
3. **Automated Verification**: The action checks that the PR has the `archtour-override` label, verifies that the latest labeller on the PR timeline is the comment author, validates that the commenter holds repository write permission (`write`, `maintain`, `admin`) via the GitHub API, checks `--owner-teams` membership where possible, verifies that the approved `<sha>` matches the PR's current head commit, passes `--override-permission`, `--head-sha`, and `--override-sha` to the check CLI, and passes the check. Pushing a new commit updates the head SHA and automatically invalidates the override until re-approved.
4. **Audit Trail**: The override reason, author, commit SHA, and timestamp are logged in the PR comment table and recorded in the JSON summary.
5. **Hard Rules**: Findings at `hard` level (such as privileged containers or Docker socket mounts) can never be overridden in PRs.

### Release & Tag Gate Behavior

On `release` and `push` tag events:
- There is no pull request or comment thread to override from.
- **Hard findings** always fail the workflow (exit code `1`).
- **Soft findings** are logged in the step summary and emitted as warnings by default (exit code `0`), allowing releases to proceed unless `strict-release: true` is configured.

---

## 11. Audit Your History (`archtour audit-history`)

Run guardrails across your repository's commit history to discover what architectural rules, security boundaries, or breaking schema changes would have been flagged in the past.

```bash
# Audit the last 500 commits on the current branch
archtour audit-history

# Specify a repo path, commit limit, or date range
archtour audit-history ./my-repo --max-commits 1000 --since 2026-01-01

# Link findings to your GitHub or GitLab repository
archtour audit-history --repo-url https://github.com/my-org/my-repo

# Export report as Markdown or JSON
archtour audit-history --md audit-report.md
archtour audit-history --json > audit.json
```

### Options
- `<repoDir>`: Directory of the git repository (defaults to `.`).
- `--max-commits <n>`: Maximum number of commits to scan (default: `500`).
- `--since <date>`: Only scan commits newer than the specified date.
- `--branch <ref>`: Branch or git reference to traverse (default: `HEAD`).
- `--rules <file>`: Custom rules file (defaults to `.archtour/rules.yml` or `archtour:recommended`).
- `--repo-url <url>`: Repository web URL for generating commit links (e.g. `https://github.com/owner/repo`).
- `--md <file>`: Save Markdown report to the specified file path.
- `--json`: Output findings, totals, and rule summaries as structured JSON.

### Performance & Privacy
- **Read-only**: Never modifies repository state or working tree.
- **Fast**: Skips commits without candidate architecture files without reading file blobs; caches parsed facts by blob SHA.
- **Privacy-safe**: Commit authors and email addresses are omitted from all generated reports.

---

## 12. CLI Reference (`archtour check --help`)

View all available options and flags for the guardrails check command:

```bash
archtour check --help
```

### Options
- `<base> <head>`: Compare two directory snapshots.
- `--changed-from <ref>`: Compare working tree against a git commit/branch (e.g. `origin/main`).
- `--state <dir>`: Check current state of a single directory.
- `--json`: Output findings, summaries, and overrides as structured JSON.
- `--md, --markdown <file>`: Write Markdown report to file.
- `--rules <file>`: Use custom rules YAML configuration file.
- `--include-untracked`: Include untracked files when comparing with `--changed-from`.
- `--cache-dir <dir>`: Cache extracted facts by blob SHA to accelerate repeated runs.
- `--override <rules>`: Override soft findings for specific comma-separated rule IDs.
- `--override-by <user>`: Username of the authorized approver.
- `--override-reason <msg>`: Documented rationale for the override.
- `--override-sha <sha>`: Full commit SHA the override applies to (must equal `--head-sha`).
- `--override-permission <p>`: Repository permission of the approver (`write`, `maintain`, `admin`).
- `--pr-author <user>`: Pull request author (disallowed from self-approving overrides).
- `--policy-from <base|head>`: Evaluate policy from `base` (default) or `head`.
- `--head-sha <sha>`: Head commit SHA of the pull request branch.



