# Claude Code Setup Agent — Implementation Plan

Oct 19, 2026 · @Rajat

This plan tells Claude Code how to build the MVP (Phase 1) described in the PRD, milestone by milestone, with every decision and constraint it needs.

## 1. How to use this plan (instructions for Claude Code)

Build milestones in order, within the range the owner sets for the session; never start the next milestone until the current one meets its acceptance criteria.

### 1.1 Source documents

- `docs/PRD.md`: the product requirements. Requirement IDs (FR-D1, NFR-5 and so on) refer to it.
- `docs/IMPLEMENTATION_PLAN.md`: this plan. Where it conflicts with the PRD, this plan wins for implementation detail; the PRD wins for product behaviour.
- If something is missing from both, ask the owner. Do not guess on product behaviour.

### 1.2 Working rules

1. **Milestone ranges per session.** The owner sets a range of milestones for each session (for example 0–3). Before starting the range, ask every foreseeable question and input in one single batch. Then work through the range continuously without waiting for approval between milestones, but finish each one properly first: acceptance criteria met, typecheck, lint and tests green, `docs/PROGRESS.md` updated, one commit `M<n>: <summary>`. Stop mid-range only for a decision only the owner can make (uncovered product behaviour, a paid service, a dependency with real trade-offs, deleting data), for something only the owner can supply (keys, seed list, Docker), or when tests still fail after several genuine attempts; decide everything else and record it in `docs/DECISIONS.md`. At the end of the range, report what was built per milestone, test results, decisions, deviations and what the next milestone needs, then ask whether to continue.
2. **Verify Claude Code specifics before using them.** Plugin manifest format, plugin folder layout, `.mcp.json` shape, `settings.json` keys, hook syntax and headless CLI flags change between releases. Check the current official Claude Code documentation and `claude --help` before writing code that depends on them. Record what you verified, with the Claude Code version, in `docs/DECISIONS.md`.
3. **Never invent catalog data.** Tool names, URLs, versions, stars, downloads and security results must come from real API responses or from the owner. No placeholder tools in the real catalog. Test fixtures must live under `test/fixtures/` and use obviously fake names (for example `example-mcp-alpha`).
4. **Approval is by policy or owner, never ad hoc.** `recommended_provisional` and `recommended` are set only by the versioned approval policy (`catalog/policy.yaml`, actor `policy:<version>`, PRD 9.2a) or by an owner action in triage (actor `human:<name>`). No other code sets them. `transitionStatus` stays the only way to change status, and every change is audited. When unsure, don't recommend: uncertainty never creates a manual task (PRD FR-C9).
5. **Secrets.** Never commit secrets. Read them from environment variables validated at startup. Never log tokens or environment variable values.
6. **Model use.** The product's own Anthropic API calls (tool classification in the pipeline, eval runs in the harness) may use only Claude Haiku and Claude Sonnet, never Opus. Model IDs live in config, not in code (see section 5). This rule is about the code you are building, not about you: the owner may run this Claude Code session on any model, including Opus.
7. **Spend.** Every Anthropic API call goes through the budget ledger (Milestone 9 introduces the full version; Milestone 3 introduces the minimal one). Hard stop at the weekly cap.
8. **Record decisions.** Any choice not covered here goes in `docs/DECISIONS.md` with the reason, in one or two lines.
9. **Tests are part of done.** Each milestone lists its tests. A milestone with failing or missing tests is not done.
10. **Keep it portable.** No code may assume it runs on the owner's laptop: no absolute paths, no OS-specific shell commands outside clearly isolated scripts, all hosts and paths from config.

### 1.3 First thing to do

In Milestone 0, save the PRD and this plan into `docs/`, and create a root `CLAUDE.md` that points to them and summarises the working rules above.

## 2. Locked decisions and assumed defaults

The owner has decided stack, language, hosting approach and eval budget; everything else below is a default Claude Code should use unless the owner changes it.

### 2.1 Locked by the owner

| Decision               | Value                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope                  | Phase 1 (MVP) of the PRD only                                                                                                                         |
| Supported coding agent | Claude Code only                                                                                                                                      |
| MVP project stack      | Next.js websites                                                                                                                                      |
| Language               | TypeScript everywhere (plugin, pipeline, evals, triage)                                                                                               |
| Runtime location       | Local only for now; must move to hosting without rewrites                                                                                             |
| LLM models allowed     | Product API calls (classification, evals): Claude Haiku and Claude Sonnet only, Opus forbidden. Does not restrict the model used to build the project |
| Eval and LLM budget    | USD 20 per week, hard cap, covering all Anthropic API spend                                                                                           |

### 2.2 Defaults (change in `docs/DECISIONS.md` if the owner says so)

| Item                | Default                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| Working name        | `cc-setup-agent` (repo), plugin name `setup-agent`                           |
| Node.js             | Current LTS (22.x)                                                           |
| Package manager     | pnpm with workspaces                                                         |
| Catalog visibility  | Private repo; snapshot published as a release asset on the same private repo |
| Telemetry           | None in MVP                                                                  |
| Supported OS        | macOS, Linux, Windows via WSL                                                |
| Triage UI           | Minimal local web page, server-rendered, no frontend framework               |
| Catalog size target | 50 to 100 reviewed items for Next.js                                         |

