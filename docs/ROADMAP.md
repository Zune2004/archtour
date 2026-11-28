# Roadmap and project plan

## 2026-11-16: Guardrails-first focus (owner decision)

### The new focus
Archtour is **one required check that blocks breaking database and API contract changes, routes them to the owning team, and grandfathers existing debt** (it also checks containers, Kubernetes manifests, and Terraform plans, but those are not the headline).
- **Motto:** "The review step for changes you can't undo."
- **Description:** "Blocks risky pull requests: dropped columns, breaking API changes, privileged containers, public ports, deleted databases. Open source, runs in your CI."

### What shipped since 11-14
- **Base policy (`--policy-from base`):** Policy is loaded from the base branch so a pull request cannot approve itself or weaken its own rules.
- **SQL migrations & Prisma DDL:** Detects destructive operations (`DROP TABLE`, `DROP COLUMN`), type narrowing, unsafe `NOT NULL` without default, non-concurrent index creation on existing tables, table/column renames, and editing previously applied migration files.
- **Kubernetes manifests:** Security and operational checks for workloads, containers, services, and ingresses (privileged containers, root execution, hostNetwork/hostPID, hostPath mounts, removed Ingress TLS).
- **GraphQL & Protocol Buffers:** Breaking GraphQL schema changes (`gql.breaking`) via `graphql-js` and dangerous changes; Protobuf checks for field number reuse, field number changes, unreserved field removals, and removed gRPC services/methods.
- **Terraform plans:** Pre-deployment inspection of planned resource changes (`tfplan.json`) for dropped or replaced stateful databases (RDS, Cloud SQL, DynamoDB), public security group ingress (`0.0.0.0/0`), public S3 buckets, and disabled encryption or deletion protection.
- **CI/CD gate (GitHub Action):** Default `mode: check` gate for pull requests, merge queues, and release tags, with automatic markdown PR summaries, rule owner routing, and `/archtour override` approval workflows.
- **Audit-history:** Fast repository history inspection (`archtour audit-history`) evaluating past commits for architectural changes.
- **Fast path:** Git-integrated candidate discovery (`--changed-from <ref>`) and content-addressed facts caching (`--cache-dir`) keyed by git blob SHA, skipping full-tree walks on large codebases.

### Releases since (CHANGELOG.md has the details)
- **0.3.0 (2026-11-20):** first npm release of the guardrails-only package; the diagram toolkit moved to its own repo.
- **0.3.1 (2026-11-23):** Helm charts rendered with `helm template` (values from `.archtour/helm.yml` or `ci/*-values.yaml`,
  read from the base branch); irreversible SQL (`DROP SCHEMA`, `DROP DATABASE`, `TRUNCATE`, `DELETE` without `WHERE`);
  override owners must own every merged rule; `audit-history` gives the same result as `check` for each past commit.
- **0.3.2 (2026-11-24):** unknown options fail with exit 3 (about 30 dead diagram-toolkit flags removed);
  `docs/CLI.md` lists every command and option.
- **0.3.3 (2026-11-24):** needs-human gate for agent-written PRs (`needsHuman` in `--json`, a report line, Action
  outputs `needs-human`/`needs-human-reasons`/`verdict`, optional `needs-human-label`; fails closed when the check does
  not finish) and agent output mode (`--brief`, `--only`, `--limit`/`--offset`).
- **0.4.0 (2026-11-27):** adapter mode (owner decision Q23): `--import` and the Action input `import` read the JSON
  output of Squawk, oasdiff and `buf breaking` as findings with the same levels, owners, overrides, expiring
  exceptions, debt ratchet and needs-human as built-in rules; `--` ends the options.
- **0.5.0 (2026-11-27):** folder import-boundary rules through dependency-cruiser output (`--import depcruise:<file>`,
  owner decision Q34); a PR that changes an imported tool's config or known-violations file gets a soft
  `linter-config-changed` finding and needs a human; long `--json` output is no longer cut off on Linux and macOS.

