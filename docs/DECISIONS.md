# Decisions

Choices not fully covered by the PRD or plan, with reasons. Newest milestone at the bottom of each section.

## Owner decisions (2026-10-19)

- **Session workflow:** owner sets a milestone range per session (first range: M0–M3); questions batched up front; one commit per milestone. Recorded in `CLAUDE.md` and plan 1.2 rule 1.
- **Categories:** added `auth`, `payments`, `email`, `cms` to the 10 starting categories. Stripe → payments; Clerk, Auth0, WorkOS → auth; Resend → email; Sanity, Contentful → cms.
- **Seed list:** 117 proposed entries approved (all except `anthropics/claude-code-action`, which is a GitHub Action, not a setup item).
- **Discovery sources (FR-D5):** the 7 structured `marketplace.json` files (Anthropic official, `anthropics/claude-code`, `anthropics/skills`, Vercel, Sentry, Grafana) plus the MCP Registry (FR-D2). Excluded for now: Anthropic community marketplace, awesome-lists, npm search, README scraping.
- **Candidate intake filter (amends FR-D10):** every raw record is stored; a record becomes a `candidate` only if: not a fork, not archived, has a licence and description, ≥ 10 stars. Registry entries must be the latest version and have a repo URL. Repos owned by orgs in `catalog/vendors.yaml` and MCP Registry verified publishers skip the star threshold. At most 30 new candidates per day, priority: vendor-allowlisted, then star velocity, then stars. Stored raw records are re-checked daily. PRD FR-D10 updated.
- **Budget:** weekly cap `WEEKLY_BUDGET_USD=20` (classification share `BUDGET_SPLIT_CLASSIFY_USD=3`) **and** a whole-build cap `TOTAL_BUDGET_USD=40` across all weeks and purposes; warn in logs and reports above `TOTAL_BUDGET_WARN_USD=30`; hard stop at 40. The ledger enforces both. Total spend to date goes in every milestone report.
- **Git/CI:** local git only, one commit per milestone, never push. CI workflow is written and proven locally; the owner pushes to a private GitHub repo.
- **Node 24, Postgres on host port 5433, `claude_code_changes` table, folder-level catalog items, classifying seed items in M3:** approved.

## Milestone 0

- **Docs location:** PRD and plan moved from the repo root into `docs/PRD.md` and `docs/IMPLEMENTATION_PLAN.md`.
- **Node 24 LTS** (plan said 22.x): installed version and current Active LTS in Oct 2026. `engines.node >=24`, `.nvmrc` = 24.
- **pnpm 12.14.0 via corepack**, pinned in `packageManager`. esbuild's install script allowed via `allowBuilds` in `pnpm-workspace.yaml` (needed by tsx and vitest).
- **TypeScript 6.0.3, not 7.0:** `typescript-eslint` 8.71 supports `typescript <6.1`; TS 7 (native port) has no JS API for it yet.
- **Package resolution:** each workspace package exports `source` → `src/index.ts` and `default` → `dist/index.js`. TS (`customConditions`), vitest and tsx (`--conditions=source`) read sources directly, so dev needs no build; `tsc -b` emits `dist/` for hosted runs.
- **`pnpm typecheck` = `tsc -b`:** project references can't be combined with `--noEmit`; output lands in gitignored `dist/`.
- **Test files are type-checked** through `tsconfig.tooling.json`, which also covers `scripts/`.
- **Config schema lives in `packages/shared`** (convention: zod schemas in shared); the loader (`.env` lookup, `requireSecret`, `assertModelAllowed`) lives in `packages/core` (plan section 5).
- **Secrets are optional at parse time** and required per command via `requireSecret()`, so e.g. the DB health check doesn't need `ANTHROPIC_API_KEY`. Error messages name variables only, never values (tested).
- **`DATABASE_URL` has a default** equal to the docker-compose dev URL (credentials `setup/setup` are already committed in `docker-compose.yml`, so not a real secret). Hosted deployments override it.
- **`.env` loading:** `loadConfig()` uses Node's built-in `process.loadEnvFile` on the nearest `.env` up from cwd (or `ENV_FILE`). Real environment variables win. No dotenv dependency.
- **Postgres host port** configurable via `POSTGRES_HOST_PORT` (default 5433) because the owner's machine already runs Postgres on 5432. Compose project named `cc-setup-agent`.
- **Opus guard has three layers:** zod refuses any model ID matching `/opus/i` in `MODEL_*`, `ALLOWED_MODELS` and pricing keys; `assertModelAllowed()` re-checks before every call; `pnpm check:models` scans the repo for Opus model IDs (test files exempt, as they prove refusal) and runs in CI.
- **HTTP client:** native `fetch`, retries on network errors/408/429/5xx and GitHub 403-with-exhausted-rate-limit; honours `Retry-After` and `x-ratelimit-reset`; exponential backoff with full jitter; per-host minimum spacing from `HTTP_HOST_RATE_LIMITS_JSON`. `fetch`, `sleep`, clock and random are injectable, so tests need **no HTTP mocking library** (nock/msw not added).
- **Lint:** ESLint flat config with `typescript-eslint` recommended (not type-aware, for speed) + Prettier check. `no-console` in app code, `no-explicit-any`, and an import restriction stopping `apps/plugin` from importing `packages/db` or `apps/pipeline`.
- **Secret scan in CI:** `gitleaks/gitleaks-action@v2` as a separate job.