### 2.3 One clarification to the PRD

PRD section 10.3 says the MCP server writes no project files except during rollback. This plan adds one more exception: `backup_setup` copies existing config files into `.claude/setup-agent/backups/` before Claude Code changes them. It writes nowhere else.

## 3. Tech stack

Every backend component runs locally in Docker Compose today and maps one-to-one onto a hosted service later, so moving to hosting changes configuration, not code.

| Layer                    | Choice                                                        | Why it is hosting-ready                                          |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Language                 | TypeScript, `strict: true`, ES modules                        | Same code locally and in any Node host                           |
| Monorepo                 | pnpm workspaces                                               | Each app deploys independently later                             |
| Database                 | PostgreSQL 16 in Docker locally                               | Same engine as any managed Postgres; only `DATABASE_URL` changes |
| ORM and migrations       | Drizzle ORM + drizzle-kit                                     | Versioned SQL migrations run the same everywhere                 |
| Job queue and scheduling | pg-boss (Postgres-backed)                                     | No Redis; works on any Postgres; cron-style schedules built in   |
| Validation               | zod for all external data, config and tool I/O                | One schema source for DB, API and snapshot                       |
| MCP server               | `@modelcontextprotocol/sdk` (TypeScript), stdio transport     | Standard for local Claude Code MCP servers                       |
| LLM calls                | `@anthropic-ai/sdk`, Haiku and Sonnet only, prompt caching on | Same SDK hosted                                                  |
| GitHub                   | `@octokit/rest` with a token                                  | Same hosted                                                      |
| HTTP for other APIs      | Native `fetch` with a shared retry and rate-limit wrapper     | Same hosted                                                      |
| Triage web UI            | Hono server, server-rendered HTML                             | Deploys as a normal Node service                                 |
| Signing                  | Ed25519 via `node:crypto`                                     | No external service                                              |
| Snapshot hosting         | GitHub release asset (MVP)                                    | Swap to object storage via a `SnapshotStore` interface           |
| Eval sandbox             | Docker containers started from Node                           | Same on a hosted worker with Docker                              |
| Logging                  | pino, JSON logs                                               | Works with any hosted log collector                              |
| Testing                  | vitest; nock or msw for HTTP mocks                            | Runs in CI                                                       |
| Lint and format          | ESLint + Prettier                                             | CI-ready                                                         |
| CI                       | GitHub Actions: typecheck, lint, test                         | Same pipeline later deploys                                      |

### 3.1 Portability rules

- All external endpoints, paths, model IDs and limits come from config.
- Storage access goes through interfaces (`SnapshotStore`, `ArtifactStore` for eval logs) with a local filesystem implementation now.
- Jobs are pure functions called by a thin pg-boss worker, so they can also run from a CLI or a hosted scheduler.
- No job depends on state held in memory between runs.

## 4. Repository structure

One monorepo with four apps and three shared packages; the plugin app is the only thing end users install.

```
cc-setup-agent/
  CLAUDE.md                     # points to docs/, summarises working rules
  docs/
    PRD.md
    IMPLEMENTATION_PLAN.md
    PROGRESS.md                 # updated at the end of every milestone
    DECISIONS.md                # choices made, with reasons and versions verified
  docker-compose.yml            # postgres (+ later: worker, triage)
  .env.example
  pnpm-workspace.yaml
  packages/
    shared/                     # zod schemas, types, constants, enums, scoring weights
    db/                         # drizzle schema, migrations, query helpers
    core/                       # config loader, logger, http client, budget ledger, LLM client
  apps/
    pipeline/                   # discovery jobs, gates, snapshot build, pg-boss worker, CLI
    triage/                     # Hono server: candidate queue, approve/reject, audit log
    evals/                      # eval harness, task sets, Next.js fixture project, runner
    plugin/                     # the Claude Code plugin (what users install)
      <manifest, commands, skills: verify exact layout in current Claude Code docs>
      server/                   # MCP server source (stdio)
      templates/                # CLAUDE.md sections, settings and hook recipes
  test/
    fixtures/                   # fake projects and fake catalog items for tests
  .github/workflows/ci.yml
```

### 4.1 Package boundaries

- `apps/plugin` must not depend on `packages/db` or `apps/pipeline`. It reads only the signed snapshot, validated with `packages/shared` schemas. This keeps the installed plugin small and offline-capable.
- `apps/pipeline`, `apps/triage` and `apps/evals` may use `packages/db` and `packages/core`.
- The plugin's MCP server is bundled into a single JS file at build time (for example with esbuild), so users need no `pnpm install` inside the plugin.

## 5. Configuration, environment variables and secrets

All configuration loads once at startup through a zod schema in `packages/core`; a missing or invalid value stops the process with a clear message naming the variable, never its value.