### What is explicitly NOT planned
- **Module and import-boundary rules:** No language-level layer or import graph linting (TypeScript, JavaScript, Python, Go, Java, C#). Use existing specialized tools instead:
  - TypeScript/JavaScript: `dependency-cruiser`, `eslint-plugin-boundaries`, Nx `enforce-module-boundaries`
  - Python: `import-linter`
  - Java/C#: `ArchUnit`, `ArchUnitNET`
  - Go: `go-arch-lint`, `depguard`
- **More infrastructure rules:** No competition with broad IaC scanners (Checkov, Trivy, kube-linter, Conftest/OPA). Archtour stays focused on contract safety and high-severity destructive changes.

### Next
- **Override/audit log export** (owner choice 2026-11-28): who overrode or excepted which finding, why and when, as
  JSON or CSV for sign-off reviews.
- **Then:** publishing the measured precision; a clickable demo repository.

---

## Historical Roadmap (Pre-11-16, Diagram-Focused)

> [!NOTE]
> The sections below reflect Archtour's earlier roadmap (last updated 2026-11-14) when the project focused on interactive architecture diagrams. They are preserved for historical context.

### 1. What exists today (done, as of 2026-11-14)

| Group | What shipped | Commit |
|---|---|---|
| Viewer (0. Base skill) | Mermaid + Excalidraw renderers, offline, via headless Chrome; SKILL.md for Claude Code | `7f4cd76` |
| Viewer (1. Interactive viewer) | One self-contained HTML: pan/zoom, minimap, hover tracing, click-for-details panel, search, dark mode, export (SVG/PNG/.excalidraw), "copy question for an AI" | `b328c0a` |
| Viewer (2. Depth) | Nested diagrams (zoom-in or floating cards), collapsible zones, animated flow, guided steps | `b328c0a` |
| Viewer (3. Presets) | 7 styles (sketch, clean, blueprint, midnight, mono, corporate, playful), per-part customization, saved defaults, style gallery, Mermaid follows the preset | `b328c0a` |
| Viewer (3b. Finish) | Rubber-band node drag, presenter mode (laser pointer, notes, progress), automatic tour, live Style menu | `b328c0a` |
| Viewer (4. Smooth flow) | One Tour across all nested diagrams (`dive`), chapter skip, Contents drawer, stacked-card nodes + pulsing badges, caption synced to camera | `6cc463d` |
| Viewer (4b. Size) | gzip-packed payload, one embedded font per typeface: 12 diagrams x 7 styles = 1.5 MB (was 3.1 MB for 3 styles) | `6cc463d` |
| Viewer (5. Standalone) | `npm run setup/doctor/demo/gallery`, `init`, `docs/SPEC.md`, `docs/AI-PROMPT.md` (any AI), neutral config path, README leads with standalone use; Claude Code is optional | `6cc463d` |
| Core | Focus on diagrams core + code-sync, rest experimental | `0ff237c` |
| Core | Rename to Archtour, installable (`npx archtour`) | `d72cf7b` |
| Core | Node 22.12+ required | `577ffbc` |
| Core | Mermaid CLI optional (install 462 MB -> 133 MB) | `639f606` |
| Core | CLI and Action fixes | `391d25d`, `12916d0`, `6ad780b`, `d751a47` |
| Code-sync | Real schema detail and field-level diffs | `33f10d8` |
| Code-sync | `archtour scan` | `851c1ce` |
| Code-sync | Big schemas split into readable groups | `fa427d5` |
| Code-sync | Real YAML parsing, OpenAPI YAML | `e54001e` |
| Code-sync | Reusable GitHub Action for PR architecture diffs | `10dc68d` |
| Code-sync | OpenAPI YAML fix | `597a2a4` |
| Brand kit | Brand kit applied to every render, token import, `brand audit --ci` | `5d4868c` |
| Server beta | Harden the self-hosted sharing server | `27a2716` |
| Server beta | Server v2 (SQLite storage, GitHub login, web app, Docker, backup, self-hosting guide; beta) | `6b51280`, `ac6cf98`, `bf3768c`, `5325276` |
| Server beta | `archtour push` from CI | `7867a58` |
| Server beta | Separate content origin for uploaded diagrams (`ARCHTOUR_CONTENT_ORIGIN`), login page when OAuth is not configured | (this commit) |
| Server beta | Optional Stripe billing (off without keys) | `6d7ed9e` |
| Server beta | Server fixes from an independent security review (25 findings: 1 high, 4 medium, 12 low, 8 info; all high/medium fixed and re-tested) | `fab7170`, `85b4d12` |
| Docs/CI | CI on Linux/macOS/Windows | `2cfea7a` |
| Docs/CI | Showcase site from real output | `d1e119d` |

### Bugs found and fixed while testing (so they are not reintroduced)
- Edge hover areas were attached to the wrong SVG group (hover only worked at a displaced position).
- Excalidraw embeds a glyph subset per SVG under one family name; sharing a page lost glyphs. Fonts are now hoisted (`tools/fonts.mjs`).
- dagre lays siblings out in reverse insertion order. Fix: insert edges reversed, keep nodes forward (reversing nodes flips cycle breaking and turns loops upside down).
- Zone boxes were drawn larger than dagre's and overlapped neighbours; now drawn at dagre's size.
- Caption lagged behind the zoom during tour navigation; now painted first, camera follows.

---

## 2. Decisions made

- **Product scope (2026-11-13; brand kit promoted 2026-11-14):** The diagrams core + code-sync (`scan`, `from-code`, `diff`, `diff-repo`, the Action) is the product. `ai`, `video`, `publish` and the old `server/server.mjs` are experimental (`docs/EXPERIMENTAL.md`). The brand kit was promoted to core on 2026-11-14.
- **Name (2026-11-13):** Archtour (the first pick, Evergraph, conflicted with an existing product). No "Excalidraw" in the name.
- **Open source first and paid models (2026-11-13):** Open source first; three paid models:
  - Model 1, hosted or self-hosted Archtour server for teams (history, private repos, sharing): beta.
  - Model 2, brand kit for companies: shipped in the CLI.
  - Model 3, code-sync in CI: free and open source, the adoption engine.
  Prices and plan limits are not decided (owner question); the server reads limits from env as placeholders.
- **Offline privacy (2026-11-13):** Runs offline; nothing is uploaded unless the user runs `archtour push` to their own server.
- **Runtime and dependencies (2026-11-13):** Node 22.12+ (what the rendering libraries need); system Chrome/Edge instead of a bundled Chromium.

---

## 3. Known limits

- Server v2 is beta (single process, SQLite).
- Hosted service not launched.
- Uploaded diagrams are served from the app origin (sandboxed) unless `ARCHTOUR_CONTENT_ORIGIN` is set; any hosted launch must set it.
- Pages site and npm package not published yet (repo private).
- Code-sync parsers cover Prisma, Docker Compose and OpenAPI only.

---

## 4. Strategy: open source or product?

Archtour follows an open-source-first strategy. The core toolkit and CI integrations are open source to drive adoption and credibility.

### Three paid models and their status
1. **Model 1, Archtour server for teams (hosted or self-hosted):** History, private repos, and sharing. Status: beta.
2. **Model 2, brand kit for companies:** Enforced corporate look and contrast auditing. Status: shipped in the CLI.
3. **Model 3, code-sync in CI:** Free and open source, the adoption engine.

Prices and plan limits are not decided (owner question); the server reads limits from env as placeholders.

---

## 5. Roadmap

### NOW
| Item | Description |
|---|---|
| Owner launch steps | Make the repo public, npm publish, GitHub OAuth app, Stripe account, hosting/domain, pricing |
| Action verification | Verify the Action on a real public repo after launch |

### NEXT
| Item | Description |
|---|---|
| More code-sync parsers | Candidates, not commitments: SQL migrations, GraphQL schema, Terraform |
| Experimental extras | Revisit experimental extras only after launch signals (ai model ids, video audio) |

### LATER
| Item | Description |
|---|---|
| Hosted Archtour Cloud | Hosted Archtour Cloud if self-host adoption shows demand |

---

## 6. Validation plan (before investing in anything paid)

1. **Launch and distribution:** Make the repository public, publish the package to npm, and launch the showcase site.
2. **Community feedback:** Post the showcase where developers gather; talk to engineering teams about stale architecture diagrams.
3. **Usage signals:** Track adoption of the core CLI, GitHub Action, and self-hosted server before investing in hosted infrastructure.
4. **Demand-driven validation:** Gate any hosted cloud service on demonstrated demand from self-host adoption.

---

## 7. Risks and open questions

- **Name/trademark:** Avoid "Excalidraw" in the product name; named Archtour (no "Excalidraw" in the name).
- **Content origin:** a separate content origin exists (`ARCHTOUR_CONTENT_ORIGIN`) but is opt-in; a hosted launch must configure it.
- **Browser dependency to build:** Requires Node 22.12+ and system Chrome/Edge.
- **Copyability:** Open source first; code-sync in CI is the adoption engine; server and brand kit form the paid layer.
- **Maintenance:** Parser updates and Excalidraw export internals; CI on Linux/macOS/Windows and automated test suite ensure stability.
- **Pricing and plan limits:** Prices and plan limits are not decided (owner question); server reads limits from env as placeholders.

---

## 8. How to work on this (conventions)

- Code lives in `tools/` (CLI, renderer, parsers) and `server/v2/` (self-hosted server). Specs and documentation live in `docs/`.
- Before pushing: run `npm test` and verify tests pass. CI runs on Linux, macOS, and Windows.
- Keep outputs and test artifacts out of git (`diagrams/`, `demo.html`, `style-gallery.*` are ignored).
- Update this file when an item ships or a decision changes.
