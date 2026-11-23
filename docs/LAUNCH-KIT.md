# Archtour – Launch & Go-To-Market Kit

This kit contains all promotional copy, launch posts, and developer outreach collateral for taking **Archtour** to market across Hacker News, Product Hunt, GitHub, and developer communities.

---

## 1. Show HN (Hacker News) Submission

### Title
> **Show HN: Archtour – The review step for changes you can't undo (CI guardrails for DB & API contracts)**

### Post Body
```markdown
Hey HN,

Breaking changes in production often stem from pull requests touching things you can't easily undo: dropped database columns, removed API routes, edited migrations, or accidentally privileged containers. Standard linters catch syntax, but contract breaks slip through review.

I built **Archtour**: **The review step for changes you can't undo.**
Description: Blocks risky pull requests: dropped columns, breaking API changes, privileged containers, public ports, deleted databases. Open source, runs in your CI.

- GitHub: https://github.com/Zune2004/archtour
- npm: `npx archtour check --changed-from origin/main .` (https://www.npmjs.com/package/archtour)

### 3 Concrete Blocked Changes:
1. **SQL Migrations & Prisma:** Blocks `DROP COLUMN` or `DROP TABLE` without migration review, unsafe `NOT NULL` without `DEFAULT` on populated tables, and index creation on PostgreSQL without `CONCURRENTLY` (which locks writes). Also flags hard failures if an already-applied migration file was edited in the PR.
2. **API Contracts (OpenAPI, GraphQL, Protobuf):** Blocks deleted REST routes, removed OpenAPI security schemes (`security: []`), new required body parameters, breaking GraphQL type/field removals, and Protobuf field number reuse or unreserved removals.
3. **Containers & Infrastructure:** Blocks privileged containers (`privileged: true`), `/var/run/docker.sock` mounts, Kubernetes root execution (`runAsUser: 0`), and Terraform plans dropping stateful databases (RDS, Cloud SQL, DynamoDB) or opening `0.0.0.0/0` security group ingress.

### Why not just use existing single-purpose tools?
Single-purpose linters exist (Squawk for Postgres, oasdiff for OpenAPI, buf for Protobuf). But polyglot teams end up stitching together disjointed GitHub Actions and fragile CODEOWNERS rules. Archtour provides:
- **One required status check** and one clean PR comment summary across formats.
- **Base-branch policy enforcement (`--policy-from base`):** A PR cannot approve itself or weaken its own rules.
- **Auditable ownership & escape valves:** Rule-level owners (`owners: ["@team"]`), temporary expiring exceptions (`.archtour/exceptions.yml`, max 365 days), PR comments for owner overrides (`/archtour override <ruleId> <reason>`), and a technical debt ratchet (`.archtour/baseline.json`).

### Under the hood:
- Pure Node.js offline execution. No remote cloud calls, no external analytics, no tokens required.
- Fast path (`--changed-from` and `--cache-dir`) keyed by git blob SHA to inspect only candidate files changed in the PR.
- Automated test suite verified locally via `npm test`.

The project is MIT licensed on GitHub: https://github.com/Zune2004/archtour. I'd love feedback from platform engineers on what contract changes hurt you most in production!
```

---

## 2. Product Hunt Launch Kit

### Tagline (60 chars max)
> The review step for changes you can't undo

### Pricing
> Free & Open Source (MIT)

### One-Sentence Pitch
> Archtour is one required CI check that blocks breaking database and API contract changes, routes them to the owning team, and grandfathers existing debt.

### Detailed Description
```markdown
Pull requests that break production schemas or contracts shouldn't rely on human memory in code review.

**Archtour** is the review step for changes you can't undo:
Blocks risky pull requests: dropped columns, breaking API changes, privileged containers, public ports, deleted databases. Open source, runs in your CI.

✨ **What You Get:**
- 🛡️ **One Required Check:** Deterministic gating across SQL migrations, Prisma, OpenAPI, GraphQL, Protobuf, Kubernetes, and Terraform plans.
- 🔒 **Base Policy Gate:** Policies are evaluated against the base branch (`--policy-from base`), preventing PRs from weakening rules or self-approving.
- 👥 **Rule Owners & Overrides:** Route breaking changes to named team owners; authorized owners can unblock soft warnings with `/archtour override <ruleId> <reason>`.
- ⏳ **Expiring Exceptions:** Declare exemptions in `.archtour/exceptions.yml` with mandatory reason, owner, and max 365-day expiry.
- 📉 **Technical Debt Ratchet:** Lock in baseline violation counts so existing debt is grandfathered and can only decrease.
- ⚡ **Git Fast Path:** `--changed-from origin/main` checks only changed files with blob-SHA caching for large repos.
- 🔒 **100% Offline & Private:** Runs entirely on your runner with pure Node.js parsers. Zero telemetry, zero cloud calls.

Repository: https://github.com/Zune2004/archtour
```