| Variable                    | Used by                          | Example or default                                    | Secret |
| --------------------------- | -------------------------------- | ----------------------------------------------------- | ------ |
| `DATABASE_URL`              | pipeline, triage, evals          | `postgres://setup:setup@localhost:5432/setup_agent`   | Yes    |
| `ANTHROPIC_API_KEY`         | pipeline (classification), evals | none                                                  | Yes    |
| `GITHUB_TOKEN`              | pipeline                         | read-only fine-grained token                          | Yes    |
| `MODEL_FAST`                | pipeline, evals                  | Haiku model ID (verify current ID in Anthropic docs)  | No     |
| `MODEL_STRONG`              | evals                            | Sonnet model ID (verify current ID in Anthropic docs) | No     |
| `ALLOWED_MODELS`            | core                             | comma list of the two IDs above                       | No     |
| `WEEKLY_BUDGET_USD`         | core budget ledger               | `20`                                                  | No     |
| `BUDGET_SPLIT_CLASSIFY_USD` | core                             | `3` (rest goes to evals)                              | No     |
| `SNAPSHOT_SIGNING_KEY_PATH` | pipeline                         | path to Ed25519 private key file, outside the repo    | Yes    |
| `SNAPSHOT_STORE`            | pipeline                         | `github-release`                                      | No     |
| `SNAPSHOT_REPO`             | pipeline, plugin                 | `owner/cc-setup-agent`                                | No     |
| `TRIAGE_PORT`               | triage                           | `4400`                                                | No     |
| `TRIAGE_ADMIN_TOKEN`        | triage                           | random string; required even locally                  | Yes    |
| `EVAL_MAX_TURNS`            | evals                            | `15`                                                  | No     |
| `EVAL_TIMEOUT_SECONDS`      | evals                            | `300`                                                 | No     |
| `LOG_LEVEL`                 | all                              | `info`                                                | No     |

### 5.1 Rules

- `.env` is git-ignored; `.env.example` lists every variable with a safe placeholder.
- The LLM client refuses any model not in `ALLOWED_MODELS`, and refuses any ID containing `opus`, even if misconfigured.
- The plugin needs no secrets. Its snapshot public key is embedded at build time; its snapshot URL comes from the plugin's own config.
- The private signing key is generated once with a script (`pnpm keys:generate`), stored outside the repo, and its public half committed to `packages/shared`.

## 6. Database schema

Nine tables implement the PRD data model (section 11) plus the audit log, raw source records and budget ledger; the plugin's local `applied_setup` record is a JSON file, not a table.

| Table                | Key columns                                                                                                                                                                                                                                                                                                                                     | Notes                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `catalog_items`      | `id` (slug, PK), `name`, `kind`, `category`, `stacks` (text\[\]), `source_url` (unique), `package_name` (unique, nullable), `publisher`, `provenance`, `capabilities` (text\[\]), `install` (jsonb), `context_overhead_tokens`, `status`, `superseded_by`, `first_seen`, `last_checked`, `classification` (jsonb with model and prompt version) | Enums from `packages/shared`. `status` default `candidate`                        |
| `item_versions`      | `item_id`, `version`, `released_at`, `pinned` (bool)                                                                                                                                                                                                                                                                                            | One row per seen version; the pinned version is what the snapshot uses            |
| `raw_source_records` | `id`, `source` (enum), `external_id`, `payload` (jsonb), `fetched_at`, `item_id` (nullable)                                                                                                                                                                                                                                                     | Keep raw API data for reprocessing and audit; unique on (`source`, `external_id`) |
| `signal_snapshots`   | `item_id`, `captured_at`, `stars`, `star_velocity_7d`, `downloads_7d`, `last_commit_at`, `open_issues`, `median_issue_response_hours`, `contributors`, `mentions_firsthand`, `mentions_total`                                                                                                                                                   | Time series, one row per item per run                                             |
| `scorecards`         | `item_id`, `version`, `gate_results` (jsonb), `security_findings` (jsonb), `eval_summary` (jsonb), `confidence`, `reviewer`, `reviewed_at`                                                                                                                                                                                                      | Latest per item and version                                                       |
| `eval_runs`          | `run_id`, `item_id`, `item_version`, `baseline_item_id`, `task_id`, `task_set_version`, `model`, `claude_code_version`, `with_tool`, `success`, `input_tokens`, `output_tokens`, `cost_usd`, `wall_seconds`, `errors`, `logs_ref`                                                                                                               | One row per run                                                                   |
| `status_events`      | `id`, `item_id`, `from_status`, `to_status`, `actor` (`system`, `human:<name>` or `policy:<version>`), `reason`, `created_at`                                                                                                                                                                                                                                       | Append-only audit log (NFR-13)                                                    |
| `budget_ledger`      | `id`, `week_start` (ISO week, UTC), `purpose` (`classify` or `eval`), `model`, `input_tokens`, `output_tokens`, `cost_usd`, `ref`, `created_at`                                                                                                                                                                                                 | Every Anthropic API call writes one row                                           |
| `snapshots`          | `version`, `created_at`, `item_count`, `sha256`, `published_url`                                                                                                                                                                                                                                                                                | One row per published snapshot                                                    |

