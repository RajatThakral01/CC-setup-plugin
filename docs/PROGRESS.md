# Progress

## Current state

- **Session range:** Milestones 6–8 (owner-approved 2026-10-19; M8 stops before the owner-run acceptance).
- **Current milestone:** 8 — Plugin packaging, commands and skill.
- **Total Anthropic API spend to date:** USD 0.1359 (Haiku classification only). Weekly cap USD 20, total cap USD 40.
- **Remote:** https://github.com/RajatThakral01/CC-setup-plugin — pushed after every milestone; CI green.

## Milestones

| #   | Milestone                   | Status | Commit |
| --- | --------------------------- | ------ | ------ |
| 0   | Repo and tooling            | Done   | M0     |
| 1   | Shared schemas and database | Done   | M1     |
| 2   | Seed catalog importer       | Done   | M2     |
| 3   | Discovery jobs              | Done   | M3     |
| 4   | Credibility gates 0 to 3    | Done   | M4     |
| 5   | Triage UI                   | Done   | M5     |
| 6   | Signed catalog snapshot     | Done   | M6     |
| 7   | Plugin MCP server           | Done   | M7     |
| 8   | Plugin packaging            | Next   |        |
| 9   | Eval harness                |        |        |
| 10  | End-to-end acceptance       |        |        |

## Milestone 0 — Repo and tooling (done)

Built:

- pnpm workspace: `packages/{shared,core,db}`, `apps/{pipeline,triage,evals,plugin}`, TS project references, ESLint + Prettier, vitest.
- `docker-compose.yml` with Postgres 16 (host port 5433, named volume); `pnpm db:health`.
- `packages/core`: zod config loader (`.env` lookup, per-command `requireSecret`, Opus refusal, model pricing, both budget caps), pino logger with secret redaction, HTTP client (retries, backoff with jitter, `Retry-After`, GitHub rate-limit reset, per-host spacing, zod-validated JSON).
- `.env.example`, `pnpm keys:generate --out <dir>` (Ed25519; refuses to write the private key inside the repo).
- `pnpm check:models` (repo scan for Opus model IDs).
- `.github/workflows/ci.yml`: install, typecheck, lint, model scan, DB health, test (Postgres service) + gitleaks secret scan.
- Claude Code plugin/MCP/settings/headless facts recorded in `docs/DECISIONS.md`.

Acceptance:

- [x] `pnpm install && pnpm build && pnpm lint && pnpm test` pass locally (also from a clean clone). CI workflow written; first real CI run happens when the owner pushes.
- [x] `docker compose up -d` starts Postgres; `pnpm db:health` connects.
- [x] Config loader fails clearly on a missing variable and refuses an Opus model ID.

## Milestone 1 — Shared schemas and database (done)

Built:

- `packages/shared`: zod schemas and types for catalog items, install details (pinned versions only, env var names only), classification, gate results, scorecards, eval summaries, the snapshot file, and every MCP tool's input/output. Enums for kind, category (14 incl. auth/payments/email/cms), provenance, status, capability, source, confidence.
- `packages/db`: Drizzle schema for the 9 planned tables plus `claude_code_changes`; first migration `0000_init`; `pnpm db:migrate`.
- `transitionStatus()` (single path for status changes, transactional audit log) and `insertCandidate()`.
- Budget ledger: `recordSpend()`, `remainingBudget()`, `assertBudget()`, `spendSummary()`; enforces purpose-weekly, weekly and total caps; warns past USD 30 total.

Acceptance:

- [x] `pnpm db:migrate` creates all tables on a fresh database (dev DB, plus every DB test run).
- [x] Invalid transitions throw; `recommended` by `system` throws.
- [x] Snapshot schema round-trips a fixture catalog (`test/fixtures/catalog/snapshot.json`).

Tests: all 49 status pairs × 2 actor types, ledger week boundaries in UTC, all three caps, schema good/bad payloads. 192 tests total.

## Milestone 2 — Seed catalog importer (done)

Built:

- `catalog/seed.yaml`: the 117 owner-approved entries (from `catalog/seed.proposed.yaml`, minus `anthropics/claude-code-action`, with auth/payments/email/cms re-filing).
- `pnpm run pipeline seed [--file]`: resolves each GitHub repo, GitHub folder or npm package live, creates a `candidate` item with real metadata, stores raw records, prints a created/skipped/failed report.
- GitHub and npm source clients (zod-validated), URL parsing and canonicalisation, raw-record upsert and dedupe helpers in `packages/db`.

Acceptance:

- [x] Running seed twice creates no duplicates (tested with mocks; live: second run 0 created, 117 duplicates).
- [x] Every imported item has a real `source_url` that resolved during import (live: 117/117).
- [x] Import report lists created, skipped and failed URLs with reasons.

Tests: importer with mocked GitHub and npm (created repo/folder/npm, renamed repo, 404 repo/folder/package, archived, deprecated, npm-with-archived-repo, duplicate, persistent 500, unsupported URL, second run), URL parsing. 215 tests total.

## Milestone 3 — Discovery jobs (done)

Built:

- Sources: Claude Code changelog + releases (FR-D1, into `claude_code_changes` with topic flags), MCP Registry (FR-D2), GitHub topic search (FR-D3), six official marketplaces from `catalog/sources.yaml` (FR-D5). Repo facts via batched GitHub GraphQL.
- Dedupe by canonical URL / package name (FR-D8); intake filter, vendor exception, daily cap of 30 with priority, deferral and daily re-check (FR-D10 as amended); star velocity; `signal_snapshots` for linked items.
- Haiku classification (FR-D9) through a ledger-guarded LLM client: structured JSON output, cached system prompt, retry once then `needs_manual_classification`, stops at the budget cap.
- `source_runs` table; pg-boss worker scheduling discovery daily at 02:00 UTC; CLI `discover`, `intake`, `classify`, `worker`, `spend`.
- `catalog/vendors.yaml` (57 orgs from approved seed entries) and `catalog/sources.yaml`.

Acceptance:

- [x] A full run on live APIs completes, inserts new candidates and creates no duplicates on a second run. Live run 1 (2026-10-19): 4/4 sources ok (Registry 7,376, GitHub search 3,571, marketplaces 339, changelog 60 records); 30 candidates accepted, 1,300 deferred, 9,910 filtered; 146 items classified, 0 failures. Run 2: 0 new items, 147 items / 147 distinct URLs.
- [x] A failed source does not block other sources (NFR-4): tested; each source gets a `source_runs` row.
- [x] Classification spend is recorded per call and stops at the cap: tested with a tiny cap; live spend USD 0.0313, one ledger row per call.

Tests: normalisers against anonymised recorded responses, GraphQL batching, dedupe/linking, every filter reason, vendor exception, daily cap and next-day deferral, refresh path, LLM client (pre-flight, ledger, Opus refusal, invalid output), classification (hints win, retry, budget stop, API failures), discovery runner isolation, pg-boss schedule. 263 tests total.

## After Milestone 3 — owner follow-ups (done)

- Remote `origin` added, history pushed; CI fixed (gitleaks CLI in a pinned container) and green on GitHub.
- Intake priority: up to 300 filter-passing records classified per day before ranking; slots filled by Next.js relevance, then vendor, star velocity, stars; irrelevant intake items marked out of scope for Next.js. Prompt `classify-v2`; all 147 items re-classified (10 marked out of scope); 300 deferred records classified live (223 Next.js-relevant).

## Milestone 4 — Credibility gates 0 to 3 (done)

Built:

- Docker sandbox for third-party code with every owner rule enforced on the `docker run` arguments (pinned official images, one throwaway mount, no secrets, non-root, no capabilities, CPU/memory/pids/time limits, fixed platform, internal network with an egress-logging proxy, always removed) and a test that fails if a container could start without them; a boundary test keeps Docker use inside the sandbox module.
- MCP probe: install in the sandbox, connect with the MCP SDK over stdio, list tools, record egress; remote servers probed over HTTP.
- Install resolution with exact versions (npm, PyPI, Registry packages/remotes, Registry lookup by repo, repo package.json with anti-squatting check, pyproject.toml).
- Gates 0–3 with evidence, OSV checks, install-script and tool-poisoning rules, capabilities, context overhead, confidence from a weights table, scorecards per item version, pinned versions, signal snapshots; status changes (rejected / blocked / watchlist, and lifting system rejections) through `transitionStatus`; approval of security-flagged items needs a written override note.
- `pnpm run pipeline gates [--item … | --pending | --recheck]`; daily pg-boss `gates-daily` (04:00 UTC) incl. the 30-day re-check of recommended items.

Acceptance:

- [x] Every seed item has a scorecard with gates 0 to 3 (all 147 items; live 2026-10-19). Outcome: 140 candidates, 7 rejected (no licence, or uninstallable); confidence high 72 / medium 54 / low 21; gate 3 flagged 13 (mostly high-severity vulnerable dependencies, e.g. a pinned vulnerable MCP SDK); 0 confirmed injections.
- [x] A fixture MCP server with a poisoned tool description is flagged and cannot be approved without an explicit override note (real-Docker test: confirmed injection → blocked; unit/DB tests: flagged item refused without `overrideNote`, accepted with it).
- [x] Container runs leave no processes or volumes behind (real-Docker tests on success, timeout and poisoned server; after the full live run: 0 sandbox containers, 0 networks).