### First Maker Comment
```markdown
Hello Product Hunt! 👋

I built Archtour to solve a painful engineering problem: breaking contract changes slipping past busy code reviews into production.

Instead of writing custom Danger scripts or maintaining five separate linters with separate configs, Archtour gives engineering teams one required check for destructive contract changes with unified owners, expiring exceptions, and a technical debt ratchet.

It runs completely offline in CI and is 100% MIT open-source. Try `npx archtour check --changed-from origin/main .` and let me know your thoughts! 🚀
```

---

## 3. Developer Community (Reddit / Twitter / LinkedIn)

### Reddit Post (`r/programming`, `r/devops`, `r/node`)
> **Title:** Archtour: One required CI check that blocks breaking DB and API contract changes
>
> **Body:**
> Dropped database columns, removed API routes, and non-concurrent Postgres indexes cause painful production outages. While single-purpose linters exist for individual formats, enforcing governance across polyglot repos usually requires custom glue.
>
> I open-sourced **Archtour** (MIT): "The review step for changes you can't undo."
> Description: Blocks risky pull requests: dropped columns, breaking API changes, privileged containers, public ports, deleted databases. Open source, runs in your CI.
>
> Key features:
> 1. Evaluates SQL migrations (Postgres/MySQL), Prisma, OpenAPI, GraphQL, Protobuf, Kubernetes manifests, and Terraform plans.
> 2. Policy is read from the base branch so PRs cannot self-approve or weaken rules.
> 3. Rule-level ownership routing (`owners: ["@team"]`) and audited `/archtour override` commands.
> 4. Auditable expiring exceptions (`.archtour/exceptions.yml`, max 365 days) and debt ratcheting (`baseline.json`).
> 5. Pure Node.js, 100% offline, zero cloud dependencies.
>
> Repository: https://github.com/Zune2004/archtour
>
> Feedback on rule coverage and CI integration is very welcome!

---

## 4. Cold Outreach Template for Engineering Leads / Platform Teams

> **Subject:** One required CI check for breaking DB & API changes
>
> Hi [Name],
>
> In fast-moving engineering teams, accidental breaking changes—like dropping a database column, removing an API route, or editing an applied migration—frequently slip through pull request review.
>
> I open-sourced **Archtour**: **The review step for changes you can't undo.**
> It's an offline CI check that blocks breaking database and API contract changes, routes them to the owning team, and grandfathers existing technical debt:
> https://github.com/Zune2004/archtour
>
> Rather than maintaining separate linters and glue scripts, Archtour provides a unified required check across SQL migrations, Prisma, OpenAPI, GraphQL, Protobuf, and Terraform plans, with expiring exceptions and owner-driven overrides.
>
> Would love to hear how your team currently prevents destructive contract changes from reaching production.
>
> Best,  
> [Your Name]

---

## Claims checklist

| Claim | Command or file that demonstrates it | Verified (yes/no) |
|---|---|---|
| Guardrails check on changed files against base branch | `node tools/cli.mjs check --changed-from HEAD~1 .` | yes (verified in tests) |
| Policy loaded from base branch (`--policy-from base`) | `tools/rules.mjs`, `tools/cli.mjs` | yes (verified in tests) |
| SQL migration checks (`DROP TABLE`, `DROP COLUMN`, non-concurrent index, type narrowing, edited migration) | `tools/facts-sql.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| Prisma schema checks (dropped models/fields, type changes) | `tools/facts.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| OpenAPI contract checks (removed routes, removed security, required params) | `tools/facts.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| GraphQL breaking & dangerous change detection | `tools/facts-graphql.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| Protobuf field reuse, removal, and RPC method checks | `tools/facts-proto.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| Kubernetes security checks (privileged, root, hostNetwork, hostPath, ingress TLS) | `tools/facts-k8s.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| Terraform plan checks (stateful DB delete/replace, public ingress, public bucket) | `tools/facts-terraform.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| Docker Compose checks (privileged containers, docker socket, host network) | `tools/from-code.mjs`, `tools/rules-recommended.mjs` | yes (verified in tests) |
| Fast path with git blob-SHA facts cache | `tools/facts-cache.mjs`, `tools/changed.mjs` | yes (verified in tests) |
| Expiring exceptions with 365-day cap | `tools/rules.mjs` `loadExceptionsFile` | yes (verified in tests) |
| Baseline debt ratchet | `tools/rules.mjs` `evaluateRatchet` | yes (verified in tests) |
| PR override resolution via label and `/archtour override` | `tools/override.mjs`, `tests/action.test.mjs` | yes (verified in tests) |
| GitHub Action CI/CD gate with default `mode: check` | `action.yml` | yes (verified in tests/action.test.mjs) |
| Public repository visibility on GitHub | GitHub repo settings | yes (public since 2026-11-16) |
| Published npm package | `npm view archtour` | [NEEDS: npm publish] |
| Automated test suite passing | `npm test` | yes (verified) |