### 6.1 Rules

- Status changes happen only through one function, `transitionStatus(itemId, to, actor, reason)`, which validates the transition and writes `status_events` in the same transaction.
- Allowed transitions follow PRD FR-C7. `recommended` and `recommended_provisional` require `actor` to be `human:<name>` or `policy:<version>`. The policy actor can never use a security override note and can never approve a vetoed item (M8.3).
- Pricing per million tokens for each allowed model lives in config, so cost is computed for every call and stored in the ledger.

## 7. Milestones 0 to 2: foundations

These three milestones produce a working repo, a migrated database and a seed catalog of real candidate items, with no LLM spend yet.

### Milestone 0: Repo and tooling

**Goal:** an empty but fully wired monorepo that installs, builds, lints and tests in CI.

Tasks:

1. Create the structure in section 4. Save the PRD and this plan to `docs/`. Create `CLAUDE.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`.
2. Set up pnpm workspaces, TypeScript project references, ESLint, Prettier, vitest.
3. Add `docker-compose.yml` with Postgres 16 and a named volume.
4. In `packages/core`: config loader (section 5, plus `MODEL_PRICING_JSON` for per-model token prices), pino logger, HTTP client with retries, exponential backoff and per-host rate limits.
5. Add `.env.example` and a `pnpm keys:generate` script for the Ed25519 key pair.
6. Add GitHub Actions CI: install, typecheck, lint, test.
7. Verify current Claude Code plugin docs and record the plugin layout, manifest fields and MCP declaration format in `docs/DECISIONS.md`.

Acceptance:

- [ ] `pnpm install && pnpm build && pnpm lint && pnpm test` pass locally and in CI.
- [ ] `docker compose up -d` starts Postgres; a health script connects.
- [ ] Config loader fails clearly on a missing variable and refuses an Opus model ID.

Tests: config validation (valid, missing, forbidden model), HTTP client retry and backoff with mocked responses.

### Milestone 1: Shared schemas and database

**Goal:** one source of truth for every entity, enum and status transition.

Tasks:

1. In `packages/shared`: zod schemas and TypeScript types for catalog items, scorecards, eval summaries, gate results, the snapshot file, and every MCP tool's input and output (PRD section 10.2).
2. Enums: `kind`, `category`, `provenance`, `status`, `capability`, `source`. Start categories with: `docs`, `browser_testing`, `unit_testing`, `database`, `deploy`, `ui_components`, `code_review`, `git_github`, `observability`, `search`.
3. In `packages/db`: Drizzle schema for section 6, first migration, seed-free.
4. Implement `transitionStatus` with the allowed-transition table and audit writes.
5. Add the minimal budget ledger: `recordSpend()` and `remainingBudget(weekStart, purpose)`.

Acceptance:

- [ ] `pnpm db:migrate` creates all tables on a fresh database.
- [ ] Invalid transitions throw; `recommended` by `system` throws.
- [ ] Snapshot schema round-trips a fixture catalog.

Tests: every allowed and forbidden transition, ledger week boundaries in UTC, schema validation for good and bad payloads.

### Milestone 2: Seed catalog importer

**Goal:** load a first set of real candidates from a list the owner supplies, so later milestones work on real data.

Tasks:

1. Define `catalog/seed.yaml`: a list of entries with only `source_url` (GitHub repo or npm package URL) and optional `note`. The owner fills this file; Claude Code does not invent entries.
2. Write `pnpm pipeline seed`: for each URL, fetch real metadata (GitHub repo info, npm package info), create a `candidate` item, store raw records.
3. Skip and report URLs that 404, are archived, or duplicate existing items.
4. Ask the owner to provide the seed list (target 60 to 120 URLs for Next.js: official vendor MCP servers, skills, plugins, subagents, hook recipes). If they prefer, Claude Code may propose candidate URLs found through real searches, clearly labelled as proposals for the owner to approve before import.

Acceptance:

- [ ] Running seed twice creates no duplicates.
- [ ] Every imported item has a real `source_url` that resolved during import.
- [ ] Import report lists created, skipped and failed URLs with reasons.

Tests: importer with mocked GitHub and npm responses, including 404, archived and duplicate cases.

## 8. Milestones 3 to 5: discovery, credibility gates, triage

By the end of Milestone 5 the pipeline finds new tools daily, scores them through gates 0 to 3, and puts them in front of the owner for approval.

### Milestone 3: Discovery jobs

**Goal:** PRD FR-D1, D2, D3, D5, D8, D9, D10 working on a daily schedule.

Tasks:

1. Each source is a module implementing `fetchNew(since): RawRecord[]` and `normalize(raw): CandidateDraft`:
   - Claude Code changelog and GitHub releases (FR-D1): flag entries mentioning plugins, MCP, settings, hooks, skills, models; store as `claude_code_feature` change notes for the owner, not as installable items.
   - Official MCP Registry API (FR-D2). Verify the current endpoint and response shape before coding.
   - GitHub search (FR-D3): topics `mcp-server`, `claude-code`, `claude-skills`, `claude-code-plugin`, updated in the last 7 days; respect search API rate limits.
   - Official plugin marketplaces and vendor-published MCP servers (FR-D5): configured as a list of URLs in `catalog/sources.yaml`.
