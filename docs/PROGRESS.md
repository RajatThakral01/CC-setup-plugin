# Progress

## Current state

- **Session range:** Milestones 0–3 (owner-approved 2026-10-19).
- **Current milestone:** 3 — Discovery jobs.
- **Total Anthropic API spend to date:** USD 0.00 (no API calls yet).

## Milestones

| #   | Milestone                   | Status | Commit |
| --- | --------------------------- | ------ | ------ |
| 0   | Repo and tooling            | Done   | M0     |
| 1   | Shared schemas and database | Done   | M1     |
| 2   | Seed catalog importer       | Done   | M2     |
| 3   | Discovery jobs              | Next   |        |
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

## Open questions

- None.
