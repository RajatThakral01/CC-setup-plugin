# Progress

## Current state

- **Session range:** Milestones 0–3 (owner-approved 2026-10-19).
- **Current milestone:** 4 — Credibility gates 0 to 3 (not started; session range 0–3 complete, awaiting owner).
- **Total Anthropic API spend to date:** USD 0.0313 (148 Haiku classification calls, 2026-10-19). Weekly cap USD 20, total cap USD 40.

## Milestones

| #   | Milestone                   | Status | Commit |
| --- | --------------------------- | ------ | ------ |
| 0   | Repo and tooling            | Done   | M0     |
| 1   | Shared schemas and database | Done   | M1     |
| 2   | Seed catalog importer       | Done   | M2     |
| 3   | Discovery jobs              | Done   | M3     |
| 4   | Credibility gates 0 to 3    |        |        |
| 5   | Triage UI                   |        |        |
| 6   | Signed catalog snapshot     |        |        |
| 7   | Plugin MCP server           |        |        |
| 8   | Plugin packaging            |        |        |
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

## Open questions

- **Registry "verified publishers":** the Registry exposes no such flag; only namespaces listed in `catalog/vendors.yaml` skip the star threshold for now (see DECISIONS M3).
- **Vendor-first priority** lets Anthropic's ~50 in-repo marketplace plugins (incl. non-Next.js ones like language LSPs) take the first days' 30 slots; 1,300 records are deferred. Consider adding stack relevance to intake priority.
