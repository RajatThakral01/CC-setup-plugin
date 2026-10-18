# Progress

## Current state

- **Session range:** Milestones 0–3 (owner-approved 2026-10-19).
- **Current milestone:** 1 — Shared schemas and database.
- **Total Anthropic API spend to date:** USD 0.00 (no API calls yet).

## Milestones

| #   | Milestone                   | Status | Commit |
| --- | --------------------------- | ------ | ------ |
| 0   | Repo and tooling            | Done   | M0     |
| 1   | Shared schemas and database | Next   |        |
| 2   | Seed catalog importer       |        |        |
| 3   | Discovery jobs              |        |        |
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

## Open questions

- None.