2. Dedupe (FR-D8) by normalised repo URL, then package name; link records to existing items.
3. Classification (FR-D9) with `MODEL_FAST` (Haiku): input is name, description and README excerpt (truncate to about 4,000 characters); output is a zod-validated JSON with `kind`, `category`, `stacks`, `summary`, `provenance_guess`. Use prompt caching for the fixed system prompt. Store model ID and prompt version. On invalid output, retry once, then mark `needs_manual_classification`.
4. Every call goes through the ledger; stop classification for the week when the classify budget is used up and queue the rest.
5. Register pg-boss schedules: discovery daily at 02:00 UTC; also runnable as `pnpm pipeline discover --source <name>`.

Acceptance:

- [ ] A full run on live APIs completes, inserts new candidates and creates no duplicates on a second run.
- [ ] A failed source does not block other sources (NFR-4).
- [ ] Classification spend is recorded per call and stops at the cap.

Tests: each normaliser with recorded fixture responses, dedupe rules, classifier output validation with a mocked SDK, budget stop.

### Milestone 4: Credibility gates 0 to 3

**Goal:** PRD FR-C0, C1, C2, C3, C6, C7, C8 producing a scorecard per item version.

Tasks:

1. Gate 0 hygiene: license, README length, not an empty repo or bare fork, has a release or published package. Installs and starts: run the install command in a throwaway container and, for MCP servers, connect with the MCP SDK client and call `listTools` within 30 seconds. Failure sets `rejected`.
2. Gate 1 provenance: `official_vendor` when the repo owner matches a vendor allowlist in `catalog/vendors.yaml` (owner maintains it); otherwise `community`. Record author's count of other maintained repos.
3. Gate 2 health: compute signals from GitHub and npm (`signal_snapshots`). No commit in 180 days moves a recommended item to `watchlist`.
4. Gate 3 security:
   - Fetch tool definitions via `listTools` and scan descriptions and parameter descriptions with rules for hidden instructions (phrases like "ignore previous", instructions to read files or send data, unusual Unicode, very long descriptions). Flag; never auto-pass a flagged item.
   - Record capabilities (shell, file read and write, network) from tool names, descriptions and package dependencies.
   - Query the OSV API for dependency vulnerabilities; flag high and critical.
   - Flag install scripts (`preinstall`, `postinstall`).
   - Run the server in a container with network egress logged during `listTools`; record contacted hosts.
   - A confirmed injection or undisclosed exfiltration sets `blocked`.
5. Measure `context_overhead_tokens` from the serialised tool definitions (estimate at 4 characters per token; no API call).
6. Write the scorecard (FR-C6) with evidence links and an overall confidence from a weights table in `packages/shared`.
7. Re-check schedule (FR-C8): gates 0 to 3 for all recommended items every 30 days and on every new version.

Acceptance:

- [ ] Every seed item has a scorecard with gates 0 to 3.
- [ ] A fixture MCP server with a poisoned tool description is flagged and cannot be approved without an explicit override note.
- [ ] Container runs leave no processes or volumes behind.

Tests: each gate with fixtures (clean, abandoned, vulnerable dependency, poisoned description, install script), confidence calculation.

### Milestone 5: Triage UI

**Goal:** the owner reviews candidates and sets statuses in a few clicks (PRD FR-C9, UC-09).

Tasks:

1. Hono server on `TRIAGE_PORT`, protected by `TRIAGE_ADMIN_TOKEN`, bound to localhost by default.
2. Pages: candidate queue sorted by a priority score (provenance, health, category gaps for Next.js); item detail with scorecard, raw evidence links, security flags and eval results; status change form requiring a reason.
3. Status changes call `transitionStatus` with `actor = human:<name>`.
4. A "Claude Code changes" page listing changelog entries from Milestone 3 for the owner to read.

Acceptance:

- [ ] Owner can approve an item to `recommended_provisional` with a reason, and the audit log shows it.
- [ ] A flagged security item shows the flag prominently and requires a written override.

Tests: route tests for auth, transitions and validation.

## 9. Milestones 6 to 8: signed snapshot and the plugin

These milestones turn the approved catalog into a signed file and build the plugin that uses it, so a user can run `/setup` end to end.

### Milestone 6: Signed catalog snapshot

**Goal:** PRD NFR-5. The plugin only ever trusts a signed snapshot.

Tasks:

1. `pnpm pipeline snapshot`: export all items with status `recommended`, `recommended_provisional`, `watchlist`, `deprecated` and `blocked` (blocked and deprecated are needed for warnings), with pinned versions, install details, scorecard summaries and eval summaries.
2. Validate with the shared snapshot schema; write `catalog-<version>.json` plus a detached Ed25519 signature and a SHA-256.
3. Publish through `SnapshotStore` (GitHub release asset in MVP); record it in `snapshots`.
4. Snapshot version format: `YYYY.MM.DD-N`. Snapshot includes `generated_at` for staleness checks.

