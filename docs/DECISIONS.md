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