### Model prices (verified 2026-10-19)

Source: https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-19). USD per million tokens:

| Model                              | Input | 5m cache write | 1h cache write | Cache read | Output |
| ---------------------------------- | ----- | -------------- | -------------- | ---------- | ------ |
| `claude-haiku-5-5` (prompt ≤ 100K) | 0.10  | 0.125          | 0.20           | 0.01       | 0.50   |
| `claude-haiku-5-5` (prompt > 100K) | 0.50  | 0.625          | 1.00           | 0.05       | 2.50   |
| `claude-sonnet-5-5`                | 2.00  | 2.50           | 4.00           | 0.10       | 10.00  |

Defaults in `packages/shared/src/config.ts`; override with `MODEL_PRICING_JSON`. Prompt caching minimum for both models: 512 tokens (Claude API skill reference, 2026-10-06).

### Claude Code specifics (verified against Claude Code 2.1.302 and code.claude.com/docs, 2026-10-19)

**Plugin layout** (docs: `plugins/manifest-reference`, `plugins/components`)

- Manifest at `.claude-plugin/plugin.json` (optional); all other files at the plugin root, not inside `.claude-plugin/`.
- Default component locations: `skills/<name>/SKILL.md`, `commands/*.md` (still supported; docs say "Prefer `skills/` for new plugins"), `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `bin/`.
- `plugin.json`: only `name` is required (kebab-case). Optional: `version` (validator warns if missing), `description`, `author {name, email?, url?}`, `homepage`, `repository`, `license`, `keywords`, component path keys (`skills`, `commands`, `agents`, `hooks`, `mcpServers`), and more.
- Bundled MCP servers: root `.mcp.json` or inline `mcpServers` in `plugin.json`.
- Variables: `${CLAUDE_PLUGIN_ROOT}` (install dir; changes on update; don't store state), `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, persists across updates; **use for the synced catalog**), `${CLAUDE_PROJECT_DIR}`. They resolve in MCP `command`/`args`/`env` and hook commands, not in Bash-tool commands.
- Local marketplace: `.claude-plugin/marketplace.json` with required `name`, `owner {name}`, `plugins[]` (each `name` + `source`; relative sources start with `./`). Install: `claude plugin marketplace add <path>` then `claude plugin install <plugin>@<marketplace>`. Validate: `claude plugin validate <path> [--strict]`.

**Project `.mcp.json`** (docs: `mcp`)