Acceptance:

- [ ] A tampered byte makes signature verification fail.
- [ ] Snapshot contains no `candidate` or `rejected` items.

Tests: sign and verify, tamper detection, status filtering.

### Milestone 7: Plugin MCP server

**Goal:** every tool in PRD section 10.2, plus `backup_setup`, working against a local snapshot.

Tools and behaviour:

1. `sync_catalog`: download the latest snapshot, verify signature with the embedded public key, store in the plugin's data folder. On failure keep the last valid snapshot. Report snapshot age; warn above 7 days.
2. `analyze_project(path)`: read only metadata files. Detect package manager from lockfile; Next.js version and App vs Pages router; TypeScript; test runners (vitest, jest, playwright, cypress); styling (tailwind and similar); ORM or database libraries; monorepo markers (`pnpm-workspace.yaml`, `turbo.json`, workspaces); existing `CLAUDE.md`, `.mcp.json`, `.claude/`. Return a typed `ProjectProfile`. Under 5 seconds on 10,000 files (NFR-1): never read source file contents.
3. `recommend_setup(profile, answers)`: deterministic, no LLM call.
   - Map profile and answers to needed categories (for example: Playwright present or "test-first" answer → `browser_testing`).
   - Candidates: items with matching stack and status `recommended` or `recommended_provisional` only.
   - Score: eval uplift (if any) > confidence > provenance > health; tie-break by lower context overhead.
   - One item per category; resolve overlaps (FR-R7); report excluded items with reasons (FR-R5).
   - Total context overhead; warn above a configured threshold.
   - Model recommendation from a small rules table (task complexity and budget answers) with a cost note.
   - Same inputs and snapshot version give byte-identical output (FR-R8).