Tests: each gate with fixtures (clean, abandoned, vulnerable dependency, poisoned description, install script), confidence, sandbox policy (every rule), install resolution, OSV, start-failure classification, gateItem end to end on a test DB. 365 tests total, including 4 real-Docker tests (run in CI).

Deviation worth a look: gate 0 hard-rejects only proven hygiene failures. "Starts without configuration" and "install method found" are soft, because the first live run wrongly rejected official servers that need an API key or are remote-only (see DECISIONS M4).

## Milestone 5 — Triage UI (done)

Built:

- Hono server (`pnpm triage`) on `TRIAGE_HOST:TRIAGE_PORT` (127.0.0.1:4400), protected by `TRIAGE_ADMIN_TOKEN` (signed HttpOnly SameSite=Strict session cookie, CSRF tokens on every form, strict security headers, https-only links).
- Candidate queue sorted by priority (provenance, health, confidence, Next.js category gaps), filters for status, scope, category and search; out-of-scope items hidden by default with a count and a filter.
- Item page: metadata, classification, install, capabilities, context overhead, health, every gate with evidence links, eval placeholder, audit log, raw records; status form limited to allowed transitions and requiring a reason; security-flagged items show a red panel and need a written override note; scope toggle.
- "Claude Code changes" page with flag filters.

Acceptance:

- [x] Owner can approve an item to `recommended_provisional` with a reason, and the audit log shows it (route test: `human:owner` event with the reason, shown on the item page).
- [x] A flagged security item shows the flag prominently and requires a written override (route test: red panel with findings; 409 without the note; the note is recorded in the audit reason).

Tests: route tests for auth (sign-in, forged/tampered sessions, weak token, CSRF), queue and scope filtering, escaping of hostile data and non-https links, transitions, validation, override, scope toggle, changes page; priority score. Live smoke test: server starts with the `.env` token, sign-in page 200, unauthenticated page → sign-in redirect, unauthenticated POST 401.

## Milestone 6 — Signed catalog snapshot (done)

Built:

- `pnpm run pipeline snapshot`: exports publishable items, validates with the shared schema, signs with Ed25519, writes `catalog-<version>.json` + `.sig` + `.sha256` + `latest.json` through `SnapshotStore` (local store; GitHub-release store kept behind the interface, refusing), records the snapshot in `snapshots`.
- Owner's public key committed; publishing refuses a mismatched private key.

Acceptance:

- [x] A tampered byte makes signature verification fail (test).
- [x] Snapshot contains no `candidate` or `rejected` items (test with all statuses).

Tests: sign/verify, tamper, wrong key, status filtering, skipped incomplete items, version numbering, local store files and pointer, key mismatch, missing key file, deferred GitHub store.

Not run live: the owner's `.env` `SNAPSHOT_SIGNING_KEY_PATH` still holds the placeholder path, and no items are approved yet (the snapshot would be empty).

## Milestone 7 — Plugin MCP server (done)

Built (`apps/plugin/server`): `sync_catalog`, `analyze_project`, `recommend_setup`, `explain_item`, `backup_setup`, `generate_config`, `verify_setup`, `check_updates`, `rollback_setup` on the MCP SDK (stdio), every output validated by the shared schemas and carrying `catalogVersion`; signed-catalog verification with the embedded public key; fixture projects (`next-fresh`, `next-existing`, `next-monorepo`, `next-blocked`, `not-next`) and a signed fixture catalog.

Acceptance:

- [x] All tools pass against fixture Next.js projects: fresh app, existing config, monorepo, blocked item installed (and the unsupported-stack path).
- [x] `generate_config` never changes content outside the managed block (test + snapshot tests of generated files).
- [x] Recommendation output is identical across two runs (byte comparison, also through the MCP server).

Tests: unit tests per tool, snapshot tests of generated `CLAUDE.md` / `.mcp.json` / `settings.json`, a 300-case randomised property test that merges never drop unknown `.mcp.json` servers, byte-exact rollback, tampered catalog / wrong key / tampered cache rejection, verify with working, broken, missing-env and duplicate-tool servers, end-to-end journey through an MCP client, tool definitions under 2,000 tokens. 431 tests total.

## Open questions

- None.
