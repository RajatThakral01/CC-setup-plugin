# cc-setup-agent

A Claude Code plugin that recommends, generates and verifies an evidence-backed Claude Code setup for a project. MVP = Phase 1: Next.js stack only, local-first, hosting-ready.

## Source of truth

- `docs/PRD.md` — product requirements (IDs like FR-D1, NFR-5 refer here).
- `docs/IMPLEMENTATION_PLAN.md` — how to build it, milestone by milestone. Wins on implementation detail; PRD wins on product behaviour.
- `docs/PROGRESS.md` — what is done, current milestone, open questions. **Read it at the start of every session.**
- `docs/DECISIONS.md` — choices made and Claude Code features verified (with version).

If the PRD and plan are both silent on product behaviour, ask the owner. Don't guess.

## Session workflow

The owner sets a **milestone range** for each session (for example "Milestones 0–3"). Work through that range continuously, without waiting for approval between milestones.

1. Read `docs/PROGRESS.md`; start at the current milestone and stay inside the agreed range.
2. Before the first milestone of the range: scan every milestone in it and ask the owner, in **one single batch**, every question and input you can foresee (tokens, seed lists, decisions). Proposals that need approval (for example seed URLs found by search) go in that batch too.
3. Build each milestone in order, with tests alongside the code.
4. Finish each milestone properly before starting the next: all its acceptance criteria met, `pnpm typecheck && pnpm lint && pnpm test` green, `docs/PROGRESS.md` updated, one commit `M<n>: <summary>`.
5. At the end of the range: report what was built per milestone, test results, decisions made, deviations from the plan, and what the next milestone needs from the owner. Ask whether to continue, then stop.

Only stop mid-range to ask the owner when:

- a decision only the owner can make is needed (product behaviour the PRD and plan don't cover, a paid service, a dependency with real trade-offs, deleting data);
- you need something from the owner (keys or tokens in `.env`, the seed list, Docker not running);
- a milestone's tests still fail after several genuine attempts to fix them.

Every other choice: decide, record it in `docs/DECISIONS.md`, keep going. Never go past the agreed range.

## Commands

- `pnpm install` / `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test`
- `docker compose up -d` — local Postgres
- `pnpm db:migrate` — apply Drizzle migrations
- `pnpm pipeline <cmd>` — seed, discover, gates, snapshot, worker
- `pnpm triage` — local triage UI
- `pnpm evals run` — real eval runs (costs money; only when the owner asks)
- `pnpm db:health` — check the database connection
- `pnpm check:models` — fail if any file names an Opus model ID
- `pnpm keys:generate --out <dir outside repo>` — Ed25519 snapshot signing keys

(Add new scripts here when you create them.)

## Hard rules

- **Product API models:** the product's own Anthropic API calls (classification, evals) use only Haiku and Sonnet, via `MODEL_FAST` / `MODEL_STRONG` config. Never Opus in product code or config. This does not restrict the model running this session.
- **Budget:** every Anthropic API call goes through the budget ledger; USD 20/week hard cap.
- **No invented catalog data:** tool names, URLs, versions and metrics come from real API responses or the owner. Test fixtures use obviously fake names under `test/fixtures/`.
- **Never set `recommended` in code.** Only a human action in triage does that, via `transitionStatus`.
- **Secrets:** read from env, validated by zod at startup. Never commit, log or print them. Never read `.env` or key files.
- **Verify Claude Code specifics** (plugin layout, manifest, `.mcp.json`, settings keys, hooks, `claude -p` flags) against current official docs / `claude --help` before coding against them; record in `docs/DECISIONS.md`.
- **Portability:** no absolute paths, hosts or OS-specific commands in app code; everything from config. Storage behind `SnapshotStore` / `ArtifactStore`.
- **Plugin isolation:** `apps/plugin` must not import `packages/db` or `apps/pipeline`.
- CI never calls live or paid APIs; use recorded fixtures and mocks.

## Code conventions

- TypeScript strict, ES modules, no `any` (use `unknown` + zod).
- zod schemas live in `packages/shared`; derive types from them.
- External data is validated at the boundary before use.
- Errors: typed error classes; never swallow errors silently; log with pino (JSON), no `console.log` in app code.
- Small pure functions for job logic; thin wrappers for pg-boss, CLI and HTTP.
- Tests with vitest next to the code (`*.test.ts`).

## Don't

- Add dependencies without a one-line reason in `docs/DECISIONS.md`.
- Build Phase 2 features (see plan section 12.2).
- Push to remote, change CI secrets, or run real evals unless the owner asks.