4. `explain_item(id)`: scorecard, evidence links, eval results, alternatives in the same category.
5. `backup_setup(path)`: copy existing `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, `.claude/agents/`, `.claude/skills/` into `.claude/setup-agent/backups/<timestamp>/` with a `manifest.json`. Writes nowhere else.
6. `generate_config(path, approvedIds)`: return file contents and unified diffs only; never write.
   - `CLAUDE.md`: add or replace only a managed block between `<!-- setup-agent:start -->` and `<!-- setup-agent:end -->`; never touch content outside it.
   - `.mcp.json`: merge by server name; keep unknown servers; pinned versions; env values as `${VAR}` placeholders only.
   - `.claude/settings.json`: deep merge; union permission lists; add hook recipes from templates.
   - Validate every output against the schema recorded in Milestone 0's `DECISIONS.md`.
   - Return the list of required environment variable names.
7. `verify_setup(path)`: start each configured MCP server via the SDK client, call `listTools` with a 15-second timeout, then shut it down; check required env vars exist (presence only); parse settings; detect duplicate tool names. Return pass or fail per item with a fix.
8. `check_updates(path)`: compare the project's installed items and versions to the snapshot (PRD FR-U1, U2). Blocked items come first.
9. `rollback_setup(path, backupId?)`: restore files from a backup and report what was restored.

Rules: tool descriptions short (NFR-2: whole plugin under 2,000 tokens of definitions); never accept or return secret values; every response includes `catalog_version`.

Acceptance:

- [ ] All tools pass against fixture Next.js projects: fresh app, app with existing config, monorepo, project with a blocked item installed.
- [ ] `generate_config` never changes content outside the managed block.
- [ ] Recommendation output is identical across two runs.

Tests: unit tests per tool; snapshot tests of generated files; property test that merges never drop unknown `.mcp.json` servers.

### Milestone 8: Plugin packaging, commands and skill

**Goal:** a user installs the plugin and runs the core journey in PRD section 8.1.

Tasks:

1. Build the plugin in the folder layout verified in Milestone 0: manifest, MCP server declaration (bundled single-file server), commands and skill.
2. Commands: `/setup`, `/setup-check`, `/setup-rollback`, `/explain`.
3. Setup skill instructions for Claude, in order:
   1. Call `sync_catalog`, then `analyze_project`; tell the user what was detected.
   2. Ask at most five questions (goal, deploy target, budget sensitivity, risk tolerance, workflow).
   3. Call `recommend_setup`; present each item with reason, confidence and trade-off, plus excluded items.
   4. Let the user approve or remove items one by one.
   5. Call `backup_setup`, then `generate_config`; show diffs; write files with Claude Code's normal file tools so the user approves each write.
   6. Tell the user which environment variables to set, never asking for values.
   7. Call `verify_setup` and report results with fixes.
4. Add a local marketplace file so the owner can install from the repo, and a `README.md` with install steps.

Acceptance:

- [ ] Owner installs the plugin into Claude Code from the local marketplace and completes `/setup` on a fresh Next.js app.
- [ ] `/setup-rollback` restores the original files exactly (byte compare).

## 10. Milestones 9 and 10: evals and acceptance

The eval harness must prove uplift in one category inside USD 17 a week (USD 20 cap minus USD 3 for classification), using Haiku for screening and Sonnet only to confirm.

### Milestone 9: Eval harness

**Goal:** PRD FR-E1 to E6 for one category, default `browser_testing` (owner may switch).

#### 9.1 Budget strategy

1. **Pilot first.** Run one task once with Haiku and once with Sonnet. Record actual cost per run in `docs/DECISIONS.md`. Compute the affordable runs per week from that, and set batch sizes accordingly. Do not hardcode cost guesses.
2. **Two stages.**
   - Stage A, screening: Haiku (`MODEL_FAST`), 3 runs per task with the candidate.
   - Stage B, confirmation: Sonnet (`MODEL_STRONG`), 1 run per task, only for candidates that beat the incumbent in Stage A by the configured threshold.
3. **Cache baselines.** Runs without the tool (or with the incumbent) are cached by key: task ID, task-set version, model, Claude Code version, incumbent version. Re-run only when a key changes.
4. **Early stop.** Stop a candidate's Stage A when it fails 2 tasks the baseline passed.
5. **Pre-flight check.** Before each batch, estimate cost as runs × measured average for that model; skip and queue the batch if it exceeds the remaining weekly eval budget. Check again before every single run.
6. **Small tasks.** 5 tasks per category, each solvable in under 15 turns on a small fixture app; `EVAL_MAX_TURNS=15`, `EVAL_TIMEOUT_SECONDS=300`.
7. **Deterministic grading only.** Pass or fail by tests, file assertions or exact output; no LLM-as-judge.
8. **Record actual spend** (amended 2026-10-20, owner decision). Before a run, reserve its cap in the ledger; after it (also after a timeout), replace the reservation with the usage the API relay saw on every response, priced from config. Claude Code's JSON totals are the fallback when the relay missed a response; the cap stays booked only when neither exists although the API answered. A run that hits the time limit fails its task, on either side of the comparison.

#### 9.2 Harness tasks

1. Fixture: a small Next.js app in `apps/evals/fixtures/next-app` with dependencies pre-installed in a Docker image, so runs never wait on `npm install`.
2. Task format (`apps/evals/tasks/<category>/<task-id>/`): `task.md` (the prompt), `setup.sh` (puts the fixture into the task's starting state, for example introduces a bug), `check.sh` (exit 0 = pass), `meta.yaml` (category, version).
3. Runner: for each run, start a fresh container from the image, apply `setup.sh`, run Claude Code headless with the model flag, a max-turns limit, JSON output and an MCP config containing only the tool under test (or none for baseline). Verify the exact flags with `claude --help` for the installed version and record them.
4. Permissions inside the container may be fully open because the container is disposable; never on the host. Pass only `ANTHROPIC_API_KEY` into the container. Log network egress.
5. After the run: execute `check.sh`, collect tokens, cost, time, errors and logs (via `ArtifactStore`), destroy the container.
6. Summarise per candidate vs incumbent: success rate, mean tokens, mean cost, mean time, context overhead. Write `eval_summary` into the scorecard; show it in triage.
7. Pin model IDs, Claude Code version and task-set version on every run (FR-E5).

Acceptance:

- [ ] Pilot costs recorded; weekly run plan computed and documented.
- [ ] One category has 5 tasks with deterministic checks that pass on a known-good solution and fail on the broken starting state.
- [ ] At least one candidate evaluated against a baseline, with results visible in triage.
- [ ] Ledger never exceeds USD 20 in any ISO week; a test proves the hard stop.
- [ ] No Opus call is possible anywhere (config test plus code search in CI).

Tests: runner with a fake Claude Code binary returning canned JSON; budget pre-flight and hard stop; baseline cache keys; container cleanup.

### Milestone 8.3: Autonomous curation (owner decision 2026-10-20)

**Goal:** the catalog curates itself (PRD FR-C9, FR-D9a, FR-P1 to FR-P9). "When unsure, don't recommend" replaces "when unsure, ask the owner".

Tasks:

1. Docs: PRD FR-C9, FR-D9a, 9.2a; plan rule 4 and 6.1; `CLAUDE.md`.
2. Status rules: actor `policy:<version>` may set `recommended_provisional` and `recommended`; demotion back to `candidate` (eval regression, veto). The policy actor never uses override notes and never approves vetoed items.
3. Classification without review: deterministic category rules (`catalog/category-rules.yaml`), the fast model, and a strong-model second opinion for items eligible on every other criterion; agreement as in FR-D9a. Input hash per item; `classify --changed` re-classifies only changed inputs. Gold set from owner-locked fields and owner approvals; `pnpm run pipeline classify:eval` scores a prompt version and records the score; a new prompt version can't be applied unless it scores at least as well. The "needs classification review" filter becomes an optional view.
4. Approval policy (`catalog/policy.yaml`, pure evaluators in `packages/shared`, unit-tested): approval, promotion and demotion rules from PRD 9.2a; `pnpm run pipeline policy` evaluates every item, asks for second opinions, applies transitions and stores the latest decision per item.
5. Weekly automatic evals (FR-P7) within the caps, with the planned batch and estimate logged first.
6. Weekly digest (`reports/` and a triage page) and the owner veto.
7. Run the policy on the live catalog and report the result to the owner before publishing a snapshot.

Acceptance:

- [ ] Every policy rule has a unit test (approve, refuse, promote, each demotion trigger, veto).
- [ ] The policy never approves a security-flagged, vetoed or unknown-install item (unit and DB tests).
- [ ] Policy status changes carry actor `policy:<version>` and an audited reason.
- [ ] A prompt version that scores worse than the current one can't be applied (test).
- [ ] Scheduled evals never exceed the weekly or total cap and log their plan before spending (test).
- [ ] Live policy report shown to the owner; no snapshot published before that.

### Milestone 10: End-to-end acceptance

**Goal:** prove the MVP against PRD section 17.2.

Tasks:

1. Run the full loop on live data: discover, gate, approval policy (50+ approved items; owner veto optional), snapshot, install plugin, `/setup` on a fresh Next.js app, verify, rollback.
2. Deliberately break one MCP server and confirm `verify_setup` reports it.
3. Mark one installed item `blocked`, publish a snapshot, and confirm the warning appears on the next plugin run.
4. Write `docs/MVP_REPORT.md`: each PRD 17.2 criterion with pass or fail and evidence, total spend so far, known issues, Phase 2 recommendations.

Acceptance:

- [ ] Every PRD 17.2 checkbox passes, or has an owner-accepted exception written in the report.

## 11. Testing strategy

CI never calls paid or live APIs: unit and integration tests use recorded fixtures and mocks, and live checks run only by explicit command.

| Level             | Scope                                                                               | Runs in                         | Tools               |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------- | ------------------- |
| Unit              | Schemas, transitions, scoring, merges, budget maths, each gate rule                 | CI, every push                  | vitest              |
| Integration       | Pipeline jobs against Postgres with mocked HTTP; MCP tools against fixture projects | CI (Postgres service container) | vitest, msw or nock |
| Contract          | Normalisers against recorded real API responses saved in `test/fixtures/sources/`   | CI                              | vitest              |
| Plugin end to end | MCP server driven by the MCP SDK client over stdio against fixture projects         | CI                              | vitest              |
| Live smoke        | One real discovery run per source, one real gate run                                | Manual, `pnpm smoke`            | real APIs, no LLM   |
| Eval harness      | Fake Claude Code binary in CI; real runs only via `pnpm evals run`                  | CI (fake) / manual (real)       | vitest, Docker      |

### 11.1 Fixture projects (in `test/fixtures/projects/`)

- `next-fresh`: new Next.js app, no Claude Code config.
- `next-existing`: has a hand-written `CLAUDE.md` and an `.mcp.json` with one unknown server.
- `next-monorepo`: pnpm workspace with two Next.js apps.
- `next-blocked`: `.mcp.json` includes an item marked `blocked` in the fixture snapshot.
- `not-next`: a plain Python project, to test the unsupported-stack path.

### 11.2 Required CI checks

- Typecheck, lint, all tests.
- A search that fails the build if any source file or config contains an Opus model ID.
- A secret scan on the diff.

## 12. Path to hosting and Phase 2

Moving to hosting means swapping configuration and two storage implementations; Claude Code should not build any of this during the MVP, only keep it possible.

### 12.1 Hosting move (after MVP)

| Local today                                      | Hosted later                          | Code change needed                 |
| ------------------------------------------------ | ------------------------------------- | ---------------------------------- |
| Postgres in Docker Compose                       | Managed Postgres                      | `DATABASE_URL` only                |
| pg-boss worker started by `pnpm pipeline worker` | Same worker as a long-running service | None                               |
| Triage on localhost                              | Same Hono app behind auth and HTTPS   | Add a real auth provider           |
| Snapshot on GitHub release                       | Object storage or a CDN               | New `SnapshotStore` implementation |
| Eval logs on local disk                          | Object storage                        | New `ArtifactStore` implementation |
| Eval containers on the laptop                    | Worker host with Docker               | None                               |
| Signing key file on disk                         | Secret manager                        | Config change                      |

### 12.2 Phase 2 (do not build in MVP)

- Stacks two and three.
- npm and PyPI download trends (FR-D4), awesome-list diffs (FR-D6), HN and Reddit signals (FR-D7), gate 4 real-user signal (FR-C4), anti-gaming checks (FR-C2a).
- `check_updates` as a scheduled weekly prompt, and tool comparison (UC-06).
- Evals in every category, re-run on model or Claude Code changes (FR-E8).
- A Gate B review against PRD success metrics before any Phase 3 work.

### 12.3 Before you start

The owner should have ready: Docker installed, a GitHub token, an Anthropic API key with a spend limit set in the Anthropic console as a second safety net, and the seed list of tool URLs for Milestone 2.