- Top-level `mcpServers`. stdio: `type: "stdio"` (default when omitted), `command`, `args`, `env`. Remote: `type: "http"` (alias `streamable-http`), `url`, `headers`; SSE deprecated.
- Env expansion `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers`.
- `claude -p` loads project servers without the approval prompt.

**`.claude/settings.json`** (docs: `settings`, `permissions`, `hooks`)

- Schema reference used in official examples: `https://json.schemastore.org/claude-code-settings.json` (third-party hosted; may lag the CLI).
- Precedence: managed > `--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`.
- `permissions`: `allow`, `ask`, `deny`, `defaultMode`; evaluated deny → ask → allow. Rules like `Bash(npm run *)`, `Read(./.env)`, `WebFetch(domain:x)`, `mcp__<server>__<tool>`.
- `hooks`: `{ "<Event>": [{ "matcher": "...", "hooks": [{ "type": "command", "command": "...", "timeout": 60 }] }] }`. Events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `PreCompact`, `SessionEnd`. Exit 2 blocks.
- Also `env`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers`.

**Skills** (docs: `skills`): `<plugin>/skills/<name>/SKILL.md`, invoked as `/plugin:skill`; frontmatter fields all optional (`description` recommended; also `name`, `argument-hint`, `disable-model-invocation`, `allowed-tools`, `model`, …). Custom commands have been merged into skills.

**Headless** (docs: `headless`, `cli-reference`; local `claude --help`): confirmed `-p`, `--model`, `--output-format text|json|stream-json`, `--mcp-config`, `--strict-mcp-config`, `--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`, `--max-budget-usd`, `--bare`. JSON output documents `result`, `session_id`, `total_cost_usd` (client-side estimate), `usage`, `modelUsage`, `subtype`.

**Still unverified (check in M8/M9 before relying on them):** `--max-turns` is in the CLI reference but not in local `--help`; JSON fields `num_turns`, `duration_ms`, `is_error`; exact value formats of `enabledMcpjsonServers` / `enableAllProjectMcpServers`.

## Milestone 1

- **`kind` and `category` are nullable** in `catalog_items`: GitHub-search candidates have neither until classification. Seed hints (owner-approved `kind`/`category` in `catalog/seed.yaml`) fill them at import; classification fills only fields that are still null, so owner hints win.
- **Extra columns beyond plan section 6:** `catalog_items.description`, `catalog_items.supersedes` (PRD 11.1 has it), `catalog_items.classification_state` (`pending` / `classified` / `needs_manual_classification`, from plan M3), `scorecards.id`/`updated_at`, `eval_runs.created_at`, `budget_ledger.cache_write_tokens`/`cache_read_tokens` (needed for exact cost).
- **`claude_code_changes` table** (owner-approved): `source`, `external_id`, `version`, `title`, `body`, `flags[]`, `url`, `published_at`; unique on (`source`, `external_id`).
- **Enums as Postgres enums** generated from the arrays in `packages/shared/src/enums.ts`; adding a value means a new migration.
- **`source` enum:** `github_repo`, `npm_package`, `mcp_registry`, `marketplace`, `claude_code_changelog`, `claude_code_release`. A seed import stores raw records under `github_repo` / `npm_package`, so seed and discovery dedupe on the same keys.
- **`capability` enum:** `shell`, `file_read`, `file_write`, `network`, `browser`, `database`, `code_execution`.
- **Status transitions** (`packages/shared/src/status.ts`):
  - candidate → watchlist, recommended_provisional\*, recommended\*, blocked, rejected
  - watchlist → candidate, recommended_provisional\*, recommended\*, deprecated, blocked, rejected
  - recommended_provisional → recommended\*, watchlist, deprecated, blocked, rejected
  - recommended → recommended_provisional\*, watchlist, deprecated, blocked
  - deprecated → candidate, watchlist, blocked
  - blocked → candidate (human only: unblocking needs review)
  - rejected → candidate (e.g. a new release fixes hygiene), blocked
  - \* human actor (`human:<name>`) required. Same-status "transitions" and empty reasons are refused.
- **Item creation is logged** as a `status_events` row with `from_status = null`, via `insertCandidate()`, which always forces `status = 'candidate'`.
- **Budget ledger enforces three limits; the tightest wins:** the purpose's weekly share (classify = `BUDGET_SPLIT_CLASSIFY_USD`, eval = weekly − classify), the overall weekly cap, and the total cap across all weeks. `assertBudget()` is the pre-flight check (throws `BudgetExceededError`), `recordSpend()` writes the row after the call and warns past `TOTAL_BUDGET_WARN_USD`. Weeks are ISO weeks starting Monday 00:00 UTC, stored as the Monday's date.
- **Costs** are rounded to 6 decimals (`numeric(12,6)`); a recorded cost from the API/CLI takes precedence over computed cost.
- **DB tests** create a fresh, migrated database per test file (`createTestDatabase()` in `@cc-setup-agent/db/testing`) and drop it afterwards, so files run in parallel and every run proves migrations apply to an empty database. Base URL: `TEST_DATABASE_URL`, else `DATABASE_URL`.
- **MCP tool I/O schemas** are defined now (plan M1) and may be refined in M7; outputs use relative paths only and env var names only.

## Milestone 2

- **`pnpm run pipeline <cmd>`** instead of `pnpm pipeline`: pnpm 12 ships a built-in `pipeline` command that shadows the script. CLAUDE.md updated.
- **No `@octokit/rest`** (plan section 3 named it): GitHub calls go through the shared HTTP client, which already handles retries, `Retry-After`/`x-ratelimit-reset` and per-host spacing, and validates every response with zod at the boundary. One retry/rate-limit path, one fewer dependency. Revisit if we need GraphQL or pagination helpers.
- **Seed file format:** `source_url` + optional `note`, plus optional owner-approved `kind`/`category` hints (the approved list included them, with the auth/payments/email/cms re-filing). Hints are written at import; classification never overrides them.
- **Canonical source URLs** come from the GitHub API response (`full_name`), so renamed repos dedupe correctly; folder items use `https://github.com/<full_name>/tree/<ref>/<path>`. Duplicate checks compare source URLs case-insensitively and package names exactly (FR-D8).
- **Raw record keys:** GitHub repo → numeric repo `id` (stable across renames); folder item → `<repo id>:<ref>/<path>`; npm → package name. npm packuments are trimmed (latest manifest, dist-tags, timestamps, repository, licence) because full packuments list every version.
- **Skip rules:** 404 (repo, folder or package) → `not_found`; archived repo, or npm package whose GitHub repo is archived → `archived`; npm latest version deprecated → `deprecated`; existing item → `duplicate`. Other errors → `failed`; the run continues and exits non-zero.
- **Item ids:** `<owner>-<repo>` for repos, `<owner>-<repo>-<folder>` for folders, scope + name for npm packages; `-2`, `-3`… on collision.
- **Live import (2026-10-19):** 117 created, 0 skipped, 0 failed; second run 0 created, 117 duplicates.

## Dependencies

One line each: why it was added.

- `typescript` 6.0 — strict TS everywhere (plan section 3).
- `@types/node` — Node built-in types.
- `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier` — linting (plan section 3).
- `prettier` — formatting (plan section 3).
- `vitest` — tests (plan section 3).
- `tsx` — run TypeScript scripts and CLIs without a build step.
- `zod` — validation of config and all external data (plan section 3).
- `pino` — JSON logging (plan section 3).
- `pg`, `@types/pg` — Postgres driver (used by Drizzle from M1; DB health check in M0).
- `drizzle-orm` — ORM and migrator (plan section 3).
- `drizzle-kit` (dev) — generates SQL migrations from the schema (plan section 3).
- `yaml` — parse `catalog/seed.yaml` (and later `sources.yaml`, `vendors.yaml`).
