# Decisions

Choices not fully covered by the PRD or plan, with reasons. Newest milestone at the bottom of each section.

## Owner decisions (2026-10-19)

- **Session workflow:** owner sets a milestone range per session (first range: M0–M3); questions batched up front; one commit per milestone. Recorded in `CLAUDE.md` and plan 1.2 rule 1.
- **Categories:** added `auth`, `payments`, `email`, `cms` to the 10 starting categories. Stripe → payments; Clerk, Auth0, WorkOS → auth; Resend → email; Sanity, Contentful → cms.
- **Seed list:** 117 proposed entries approved (all except `anthropics/claude-code-action`, which is a GitHub Action, not a setup item).
- **Discovery sources (FR-D5):** the structured `marketplace.json` files of Anthropic official, `anthropics/claude-code`, `anthropics/skills`, Vercel, Sentry and Grafana (six; the batch question said "7" but named these six, the seventh in the research file being the excluded community marketplace), plus the MCP Registry (FR-D2). Excluded for now: Anthropic community marketplace, awesome-lists, npm search, README scraping.
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

## Milestone 3

**Sources (verified live 2026-10-19)**

- **MCP Registry:** `GET {MCP_REGISTRY_URL}/servers?updated_since=…&limit=100&version=latest&cursor=…` (`https://registry.modelcontextprotocol.io/v0.1`). Response `{servers: [{server, _meta: {"io.modelcontextprotocol.registry/official": {isLatest, status, updatedAt…}}}], metadata: {nextCursor}}`. Volume is high: ~1,200 latest servers updated in one day, 6,000+ in a week, ~60% with a repo URL. External id = server `name`; `version=latest` keeps one record per server.
- **"Verified publisher" in the Registry:** the API has no such flag. Every namespace is ownership-verified (`io.github.<user>` via GitHub login, reverse-DNS via domain), so "verified" would include anyone with a domain. Decision: only namespaces listed in `catalog/vendors.yaml` → `registry_namespaces` skip the star threshold (empty for now). **Owner may want to change this.**
- **Repo facts via GitHub GraphQL**, 50 repos per query (`repository(owner,name)` aliases with variables), instead of one REST call per repo. Missing repos come back `null` with `NOT_FOUND` errors. ~6,000 Registry entries cost ~80 GraphQL queries.
- **GitHub search (FR-D3):** `topic:<t> pushed:>=<now−7d>` for each of `mcp-server`, `claude-code`, `claude-skills`, `claude-code-plugin`, sorted by updated, 100 per page, up to 10 pages (search returns at most 1,000), 2.5 s between calls (search limit 30/min). Always a fixed 7-day window, so repeated sightings update star velocity. Raw records share the `github_repo` key (repo id) with seed records.
- **Marketplaces (FR-D5):** `catalog/sources.yaml` lists the six approved `marketplace.json` URLs. Plugin `source` forms handled: relative path (`./plugins/x`, with optional `metadata.pluginRoot`), `{source: "github", repo}`, `{source: "url", url}`, `{source: "git-subdir", url, path, ref}`; `npm` and others resolve to no repo and are filtered. External id `<marketplace name>:<plugin name>`. Several plugins pointing at one repo root (e.g. `anthropics/skills`) collapse into one entity.
- **Changelog (FR-D1):** `CHANGELOG.md` from `{GITHUB_RAW_URL}/{CLAUDE_CODE_REPO}/main/` split on `## <version>`, newest `CHANGELOG_MAX_VERSIONS` (30), plus GitHub releases. Flags: `plugins`, `mcp`, `settings`, `hooks`, `skills`, `models`. Stored in `claude_code_changes`, never as catalog items.
- **All endpoints come from config** (`GITHUB_API_URL`, `GITHUB_RAW_URL`, `NPM_REGISTRY_URL`, `MCP_REGISTRY_URL`, `CLAUDE_CODE_REPO`); the M2 clients were changed to take base URLs.

**Intake (PRD FR-D10)**

- **Raw record columns added:** `intake_state` (`pending` / `accepted` / `linked` / `filtered` / `deferred` / `not_applicable`), `intake_reasons[]`, `intake_checked_at`, `stars`, `stars_checked_at`, `star_velocity_7d`. Migration `0001` also marks existing seed records `linked` and the npm-backing repos `not_applicable`.
- **Licence:** any detected licence counts, including GitHub's `NOASSERTION` ("Other"). **Description:** the source's description, else the repo's.
- **Records without a GitHub repo** (remote-only Registry servers, non-GitHub hosts, npm-only plugins) are filtered (`no_repo_url` / `repo_unavailable`), since stars, licence and fork status can't be checked.
- **Star velocity** = stars gained per 7 days since the last observation at least a day old; with no history, the lifetime average since repo creation (at least one week). Used for intake priority and written to `signal_snapshots` for linked items.
- **Daily cap** counts `status_events` creation rows with reason `discovery intake…` since UTC midnight; candidates over the cap become `deferred` and compete again the next day.
- **Daily re-check:** `filtered`/`deferred` records are re-evaluated every run from stored data; up to `INTAKE_REFRESH_LIMIT` (200) records filtered only for stars, not refreshed in 20 h, get fresh repo facts via GraphQL.
- **Dedupe (FR-D8):** canonical source URL (case-insensitive) or package name; matches become `linked` to the existing item. Within a run, the first passing record creates the item and later ones link to it.
- **`catalog/vendors.yaml`** created now (plan had it in M4) because the intake exception needs it: 57 GitHub orgs taken from the owner-approved seed entries verified as official or vendor-published, plus `anthropics`. Owner-maintained from here on.

**Classification (FR-D9)**

- **LLM client in `packages/core`** requires a `BudgetGuard`; `packages/db` provides the ledger-backed guard, so no Anthropic call can bypass the ledger. Order per call: model allow-list check → budget pre-flight (conservative estimate: ~3 chars/token + `max_tokens`) → API call → ledger row with actual usage (always, even if the output is unusable).
- **Request shape (verified live, `claude-haiku-5-5`):** `messages.create` with `system` as a cached text block (`cache_control: ephemeral`), `thinking: {type: "disabled"}`, `output_config: {effort: "low", format: {type: "json_schema", schema}}`. The schema comes from zod via `z.toJSONSchema`, with keywords structured outputs reject (`maxItems`, `maxLength`, `minimum`, `pattern`, …) stripped; zod still validates the full constraints. First live call: 785 input + 1,709 cache-write + 104 output tokens = USD 0.000344.
- **Not `messages.parse`:** `create` + our own zod parse guarantees usage is recorded even when parsing fails.
- **Output:** `kind`, `category` (nullable), `stacks` (from `nextjs`, `react`, `node`, `python`, `any`), `summary`, `provenance_guess`, plus `relevant` (false for apps, SDKs, demos — useful in triage). Prompt version `classify-v1`. README excerpt ≤ 4,000 chars inside a `<tool>` block marked as untrusted data.
- **Retry once** on invalid output or refusal, then `needs_manual_classification`. Budget exhaustion stops the run and leaves items `pending` (queued). Three consecutive API errors also stop it.
- **Fields applied only when empty**, so owner seed hints win; classification is always stored in full.

**Scheduling and operations**

- **pg-boss 12** queue `discovery-daily`, `schedule(…, DISCOVERY_CRON = "0 2 * * *", {}, {tz: "UTC"})`; `pnpm run pipeline worker` runs it. The job is discover → intake → classify; each stage runs even if a source failed.
- **`source_runs` table** records start, end, status, record count and error per source, for NFR-4 and the PRD 17.1 "source failing for 24 h" alert later.
- **CLI:** `discover [--source …] [--no-intake] [--no-classify]`, `intake`, `classify [--limit n]`, `worker`, `spend`.
- **`@cc-setup-agent/db` re-exports drizzle operators:** pg-boss pulled in a peer that created a second `drizzle-orm` copy, which broke types when the pipeline imported drizzle directly.
- **Contract fixtures** (`test/fixtures/sources/`) keep the exact structure of real responses recorded on 2026-10-19, with names replaced by `example-*` per the fixture rule.

## After Milestone 3 (owner decisions, 2026-10-19)

- **Git remote:** `origin` = https://github.com/RajatThakral01/CC-setup-plugin, owner's existing credentials (no tokens in the URL). Push after every milestone commit; never force-push or rewrite pushed history. CLAUDE.md updated.
- **Classification separated from the triage cap:** up to `CLASSIFY_DAILY_RECORD_LIMIT` (300) filter-passing raw records are classified per UTC day, within the classification budget, before ranking. Order of classification = the current ranking (so the most promising go first). Results are stored on the raw record (`classification`, `classified_at`) and copied into the item when it is accepted, so nothing is classified twice. A failed classification still counts against the daily limit.
- **Daily-cap priority:** Next.js-relevant first, then vendor-allowlisted, then star velocity, then stars. "Next.js-relevant" = classification `relevant: true` and stacks include `nextjs`, `react` or `any` (`isNextjsRelevant` in `packages/shared`). Records not yet classified with the current prompt rank between relevant and irrelevant ones.
- **Out of scope:** new `catalog_items.out_of_scope` (stack list). Intake-created items that aren't Next.js-relevant get `['nextjs']`; never deleted or rejected; the triage queue (M5) hides them by default with a filter to show them. Owner-seeded items are never auto-scoped (the owner approved them for Next.js).
- **Prompt `classify-v2`:** `any` only for genuinely stack-independent tools also useful in a TypeScript web project; tools tied to another language or platform get only their own tag or none. All 147 items re-classified (`classify --stale`, USD 0.031): 10 intake items marked out of scope (language servers, math plugins, iMessage, etc.). On re-classification, seeded items only get empty fields filled; intake items also get fields that still hold the previous classification's value replaced.
- **Registry namespaces:** owner agrees with the stricter reading; `registry_namespaces` stays empty. `catalog/vendors.yaml` approved as is.

## Milestone 4

**Sandbox rules (owner decision 2026-10-19), enforced in code**

Every container that runs third-party code is started through `buildRunArgs()` and checked by `assertSandboxPolicy()` (`apps/pipeline/src/gates/sandbox/policy.ts`) immediately before `docker run`. The check is a strict allowlist: any flag not listed is refused. Rules:

1. **Images:** only the configured official images, pinned as `<name>:<tag>@sha256:<digest>`. Config validation accepts only `node` and `python` from Docker Hub's official library. Pinned 2026-10-19: `node:22-bookworm-slim@sha256:c3de60bf…78392`, `python:3.13-slim-bookworm@sha256:a1165e27…4d641` (3.13, not 3.12, because some servers require it).
2. **Mounts:** at most one, `<throwaway temp dir>:/work`, where the temp dir is created per run under the OS temp root with prefix `ccsa-sandbox-` and deleted afterwards. `--mount`, `--volumes-from` and anything else are refused.
3. **No secrets:** `-e` only as `NAME=value` with `NAME` in a small allowlist (proxy, npm/pip/uv cache settings, `HOME`). `-e NAME` without a value (which would copy the host variable) and credential-looking values are refused. `--env-file` is refused.
4. **Least privilege:** `--user 1000:1000` (root refused), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root with a small `noexec` tmpfs on `/tmp`.
5. **Limits:** `--cpus` (`GATE_CPUS`, 1), `--memory` (`GATE_MEMORY_MB`, 1024), `--pids-limit` (`GATE_PIDS_LIMIT`, 256), a wall-clock limit (install 180 s + listTools 30 s + 15 s), after which the container is force-removed.
6. **Network and egress:** each run gets its own `docker network create --internal` network. The target container sits only on that network; the only way out is an egress-logging HTTP/CONNECT proxy (our own script in the pinned node image) that is also attached to the default bridge. Every connection through it is logged (host, port, time) and split into install versus runtime (after the MCP `initialize` answer). Connections that ignore the proxy have no route and fail (tested), so they are blocked but cannot be logged.
7. **Always removed:** containers use `--rm`, carry label `ccsa.sandbox=<run id>`, and are force-removed together with the network in a `finally` block; each gate run also sweeps leftovers with that label first. Tested with real Docker: after success, a never-starting server (timeout) and a poisoned server, no containers or networks remain.
8. **Fixed platform:** `--platform` is required, from `GATE_PLATFORM` (default `linux/amd64`, emulated on Apple Silicon), so results don't depend on the host CPU (in the spirit of FR-E5 pinning).
9. **Boundary test:** a test scans all source files and fails if anything outside `gates/sandbox/` spawns Docker or MCP stdio servers.
10. **Real-Docker tests** (`SANDBOX_TESTS=1`, set in CI) run only dependency-free fixture servers; nothing is installed from the internet in CI.

**Gates**

- **Install resolution (FR-G6, exact versions):** MCP server → item npm package → Registry packages (npm, then PyPI, with env var names) → Registry remote → a package published from the repo, trusted only if its npm `repository` points back at the same repo (blocks name squatting) → `pyproject.toml` `[project] name` on PyPI. Skills → `skill_copy`, marketplace plugins → `plugin`, others → `manual`. Values that go into the sandbox shell must match strict name/version patterns and are single-quoted.
- **Scorecard version:** package version, Registry version for remotes, else latest release tag, else `sha-<7 chars>` of the default branch head. The scored version is pinned in `item_versions`.
- **Gate 0 (hard, → `rejected`):**
  - **Licence:** from the repo, any LICENSE/COPYING file in the item's tree (skill collections keep them per folder), `license:` in SKILL.md frontmatter, or the package.
  - **README ≥ 200 characters:** folder items without their own README fall back to the collection's README.
  - **Real code:** not a fork, not empty.
  - **Installable artifact:**
    - MCP servers need an npm/PyPI package, a remote endpoint, or a GitHub release (FR-C0's wording; covers Go binaries and Docker images we can't run).
    - Skills need a `SKILL.md` (case-insensitive).
    - Plugins need a `.claude-plugin/plugin.json` or `marketplace.json` in their tree, or a marketplace listing.
  - **Installs and starts:** only a failed **install** (package can't be resolved or downloaded: unsatisfiable dependencies, missing version, 404) is a hard failure. A server that installs but won't start without credentials, arguments or a different entry point gets "start not verified" (soft). This is a deliberate softening of "installs and starts": the first live run hard-rejected official servers (Brave, Perplexity, Resend, Upstash, Storybook…) only because they need an API key or were invoked with default arguments.
  - **Remote servers:** probed over HTTP from the host without credentials; 401/403 means "needs credentials" (soft).
- **Package lookup by repository:** when an MCP server has no linked Registry record and no package at the repo root (monorepos), the MCP Registry is searched by repo name and matched on the exact repository URL (and subfolder) before falling back.
- **System rejections are lifted** when a later gate-0 check passes (rejected → candidate, actor `system`); rejections by a human are never undone automatically.
- **Gate 1 (soft):** `anthropic` if the owner is `anthropics`, `official_vendor` if in `catalog/vendors.yaml`, else `community`. Community passes with ≥ 3 other non-fork repos pushed within 180 days. Gate 1's provenance replaces the classifier's guess.
- **Gate 2 (soft):** last commit ≤ 90 days pass, otherwise soft-fail; over 180 days = abandoned → recommended items move to `watchlist`. Evidence: releases in 180 days, median first-response time over the last 20 issues, open issues, contributors, npm weekly downloads (single call; the trend itself is Phase 2 FR-D4). Written to `signal_snapshots`.
- **Gate 3:** tool names, descriptions and nested parameter descriptions; for skills, the first `SKILL.md`. Rules:
  - **Critical, confirmed → `blocked`:** "ignore/disregard … instructions", "do not tell the user", system-prompt override, Unicode tag characters (decoded into the evidence).
  - **High, flagged:** invisible or bidi characters, `<IMPORTANT>`-style tags, sensitive paths (`~/.ssh`, `.aws/credentials`, `.env`, …) with read/send verbs, runtime egress while listing tools.
  - **Medium:** "send … to http…", npm `preinstall`/`install`/`postinstall` scripts.
  - **Low:** descriptions over 1,000 characters, non-registry hosts during install.
  - **Result:** any high/critical → `fail` (flagged; approval needs a written override); medium → `soft_fail`.
  - **OSV:** the package at its pinned version plus up to 60 direct npm dependencies, each resolved to the highest published version matching its range (transitive dependencies not covered). Only high/critical vulnerabilities count for the gate; all are listed.
- **Runtime egress is flagged, not auto-blocked** (a server may legitimately call its own API at start-up); only confirmed injection auto-blocks.
- **Capabilities** are inferred from tool names and descriptions (approximate; shown for review). Context overhead = serialised tool definitions ÷ 4.
- **Confidence (FR-C6):** weights in `packages/shared/src/scoring.ts`: gate 0: 30, gate 1: 20, gate 2: 25, gate 3: 25 points for a pass (soft-fail and not-run earn less). ≥ 85 high, ≥ 55 medium. A failed gate 0 or gate 3 means low; gate 0 or gate 3 not run caps at medium.
- **Override:** `transitionStatus` refuses `recommended`/`recommended_provisional` when the latest scorecard's gate 3 failed, unless `overrideNote` is given; the note is appended to the audit reason.
- **Re-check (FR-C8):** pg-boss `gates-daily` at `GATES_CRON` (04:00 UTC) gates unscored items (in-scope first) and recommended items not checked for `GATE_RECHECK_DAYS` (30). New versions are picked up by that re-check (a new version yields a new scorecard row); a faster version trigger is left for later.
- **Custom export condition renamed** `source` → `@cc-setup-agent/source`: a dependency of the MCP SDK (`eventsource-parser`) publishes a `source` condition pointing at raw TypeScript.
- **`.env.example` not updated for the Python 3.13 image:** the project's `Read(./.env.*)` deny rule blocks edits to it. Its `GATE_PYTHON_IMAGE` line still names the 3.12 digest (a valid pinned image). The owner may want to update that line or delete it to use the code default.

## Milestone 5

- **Server:** Hono (`hono`, `@hono/node-server`), server-rendered HTML through `hono/html` (auto-escaping), no frontend framework (plan 2.2). Bound to `TRIAGE_HOST` (default `127.0.0.1`) and `TRIAGE_PORT` (4400). Run with `pnpm triage`.
- **Auth:** `TRIAGE_ADMIN_TOKEN` (min 16 characters, refused otherwise at startup). The sign-in form takes a reviewer name and the token (constant-time compare). The session cookie is `<name>.<HMAC-SHA256(name)>`, signed with the admin token: HttpOnly, SameSite=Strict, 12 h (Secure flag available for HTTPS hosting). The reviewer name becomes the audit actor `human:<name>`. Every non-GET request also needs a per-session CSRF token (HMAC). Unauthenticated GET → redirect to sign-in; POST → 401. Real identity (SSO) is left to hosting (plan 12.1).
- **Headers:** CSP `default-src 'none'` (inline styles only, no scripts), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. Links built from third-party data are rendered only if they are `https:` (blocks `javascript:` URLs).
- **Queue:** defaults to status `candidate` and scope "in scope for Next.js". Out-of-scope items are hidden, with a count and a filter (`out` / `all`), per the owner decision. Filters: status, scope, category, search.
- **Priority score:** provenance (Anthropic/vendor +3, community +1), gate 2 (pass +2, soft +1), confidence (high +3, medium +2), Next.js category gap (no recommended item in the category +3, one +1); failed gate 0 or gate 3 −5 (still listed). Ties: stars, then id.
- **Item page:** metadata, classifier summary and relevance, install, capabilities, context overhead, latest health snapshot, every gate with evidence links, eval placeholder (M9), audit log, raw source records. The status form offers only transitions allowed from the current status. A security-flagged item (gate 3 failed) shows a red panel with its high/critical findings and an extra "security override note" field; without the note the change is refused (409) by `transitionStatus`.
- **Scope toggle:** "mark in/out of scope for Next.js" updates `out_of_scope`. It isn't a status change, so it isn't in the status audit log.
- **Claude Code changes page:** changelog and release notes newest first, filterable by flag.

## Milestone 6

- **Catalog visibility and distribution are deferred (owner decision 2026-10-19).** The repo becomes private; snapshots are published with `SNAPSHOT_STORE=local` (now the default) into `SNAPSHOT_LOCAL_DIR` (default `.snapshots/`, gitignored). `GithubReleaseSnapshotStore` stays behind the `SnapshotStore` interface but refuses to publish (it needs a write token, which the owner chose not to provide). Nothing that needs a write token is implemented.
- **Signing key:** generated by the owner with `pnpm keys:generate`; the public half (`packages/shared/src/snapshot-public-key.ts`) is committed and embedded in the plugin. `publishSnapshot` refuses to publish if the private key's signature doesn't verify against that embedded public key, and explains a missing key file.
- **Published files:** `catalog-<version>.json` (pretty JSON + newline; the signature covers exactly these bytes), `catalog-<version>.json.sig` (detached Ed25519, base64), `catalog-<version>.json.sha256`, and `latest.json` (`{version, catalog, signature, sha256}`, written last). The plugin reads `latest.json` first.
- **Version:** `YYYY.MM.DD-N`, N counting snapshots already made that UTC day (from the `snapshots` table).
- **Contents:** items in `recommended`, `recommended_provisional`, `watchlist`, `deprecated`, `blocked`, each with its pinned version, install, capabilities, context overhead, scorecard summary (confidence, gates with evidence, count of high/critical findings) and eval summary. Sorted by id.
- **Schema relaxed for warning-only items:** `category` and `install` may be null and `stacks` empty for watchlist/deprecated/blocked items (needed so blocked items can still trigger warnings); recommended items must have all three. Items that fail the schema are skipped and listed in the report instead of breaking the snapshot.
- **`pnpm ci:status` on a private repo:** on 403/404 it exits with code 2 and a clear message (give `GITHUB_TOKEN` "Actions: read" on the repo, or check github.com) instead of being removed.

## Milestone 7

- **Plugin dependencies:** `@modelcontextprotocol/sdk` and `zod` only, plus `packages/shared` (no `packages/core`, `packages/db` or `apps/pipeline`; enforced by the ESLint import rule). Logging is a minimal JSON writer to stderr (stdout carries MCP).
- **Plugin settings from the environment** passed by the plugin's `.mcp.json`:
  - `PLUGIN_DATA_DIR` (`${CLAUDE_PLUGIN_DATA}`, falling back to `~/.cc-setup-agent`);
  - `CC_SETUP_AGENT_CATALOG_URL`, a folder URL holding `latest.json` (`file://` for the local store now, `https://` later);
  - `CC_SETUP_AGENT_CONTEXT_WARN_TOKENS` (default 15,000).

  Unexpanded `${…}` placeholders are treated as unset.

- **Catalog trust (NFR-5):** sync reads `latest.json`, downloads the catalog and its signature, checks the Ed25519 signature against the public key compiled into the plugin, checks the sha256 and the schema, then atomically replaces the cached copy. Any failure keeps the last valid catalog. The cached copy is re-verified on every load, so a tampered file on disk is refused. Age is reported; over 7 days → stale warning.
- **analyze_project:** reads `package.json`, lockfile names, config file names, top-level folders (`app/`, `pages/`, `apps/*`, `packages/*`), `.mcp.json` and the `.claude/` layout; never source contents. The profile gained `integrations` (auth, payments, email, CMS, observability libraries). The output gained `warnings` (installed blocked items, FR-U2).
- **recommend_setup (deterministic):**
  - **Categories:** derived from the profile and answers (e.g. Playwright, or a test-first workflow → browser testing; database libraries → database; deploy target → deploy; Tailwind or shadcn → UI components; detected integrations → auth, payments, email, CMS, observability; docs and code review always; git when it's a repo).
  - **Ranking:** one winner per category, ranked eval uplift > confidence > provenance > health, then lower context overhead, then id.
  - **Vendor affinity:** if any candidate matches a detected library or deploy target (e.g. Prisma, Vercel), only matching candidates compete. A deliberate refinement of the plan's ordering, so a Prisma project doesn't get a Supabase server.
  - **Exclusions:** every other eligible item is listed as excluded with a reason.
  - **Unsupported stacks:** only items tagged `any`, at low confidence (PRD 14.1).
- **Model recommendation: Sonnet (and Haiku) only.** CLAUDE.md forbids Opus in product code or config, so the rules table never names it; for low budget sensitivity it says "a larger model is available if you need it". Flagged for the owner.
- **generate_config:**
  - **`.mcp.json`:** servers named by catalog item id. npx → `npx -y <pkg>@<exact version>`; uvx → `uvx --from <pkg>==<version> <pkg>`; remote → `{type: "http", url}`; env values are always `${NAME}` placeholders. Existing servers are kept untouched.
  - **`settings.json`:** deep merge; adds our server names to `enabledMcpjsonServers`; keeps all keys and permission lists; never adds allow rules on its own.
  - **`CLAUDE.md`:** only the text between `<!-- setup-agent:start -->` and `<!-- setup-agent:end -->` is written (appended if absent).
  - **Other items:** plugins, skills and manual items become install steps (`claude plugin marketplace add/install`, copy instructions).
  - **Validation:** our generated entries are checked against the verified `.mcp.json`/settings shapes; the user's hand-written entries aren't re-validated (that would block them).
  - **Writes:** none; it returns contents and unified diffs.
  - **Hook recipes:** catalog hook items are repos without templates, so they're listed as manual steps for now.
- **backup_setup / rollback_setup:** backups go to `.claude/setup-agent/backups/<UTC timestamp>-<rand>/` with `manifest.json` (path, existed, sha256) for `CLAUDE.md`, `.mcp.json`, `.claude/settings.json` and all files under `.claude/agents/` and `.claude/skills/`. Rollback restores byte for byte (checksums verified), removes tracked files that didn't exist at backup time, and touches nothing outside the manifest.
- **verify_setup:** settings and `.mcp.json` parse; required `${VAR}` names present in the environment (names only, values never returned); each server started with the SDK client (stdio or HTTP) and `tools/list` within 15 s; duplicate tool names across servers. This runs the user's own approved config on their machine, like Claude Code does, so it is exempt from the pipeline's sandbox boundary test (explicit exemption for `apps/plugin/server/verify.ts`).
- **check_updates:** matches installed servers to catalog items by name, then package spec, then URL. Notices are blocked (critical, first), deprecated, superseded, newer pinned version, not in catalog.
- **Not built (P0 gaps to note):** NFR-9 Claude Code version gating (refuse to write config for unsupported versions) isn't implemented yet; the skill (M8) runs inside Claude Code, which already validates its own config.

## Milestone 8

- **Plugin layout** (verified in M0 and with `claude plugin validate`, Claude Code 2.1.302): `apps/plugin/.claude-plugin/plugin.json` (`name: setup-agent`), `apps/plugin/.mcp.json` declaring the `setup-agent` server as `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js`, with env `PLUGIN_DATA_DIR=${CLAUDE_PLUGIN_DATA}` and `CC_SETUP_AGENT_CATALOG_URL=${CC_SETUP_AGENT_CATALOG_URL:-}`. The four commands are in `commands/` (`setup`, `setup-check`, `setup-rollback`, `explain`) and the guided flow is the `setup-guide` skill. The skill is not named `setup`, because plugin skills and commands share the `/setup-agent:<name>` namespace and would collide.
- **Local marketplace** at the repo root: `.claude-plugin/marketplace.json` (`cc-setup-agent`), plugin source `./apps/plugin`. Both manifests pass `claude plugin validate`.
- **Bundle:** esbuild bundles `server/main.ts` into a single minified ESM file `apps/plugin/dist/server.js` (≈810 KB, Node 20+), with a `createRequire` banner for bundled CommonJS. `pnpm plugin:build` builds it; `dist/` is gitignored, so build before installing. TypeScript's own output for the plugin moved to `.tsbuild/`, so `dist/` holds only the bundle. A test builds the bundle, checks it contains no database, pipeline or Anthropic SDK code, and drives it over stdio.
- **Catalog location for the plugin:** `CC_SETUP_AGENT_CATALOG_URL` in the user's shell (e.g. `file://<repo>/.snapshots/`), passed through the plugin's `.mcp.json`. No default is baked in (no absolute paths in code, and distribution is deferred).
- **Acceptance test** steps for the owner: `docs/M8_ACCEPTANCE.md`.

## Milestone 8.1 (fixes before acceptance, owner request 2026-10-19)

- **Opus for users (supersedes the M7 "Sonnet and Haiku only" note):** the Haiku/Sonnet-only rule covers the product's own API calls. The user-facing model rules moved to `apps/plugin/server/model-rules.ts`, the only file `pnpm check:models` exempts (exact path; a test proves similar paths aren't exempt). Rule: Opus (`opus` alias, effort `high`) only when the work is complex **and** budget sensitivity is `low`. Complex work at a `medium` budget gets Sonnet `high` with a note that Opus is an option. Everything else is unchanged (Sonnet). Cost note from the pricing page (2026-10-19): Opus 5.5 USD 4 / 20 per million input / output tokens, twice Sonnet 5.5 (2 / 10). The LLM client and config loader still refuse Opus (unchanged).
- **Complexity is inferred, not asked:** new optional `complexity` (`simple` / `standard` / `complex`) in the setup answers. The skill infers it from the goal, so the interview stays at five questions. Without it, a goal mentioning re-architecture, migration, a large refactor, a rewrite, system design or "complex" counts as complex.
- **Vendor matching (refines M7 "vendor affinity"):** a stack-matching item wins its category only if it has no security flags (no high/critical findings, gate 3 not failed) and at least medium confidence. Otherwise normal ranking applies; the chosen item's reason says which matching item was passed over and why, and so does that item's exclusion reason.
- **Hook recipes (plan M7 "hook recipes from templates"; supersedes the M7 "manual steps" note):** three recipes, built from the detected tooling (`analyze_project` now reports `tooling`: formatter prettier/biome, linter eslint/biome, and `lint`/`typecheck`/`type-check`/`format` script names):
  - `format-on-edit`: PostToolUse `Edit|Write`, formatter on the edited file, never blocks.
  - `lint-on-edit`: PostToolUse `Edit|Write`, linter on the edited file; lint errors (exit 1) go back to Claude via exit 2.
  - `typecheck-on-stop`: Stop, the `typecheck` script or `tsc --noEmit`; errors go back via exit 2, skipped when `stop_hook_active`.
    Each is a self-contained `node -e '…'` command (no jq or script files needed; Node is always there in a Next.js project), using the package manager's local-binary runner (`pnpm exec`, `npx --no-install`, `yarn`, `bunx --no-install`), never downloading tools. Commands end with `# setup-agent:<id>`, which makes re-runs idempotent. Prettier wins when both Prettier and Biome are configured. Recipes live in code (`apps/plugin/server/hooks.ts`), not in a `templates/` folder, because the server ships as one bundled file.
- **Hook approval and merge:** `recommend_setup` returns `hooks` proposals; the user approves each one; `generate_config` takes `hookIds` and returns the settings diff and `skippedHooks`. Existing hooks are never changed or removed: our matcher groups are appended; a recipe is skipped when already installed, when an existing hook on the same event already runs the same tool, or when that event's value isn't a list. A non-object `hooks` value is refused. Our groups are validated against the hooks shape.
- **Hook facts verified (code.claude.com/docs/en/hooks, 2026-10-19, Claude Code 2.1.303):** `hooks.<Event>[].{matcher, hooks[].{type:"command", command, timeout}}`; matcher `Edit|Write` is an exact-name list; PostToolUse input has `tool_input.file_path` for Edit and Write; exit 2 on PostToolUse shows stderr to Claude; exit 2 on Stop keeps Claude going; Stop input has `stop_hook_active`; `CLAUDE_PROJECT_DIR` is exported; `timeout` is in seconds (default 600). MultiEdit isn't documented any more, so the matcher doesn't name it.
- **NFR-9 supported range: Claude Code `>= 2.0.0 < 2.2.0`** (current minor 2.1 and the previous minor 2.0, per NFR-9; config shapes verified on 2.1.302/2.1.303). `generate_config` refuses outside it, and when the version can't be detected, with a message saying why and what to do; nothing else is gated (reading and recommending stay available). Detection: the MCP handshake's `clientInfo` (Claude Code 2.1.303 identifies itself as `claude-code`; seen in the CLI binary), else `claude --version`. The output carries `claudeCodeVersion`. Raise the upper bound only after re-verifying against a new minor.
- **Python image:** the only remaining 3.12 reference was `GATE_PYTHON_IMAGE` in `.env.example`. Editing it was blocked again by the project's `.env.*` deny rule, so the owner gets a one-line command. The owner's effective config already uses 3.13 (config loads with the default; values not printed). New guard: the config loader refuses any `GATE_PYTHON_IMAGE` below Python 3.13, so a stale override fails at startup with a clear message.

## Milestone 9

**Harness layout** (`apps/evals`)

- `fixtures/next-app/`: small Next.js 16.4.2 app (React 19.3.1, TypeScript 6.0.3: Next's type check doesn't support TS 7; `@playwright/test` 1.64.1), with home/counter, products search, about and contact pages; exact versions from npm, lockfile generated with `npm install --package-lock-only --ignore-scripts`. The contact form uses `noValidate`, so the app's own validation runs (native email validation blocked submission and made one task unsolvable; caught by the self-test).
- `tasks/browser_testing/`: 5 tasks (`counter-increment`, `nav-about-link`, `contact-form-submit`, `product-search`, `contact-e2e-test`), each with `task.md`, `setup.sh` (introduces the bug), `check.sh`, `check/` (hidden Playwright specs), `solution.sh` (known-good fix) and `meta.yaml`; `_check/` holds the shared hidden config. Checks build the app and run hidden Playwright specs on a private port after stopping any server the agent left running. `contact-e2e-test` grades the agent's own test by mutation: it must pass on the app and fail on two broken variants. Hidden checks assert the error **text**, not `role="alert"`, because Next.js renders a route announcer with `role="alert"`.
- **Task-set version** = `<category>-v<n>-<sha256 of every task file, 8 chars>`, so any task edit invalidates cached baselines automatically.
- **`pnpm evals selftest`** proves each task in the real eval image without API calls: setup only → check fails; setup + solution → check passes. All 5 pass (2026-10-19).
- `tools.yaml`: eval-only settings per item (extra args, Playwright browser versions to bake in). Playwright MCP 0.0.83 runs with `--headless --isolated --browser chromium --no-sandbox` (flags read from its `--help` in a container) and needs Chromium r1247 (playwright 1.64.0-alpha-1790635538000), while the fixture's Playwright 1.64.1 uses r1248; the image has both. Smoke-tested free: 25 tools, navigates a page.

**Eval image**

- Built from the pinned node image (`GATE_NODE_IMAGE`), plus `git`, `procps`, `python3`, the fixture with `npm ci`, Playwright Chromium (and the extra versions), and `@anthropic-ai/claude-code@EVAL_CLAUDE_CODE_VERSION` (2.1.303, the version verified on the host). Tag `ccsa-eval:<hash of Dockerfile, fixture, build args>`. Native platform unless `EVAL_PLATFORM` is set (Chromium under amd64 emulation on Apple Silicon is too slow); the platform is recorded in every run's artifacts. The harness refuses to run if the image's `claude --version` differs from the config.
- Known limitation: the image has Python 3 (Debian's) but no Python Playwright, which the incumbent `webapp-testing` skill's helper scripts expect. Agents can still use the fixture's Node Playwright. Revisit before Stage A of that comparison.

**Sandbox and the API key** (stricter than plan 9.2 rule 4, "pass only ANTHROPIC_API_KEY into the container")

- The agent container **never holds the real key**. It gets a placeholder key and `ANTHROPIC_BASE_URL=http://<relay>:8080`. The relay (our script, in the pinned node image) swaps in the real key, which reaches only the relay, as a bare `-e ANTHROPIC_API_KEY` taken from the docker CLI's environment (never on a command line), and forwards to `EVAL_ANTHROPIC_API_URL`. A tool under test can't read or exfiltrate the key.
- **No Opus is possible:** the relay refuses (403) any request whose `model` isn't in `ALLOWED_MODELS` or matches `opus`; the container maps every alias (`opus`, `fable`, `sonnet`, `haiku`) and subagents to Haiku/Sonnet via `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` (env names from code.claude.com/docs/en/model-config, 2026-10-19). Refusals are logged and counted as run errors.
- **Egress:** the agent container is only on an internal network. Its only route out is the relay's proxy, which allows `EVAL_EGRESS_ALLOWLIST` hosts (default `registry.npmjs.org`, for `npx` tools) and denies and logs everything else. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `NEXT_TELEMETRY_DISABLED` are set.
- **Policy check** (`assertEvalPolicy`, strict allowlist on the exact `docker run` args): expected image per role, `--rm`, non-root, `--cap-drop ALL`, `no-new-privileges`, CPU/memory/pids limits (agent 2 CPUs, 4 GB, 2048 pids, 1 GB `/dev/shm` for Chromium), run-specific internal network, env allowlist per role, no mounts at all (files go in with `docker exec -i` as the container user), placeholder-only key in the agent. Permissions inside the container are fully open (`--dangerously-skip-permissions`), as the plan allows for a disposable container.
- **Cleanup:** containers and network are force-removed in `finally`, plus a label sweep; `pnpm evals cleanup` sweeps everything. Real-Docker test (fake `claude`, CI) checks: placeholder key only, direct internet blocked, non-allowlisted CONNECT denied and logged, hidden check files arrive only after the agent, nothing left behind. The pipeline boundary test exempts `apps/evals/src/sandbox` (the eval sandbox), nothing else.

**Headless flags (verified for Claude Code 2.1.303):** `-p`, `--model`, `--output-format json`, `--max-budget-usd`, `--dangerously-skip-permissions`, `--no-session-persistence`, `--strict-mcp-config`, `--mcp-config` from `claude --help`; `--max-turns <turns>` is defined but hidden from help (found in the CLI binary). Result JSON fields `num_turns`, `is_error`, `total_cost_usd`, `modelUsage` and subtypes `success`, `error_max_turns`, `error_max_budget_usd` are present in the binary. The parser is lenient (unknown fields kept, missing optional fields defaulted).

**Budget**

- Every run: model allow-list check → ledger pre-flight with the measured mean cost for that model, or `EVAL_RUN_MAX_USD` (1.50) before any run of it has been measured (a cap, not a guess) → `claude --max-budget-usd min(EVAL_RUN_MAX_USD, budget left)`, so even a run that spends its whole cap can't push the week over → ledger rows per model from Claude Code's `modelUsage` cost (purpose `eval`, ref = run id), written even for failed runs. If the output can't be parsed but the relay saw successful API calls, the run's cap is recorded, so the ledger never under-counts. A test drives worst-case runs until refusal: eval spend stays ≤ USD 17 and the week ≤ USD 20.
- Batches (one task's Stage A runs, or a Stage B pair) are pre-flighted as runs × measured mean; a batch that doesn't fit is queued in `eval_queue` (priority, reason) instead of run (FR-E6). `pnpm evals queue` lists it.
- Paid commands (`pilot`, `run`) need `--confirm-spend`.

**Stages, cache, verdicts** (plan 9.1)

- Stage A: `EVAL_SCREEN_RUNS` (3) `MODEL_FAST` runs per task for the candidate and for the baseline (the category's incumbent: a `recommended` item, else `recommended_provisional`; or no tool). Early stop after `EVAL_EARLY_STOP_FAILS` (2) tasks the baseline passed (≥ 50% of runs) and the candidate didn't → verdict `worse`.
- Stage B only if the candidate's Stage A success rate leads by `EVAL_CONFIRM_THRESHOLD` (0.2): 1 `MODEL_STRONG` run per task each. Candidate ≥ baseline → `better`, else `inconclusive`. Without Stage B: `equal`, or `worse` if it trails by the threshold.
- Baseline cache key: task id, task-set version, model, Claude Code version, incumbent id and version (or no tool). Cached runs are reused; any change reruns them.
- Summary (FR-E3: success rate, mean tokens, cost, wall time, context overhead, baseline rate) goes to the candidate's scorecard for its pinned version; triage shows it plus every eval run (stage, task, model, result, tokens, cost, time, errors, logs ref).
- Schema: `eval_runs.stage` (`pilot` / `screen` / `confirm` / `baseline`) and table `eval_queue` (migration `0003_eval_harness`).
- Logs per run through `ArtifactStore` (local: `EVAL_ARTIFACT_DIR`, default `.artifacts/evals/<run id>/`): Claude JSON and stderr, setup and check output, diff, relay log, `meta.json` (pinned versions, image, platform, cap).

### M9 pilot (2026-10-19, owner-approved: one task, once per model)

Candidate `microsoft-playwright-mcp` 0.0.83 on task `contact-form-submit` (task set `browser_testing-v1-ed8bfdcc`), Claude Code 2.1.303, image `ccsa-eval:fe115927975053a8`, linux/arm64, `--max-turns 15`, cap USD 1.50 per run:

| Model               | Result | Cost (Claude Code `costUSD`) | Tokens (in incl. cache / out)                      | Turns | Agent time | Run id                |
| ------------------- | ------ | ---------------------------- | -------------------------------------------------- | ----- | ---------- | --------------------- |
| `claude-haiku-5-5`  | pass   | USD 0.0102                   | 419,338 / 3,224                                    | 19    | 70 s       | `20261019-f46d67155a` |
| `claude-sonnet-5-5` | pass   | USD 0.1346                   | 330,206 / 1,698 (294,940 cache read, 35,246 write) | 16    | 48 s       | `20261019-3187256b0a` |

Both runs passed the hidden check. Pilot spend USD 0.1449, in the ledger (purpose `eval`). Notes:

- Each run logged 1 "error": denied egress to Google hosts (Chromium's own background calls). After the pilot, denied egress is recorded in `meta.json` (`egressDenied`) and no longer counted as a run error. The two pilot rows keep `errors = 1`.
- After the pilot the image gained a build-time `npm run build`, so Next's `tsconfig.json` rewrite stays out of run diffs and checks start from a warm cache. New tag `ccsa-eval:749979749bd4914c`; same Claude Code version, so cache keys are unchanged. Self-test re-run: 5/5.
- `num_turns` (19) can exceed `--max-turns` (15): Claude Code counts turns differently from the limit (the run still ended with `success`).

**Weekly run plan** (`pnpm evals plan`, from the measured means; 5 tasks, 3 Haiku runs per task in Stage A, 1 Sonnet run per task in Stage B; 90% of the USD 17 weekly eval share planned = USD 15.30):

- Baselines, once per incumbent and cache key: Stage A USD 0.15, Stage B USD 0.67.
- Candidate: Stage A USD 0.15, Stage B USD 0.67, both stages USD 0.83.
- First week (baselines + candidates): about 17 candidates. Later weeks: about 18 per week if every candidate reaches Stage B, up to 99 if they stop after Stage A.
- Total cap (USD 39.72 left at plan time): about 42 full candidates including baselines.

The plan rests on one run per model on one task, so the harness doesn't hard-code it: every run and batch is pre-flighted with the measured mean, which updates as runs accrue, and each run is capped at USD 1.50 and at the budget left. Suggested first real batch, once the owner approves: Playwright MCP vs the `webapp-testing` incumbent (about USD 1.65 with baselines). Variance is also bounded by the catalog: the browser-testing category has only a handful of evaluable candidates (npx MCP servers and skills without credentials).

## Milestone 8.2 (fixes after the M8 owner acceptance, owner request 2026-10-19)

**Claude Code facts verified (code.claude.com/docs and `claude plugin … --help`, Claude Code 2.1.303, 2026-10-19)**

- `claude plugin install <p>@<m> --scope project` and `claude plugin marketplace add <src> --scope project` exist. Project scope writes `.claude/settings.json`: `enabledPlugins` (`{"<name>@<marketplace>": true}`) and `extraKnownMarketplaces` (`{"<name>": {"source": {...}}}`). The plugin code itself is cached per user under `~/.claude/plugins/cache/…`. Teammates aren't auto-installed. `claude plugin uninstall <p> --scope project` and `claude plugin marketplace remove <name> --scope project` undo it.
- Claude Code reads `AGENTS.md` on its own only while no `CLAUDE.md` exists; the documented pattern is a `CLAUDE.md` that imports it with `@AGENTS.md`. Imports resolve relative to the importing file (max depth 4) and are skipped inside code spans and fenced blocks.
- PostToolUse non-blocking feedback: JSON on stdout, `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`, exit 0. Plain stdout on exit 0 isn't shown to Claude. Exit 2 shows stderr to Claude (the tool has already run).
- Skills, commands and agents: name and description are in context every turn (the description is cut at 1,536 characters in the listing; `disable-model-invocation: true` removes it); the body loads only when used.

**A. Recommendation quality**

- **Owner-set kind/category:** new columns `kind_set_by` and `category_set_by`, written only by `setClassificationFields()` (human actors only, reason required, audit row in `status_events` with the same status on both sides). Classification never replaces an owner-set field, in any mode. Triage shows kind and category as badges at the top of the item page and in the queue, with an edit form ("no category" allowed).
- **Owner-editable technologies:** the triage form also edits `technologies` (comma-separated; empty = vendor-neutral). Saving locks them (`technologies_set_by`, migration `0005`), like kind and category. Added after the live run, because fit depends on them and the classifier tagged `anthropics-skills-webapp-testing` with `playwright`, which would hide it from projects that don't use Playwright yet. Saving the form locks all three fields: the owner is confirming them.
- **classify-v3 prompt:** the classifier now gets the item's components (MCP tool names and descriptions from the sandbox probe; skills, commands and agents from frontmatter in the repo tree) as well as the README, and is told to judge from those, not from the short description. Category definitions are stricter, with explicit "null" cases (chat and messaging bridges, tools that manage Claude Code itself such as CLAUDE.md upkeep, productivity). "A wrong category is worse than null." New output field `technologies` (lowercase product or vendor names the project must already use). Model and budget unchanged (Haiku, classification ledger).
- **Re-classification of all non-rejected items** (`classify --all`): replaces kind, category and stacks unless owner-set. **This includes seed hints** (the owner-approved seed list was proposed by me in bulk, and the wrong `deploy`/`code_review`/`git_github` filings came partly from it). Every kind or category change is stored in `classification_review` (previous values, prompt version) and listed in the report; triage has a "needs classification review" filter, and saving kind/category clears the flag.
- **Fit rules (plugin, `recommend.ts`):**
  - The project's technologies are built from package.json dependencies (with their version ranges), deploy config files (`vercel.json`, `netlify.toml`, `wrangler.*`), `components.json`, the git remote host from `.git/config`, and the stated deploy target. Each comes with the evidence text shown to the user.
  - An item with `technologies` fits only when one of them is detected or stated (fit `strong`).
  - A vendor-neutral item (empty `technologies`) fits a needed category (fit `good`), except in deploy, auth, payments, email, CMS and observability, where only a vendor match fits.
  - Snapshots from before classify-v3 (`technologies: null`) fall back to vendor names in the item name.
  - Spellings are normalised (`TailwindCSS` → `tailwind`, `Cloudflare Workers` → `cloudflare`); generic words such as typescript, node and mcp never make an item vendor-specific.
- **Category needs need a specific signal:**
  - docs: Next.js detected;
  - code review: the risk-tolerance answer is low or medium;
  - git hosting: a GitHub, GitLab or Bitbucket remote (a bare `.git` folder no longer counts);
  - deploy: the stated target, or a deploy config file when the target is "unknown".
  - The other categories are unchanged, but each now cites its signal.
- **Minimum fit bar = `good`.** A needed category with nothing above it gets a `gaps` entry ("No suitable item in the catalog yet", with detail) and no recommendation.
- **Fit and credibility are separate output fields** (`fit`, `fitReason`, `credibility`, `credibilitySummary`); the old `confidence`/`scorecardSummary` fields are gone. The skill shows them on separate lines. `categoryLabel` is the human label; internal ids are never shown.
- **Context overhead for skills and plugins:** gates fetch up to 60 component files per item and estimate the always-loaded listing (name + description ≤ 1,536 chars, ÷ 4, + 8 tokens per entry) into `contextOverheadTokens`, and the largest skill or command body into `contextOnUseTokens`. MCP servers keep the tool-definitions estimate. The plan's total lists items it couldn't measure (`unknownItems`). A plugin's bundled MCP servers are counted, but their tools aren't probed (noted as not measured).
- **Provisional wording:** "provisional: approved by the maintainer before evals were run". "New" appears only when `firstPublishedAt` (the earlier of repo creation and first npm publication, from the gates) is under 180 days before the snapshot date. Measuring from the snapshot date keeps the output deterministic.
- **Snapshot fields added** (all with defaults, so `schemaVersion` stays 1 and older snapshots still parse): `summary`, `technologies`, `contextOnUseTokens`, `firstPublishedAt`.

- **Live re-classification (2026-10-19):** gates re-run first on all 140 non-rejected items (0 errors, no status changes; 19 MCP servers listed tools in the sandbox), so the classifier had component lists. `classify --all`: 138 classified, 2 refused at first because the model returned more than 5 technologies (structured outputs drop `maxItems`). The cap was removed, at most 8 are kept, and `--item` was added; both were re-run. Total cost USD 0.0388. **47 items changed kind or category** and are flagged for review in triage, including 2 approved ones (Discord → no category, CLAUDE.md management → no category). Both are now left out of the snapshot (recommended items need a category). Snapshot `2026.10.19-2` published (8 items).

**B. Project analysis**

- `analyze_project` reports `existingConfig.agentsMd` and `claudeMdImportsAgentsMd`, plus `dependencyVersions`, `deployConfigs` and `gitRemoteHost`.
- `pnpm-workspace.yaml` counts as a monorepo marker only when it declares at least one `packages` glob; `package.json` `workspaces` only when non-empty. create-next-app 16 writes a settings-only workspace file.

**C. Config generation and the skill**

- **CLAUDE.md block:**
  - imports `@AGENTS.md` when AGENTS.md exists and CLAUDE.md doesn't import it already (never copies it);
  - lists up to 15 package.json scripts as real commands for the detected package manager;
  - has one line per tool: name, kind, when to use it (per job), and the catalog summary;
  - shows no category ids.
- **Diffs and pacing (FR-G3):** the skill must paste every file's full diff, never a summary. In one-at-a-time mode it writes one file, then stops and waits. Covered by packaging tests on the skill text (the behaviour itself is checked in the owner acceptance).
- **Plugin installs at project scope (FR-G2):**
  - the install commands use `--scope project`, and `generate_config` returns `plugins`;
  - rollback covers `.claude/settings.json`, so restoring it disables the plugins for the project;
  - `rollback_setup` (new `dryRun` preview) compares `enabledPlugins` and `extraKnownMarketplaces` between the backup and now, and returns the exact uninstall and marketplace-remove commands;
  - `/setup-rollback` previews first, offers to run those commands before restoring (they edit settings.json, which the restore then puts back byte for byte), then restores;
  - no extra manifest entry is needed, because the settings diff is the record.

**D. Hooks**

- `lint-on-edit`, PostToolUse:
  - linter exit 1 (errors) → exit 2 with the output (blocking, as before);
  - exit 0 with diagnostics (warnings) → `additionalContext` JSON (non-blocking). ESLint's default formatter prints nothing for a clean file; Biome always prints a summary, so its warnings are recognised by rule names (`lint/<group>/<rule>`).
- `lint-on-edit` also adds a **Stop** group that lints files changed in git (`git diff --cached --relative` plus `git ls-files -m -o --exclude-standard`, lintable extensions, at most 50, existing files only), so shell edits are covered.
  - Errors only (exit 2); warnings are not fed back at Stop, because that would force an extra turn on every Stop with accepted warnings.
  - Skipped when `stop_hook_active` is set or outside git.
  - One approval adds both groups; recipes are added whole or not at all, and idempotency is still by marker.
- Speed: one ESLint run over the changed files per turn (at most 50 files). Judged acceptable, but not measured on a real app; the owner's acceptance hook check will show it.

**E. verify_setup**

- Every server gets every check, and all failures are reported together:
  - `package_resolves`: `npm view <pkg>@<version> version` honours the user's npm config; an existing package with a missing version prints nothing, which counts as not found. PyPI JSON API at `CC_SETUP_AGENT_PYPI_URL` (default `https://pypi.org`). An unpinned spec fails.
  - `env_present`.
  - `server_starts`: a local stdio server missing variables is started with the placeholder `setup-agent-placeholder` (safe: no real secret leaves the machine), and the result carries a `note`; a remote server missing variables is not started (reported as not started).
- Then the duplicate-tools check, as before.

**G. Eval image**

- Python Playwright `1.64.0` (latest on PyPI, 2026-10-19) in a venv at `/opt/pyenv` (Debian's Python is externally managed; `python3-venv` added), first on `PATH`, with its Chromium in the shared `PLAYWRIGHT_BROWSERS_PATH`. `pnpm evals selftest` now first checks offline that Python Playwright launches Chromium (free). The image tag changes (Dockerfile hash); cache keys don't include the image, so cached baselines stay valid. Before this change they ran without Python Playwright; a re-baseline is advisable before the first real webapp-testing comparison.

## Milestone 8.3 (autonomous curation, owner decision 2026-10-20)

**Principle:** "when unsure, don't recommend" replaces "when unsure, ask the owner". Nothing in the pipeline creates a task for the owner; uncertainty keeps an item out of recommendations. PRD 0.4 (FR-C9, FR-D9a, FR-P1 to FR-P9), plan rule 4 and 6.1, CLAUDE.md updated.

**Status rules**

- Actor `policy:<version>` (e.g. `policy:policy-v1`) may set `recommended_provisional` and `recommended`; `system` still may not. Unblocking stays human-only.
- New transitions `recommended_provisional → candidate` and `recommended → candidate` (eval regression, owner veto).
- `transitionStatus` (still the only status path, audited) refuses a policy approval when the item is vetoed, when the latest scorecard has a high/critical finding or a failed gate 3, or when an override note is passed. Approvals also write `reviewer`/`reviewed_at` on the scorecard (PRD 11.3).
- An owner approval with an override note now records the accepted findings (`security_override`), so the policy blocks only on findings that are new since then.
- Gates: a provisional item that fails gate 0 in a re-check now goes to watchlist (was rejected), per FR-P6.

**Approval policy** (`catalog/policy.yaml`, `policy-v1`; pure evaluators in `packages/shared/src/policy.ts`)

- Official-vendor tier = provenance `anthropic` or `official_vendor` (gate 1, from `catalog/vendors.yaml`). Criteria, all required: no veto; gates 0–3 all `pass` (a soft fail is not a pass); no high/critical finding; agreed category; last commit ≤ 90 days; install method matching the kind (`mcp_server`: npx/uvx/remote; `skill`: skill_copy; `plugin`: plugin) with a pinned version (never `manual`; subagents and hook recipes have no automatic install path, so they never qualify); fits Next.js (classifier relevant + `nextjs`/`react`/`any`, not out of scope); no losing eval on the pinned version.
- Community tier: the same plus an eval on the pinned version with verdict `better` against today's incumbent (or no tool). An eval against an older incumbent doesn't count (and makes the item eval-worthy again).
- Promotion: still meets its tier's criteria + passing eval (`better`, or `equal` against a real incumbent; `equal` against no tool isn't enough) + ≥ 60 days since entering provisional. Owner-approved items are promoted only if they meet the policy's criteria too.
- Demotion triggers, in order: veto → candidate; new high/critical finding → blocked; gate 0 `fail`, or (for policy approvals) gate 0 no longer `pass` → watchlist; no commit > 180 days → watchlist; eval `worse` on the pinned version → candidate. They apply to owner approvals too (except the gate 0 soft-fail rule, which an owner approval may already have accepted). Approval criteria lapsing (for example a 100-day-old last commit) don't demote; only these triggers do.
- `pnpm run pipeline policy [--dry-run] [--no-second-opinions] [--item …]` stores the latest decision per item with every criterion (`policy_decisions`); triage shows it.

**Classification without review**

- Three opinions: deterministic rules (`catalog/category-rules.yaml`, `rules-v1`: keywords in item name/id, component names, npm/marketplace keywords, GitHub topics, plus a publisher → category map for single-product vendors only), Haiku (the classification), and a Sonnet second opinion with the same prompt version and inputs. Agreed = owner-set category, or both models return the same kind and category from the same input hash and prompt, and the rules do not point at another category while giving this one zero signals. Requiring the kind to match too is stricter than the brief asked (category only), deliberately: a kind disagreement means we don't know what the thing is.
- The second opinion is requested only when it is the last missing criterion (community items: after their eval). It costs classification budget.
- **Sonnet 5.5 thinking:** `thinking: {type: "disabled"}` returns 400 on `claude-sonnet-5-5` (live, 2026-10-20; confirmed in the Claude API reference). The LLM client now sends `{type: "between_tools"}` for Sonnet 5.5 (accepted at effort ≤ high; we use low) and keeps `disabled` for Haiku 5.5. The 29 refused calls were not billed (no ledger rows).
- Input hash (`classification_input_hash`): sha256 of description + full README + components (names and descriptions). `classify --changed` re-classifies only items whose hash or prompt version changed; the daily curation job runs it. First live run had no hashes, so it re-classified all 140 items once (USD 0.0371).
- **Owner approvals keep their classification:** re-classification treats the kind and category of an item a human approved (current status) like owner-set fields. Found live: Haiku gave the owner-approved `clerk-skills` no category, which would have dropped it from the next snapshot. Its approved category (`auth`) was restored in the database (the only manual data fix this milestone; the stored classification still shows Haiku's answer).
- Gold set: owner-locked fields in the database (none exist yet) + `catalog/classification-gold.yaml`, frozen from the owner's 10 approvals (kind and category as approved). Discord and CLAUDE.md management are kind-only: their category at approval (`git_github`, `code_review`) contradicts the M8.2 category definitions, so it is left out rather than guessed. **The brief said "all owner-locked fields"; there were none, hence the approvals.**
- `classify:eval [--prompt v] [--model strong]` scores a prompt on the gold set (no kind hint, so the gold kind can't leak) and stores it in `classifier_evals`. The prompt gate: the prompt version in use (most items' version) always runs; a different version is applied (classify and intake) only after both have a score on the same gold set and model and the new one is ≥ the current one. Baseline: **classify-v3 with Haiku 6/10 (0.600)**, USD 0.0032; misses are skill-vs-plugin kind confusion (4) and two missing categories.
- The "needs classification review" filter is now an optional "classification changed" view; triage says nothing is waiting.

**Scheduled evals** (FR-P7; `pnpm run pipeline auto-evals --dry-run | --confirm-spend`, weekly `evals-weekly` job at `auto_evals.cron`, Monday 06:00 UTC)

- Candidates: items where the eval is the missing evidence (`evalNeed`: candidate/watchlist meeting every other criterion, or provisional without a current eval), eval-ready (npx MCP servers with a pinned package, skills at a pinned commit; nothing needing env vars; remote servers excluded because the eval egress allowlist has only npm), in a category with a task set (only `browser_testing` today).
- Order: Next.js relevance (`nextjs`/`react` > `any`), vendor tier, star velocity, stars, id; up to `per_category` (3) per week.
- Cost: worst case (Stage A + Stage B) from measured per-model means, plus uncached baseline runs once per incumbent; added while the total fits `min(weekly eval budget left, total left − reserve) × headroom` (reserve USD 5 for classification, headroom 0.9). The harness still pre-flights every batch and run against the ledger, so the caps hold even if the estimate is wrong.
- The plan is logged and written to `REPORTS_DIR/eval-plan-<week>.md` before anything runs. Scheduled runs need no confirmation; the manual command needs `--confirm-spend` (dry run is free).
- `apps/pipeline` now depends on `apps/evals` (workspace) for the weekly job; `apps/evals` exports its context module.

**Digest and veto**

- `buildDigest` (`packages/db`): status events of the ISO week by `policy:*`, owner vetoes, and system demotions of approved items, with reasons, gate evidence links and eval summaries; plus the "not approved: why" counts from the latest decisions (candidates and watchlist only).
- `pnpm run pipeline digest [--week]` and the weekly `digest-weekly` job (Monday 09:00 UTC, previous week) write `REPORTS_DIR/digest-<week>.md` (default `reports/`, gitignored as generated output like `.snapshots/`); triage `/digest?week=` shows the same.
- Veto (`vetoItem`/`liftVeto`, one transaction each, human only, reason required): demotes a recommended/provisional item to candidate and stores `policy_veto`; on other statuses it is audited with the same status on both sides. Triage has a one-click veto form on every item page, and "Lift veto".
- Worker: `policy-daily` (`POLICY_CRON`, 05:00 UTC, after the 04:00 gates) runs `classify --changed` then the policy with second opinions.

**CI fix:** the poisoned fixture server phoned home at process start (before answering `initialize`, so by the probe's definition install-phase egress); the real-Docker test passed only when the request reached the proxy late, and failed on CI for the M8.3 commit. The fixture now phones home while serving `tools/list` and answers 300 ms later. Product code is unchanged.

**Plugin wording:** provisional now reads "approved on gate, security and classification evidence; not yet confirmed by evals over 60 days".

**Live run (2026-10-20):** gates re-run on 3 plugins whose install still matched their pre-M8.2 kind (convex, sanity → `plugin`; honeycomb → `manual`, so not approvable). `classify --changed` 140 items (USD 0.0371, 5 category changes). Second opinions: 29 asked, 29 agree (USD 0.1962). **29 items approved to recommended_provisional by `policy:policy-v1`**; 0 promoted; 0 demoted; 111 held. Scheduled eval plan (not run): 3 browser-testing items, worst case USD 4.13. No snapshot published (owner sees the report first).

## Milestone 8.3, round 2 (owner answers, 2026-10-20)

**Vetoes:** discord, claude-md-management and cloudflare-skills (wrong fit: Cloudflare deploy recommended for Vercel), reason "Early owner approval, wrong category/fit.", run by Claude Code on the owner's written instruction through the new `pnpm run pipeline veto` (same audited path as the triage button), actor `human:owner`.

**policy-v2: owner approvals get no free pass.** An item a human approved must meet its tier's criteria like any item; if not, it goes back to candidate (`owner approval superseded by policy: …`). The second opinion is requested first when it is the only missing piece. The M8.3 protection of owner-approved kind/category in re-classification was removed. The data fix to `clerk-skills` (category restored to `auth`) became moot; it was superseded on gate 3 and category.

**policy-v3: same evidence bar for policy approvals.** A policy approval whose gate 3 re-check no longer passes goes back to candidate (`security_scan_incomplete`), mirroring the existing gate 0 rule. Without it, 7 policy approvals would have kept the same unverified bundled servers that superseded two owner approvals. This is a rule change, so it gets a new version. Approval criteria that lapse (for example maintenance) still don't demote; only the listed triggers do.

**Gate 3 gap: why it didn't run, and the fix**

- Owner premise corrected: 55 items had gate 3 `not_run`; the other gate failures among the 79 were soft fails on gates 0 and 2.
- Causes:
  - only the first `SKILL.md` was scanned, so command/agent-only plugins, LSP and output-style plugins had nothing scanned;
  - bundled MCP servers were never probed;
  - plugin `.mcp.json` files with a top-level server map were counted as 0 servers (they don't use `mcpServers`).
- Fix (`gates/bundled.ts`, `gatherFacts`):
  - every skill/command/agent body, the config files Claude Code reads (`.mcp.json`, `.lsp.json`, `hooks/hooks.json`, `plugin.json`) and the marketplace entry are scanned;
  - bundled servers are parsed in both shapes. Pinned npm/PyPI ones are probed in the sandbox and checked in OSV. Unpinned ones are a medium finding (`unpinned_bundled_server`; e.g. the official playwright plugin runs `@playwright/mcp@latest`). Remote ones are probed over HTTP.
  - Any bundled server that can't be verified keeps gate 3 at `soft_fail` (never a pass).
- **False positives found and fixed.** The first full run applied the injection phrase rules to agent and skill instruction text and auto-blocked 6 items. sensitive_file also fired on 40 items, mostly guidance that mentions `.env`. Now, for text first scanned in M8.3:
  - hidden content keeps full weight (Unicode tag characters block; invisible characters flag);
  - phrase and sensitive-path matches are recorded as low-severity evidence (`instructionTextFindings`).
  - The first `SKILL.md` keeps the M4 rules unchanged.
- 5 of the 6 had no high/critical finding left after the corrected scan. The owner chose to unblock them: done as `human:owner`, with a reason naming the bug. davila7/claude-code-templates stays blocked: its root `SKILL.md` contains "Ignore previous instructions" (unchanged M4 rule), which locks the `davila7` org.
- **Human unblock overrules the block:** the blocked version is removed from `blocked_versions` (a policy lift keeps it). The 5 rows' stale entries were cleared in the database (data fix of the bug's side effect).
- Result after the corrected run: gate 3 pass 76, soft_fail 29, fail 14, not_run 21. The remaining `not_run` items are MCP servers with no runnable install, remote servers needing credentials, and manual subagents/hook recipes; none can be approved anyway.

**Security block lifting (FR-P10)**

- Findings now store their gate 3 `rule`.
- Every block records `block_record` (by, cause, version, findings) and appends the pinned version to `blocked_versions`.
- Causes, from the findings' rules: `vulnerable_dependency` (all findings), `injection`, `exfiltration`, `other` (unknown rules, including findings stored before M8.3).
- The policy lifts a block only when all hold:
  - it made the block;
  - the cause is `vulnerable_dependency`;
  - the pinned version is newer and not itself blocked;
  - gates 0–3 all pass on that exact version;
  - there is no high/critical finding.

  The item returns to candidate; the blocked version stays blocked.

- `transitionStatus` enforces the same conditions, and refuses approval of any pinned version listed as blocked.
- `injection`/`exfiltration` blocks (including legacy gate 3 confirmed-injection blocks) lock the author's GitHub org: approval criterion `org_not_locked`.
- Policy-blocked vulnerable-dependency items are re-gated weekly (`BLOCKED_RECHECK_DAYS` 7), so a fixed version is noticed.
- Snapshots carry `blockedVersions` (schemaVersion still 1, default empty); the plugin's update check and run warning flag an installed blocked version.
- No block was lifted in this run (no item qualified).

**Gold set tiers:**

- `catalog/classification-gold.yaml` now has `agreement_items`. These are machine labels where Haiku, Sonnet (same inputs and prompt) and the rules' opinion agree on kind and category. They are frozen as written and marked `high-agreement (haiku + sonnet + rules) <date>`; owner labels always win.
- `classify:gold [--grow]` adds new ones.
- `classify:eval` scores each tier separately (`classifier_evals.tier`), and the prompt gate requires ≥ on every tier.
- Caveat: agreement labels come from classify-v3's own Haiku output, so they flatter v3; their value is catching regressions in a new prompt.

**Eval batch (owner-approved USD 4.13) and the overrun**

- Planned: testdino skill, chrome-devtools-mcp and playwright-mcp against the incumbent webapp-testing; worst case USD 3.31.
- What happened:
  - testdino could not run: it is a skill at a repo root, and the harness only fetches skills from GitHub folders (limitation; listed in the gap list).
  - chrome-devtools-mcp: Stage A 15/15 vs the webapp-testing baseline 15/15 → verdict `equal`, no Stage B.
  - playwright-mcp: stopped after 3 runs (3/3), no verdict.
- Booked eval spend USD 10.64:
  - 26 runs with real usage cost USD 0.143 in total (about USD 0.005 each, as in the pilot);
  - 7 runs hit the 300 s timeout. Their output was unreadable, so each was booked at the USD 1.50 run cap (the M9 rule that the ledger never under-counts): USD 10.50. Their real cost is unknown here (likely cents; check the Anthropic console).
- **Bug:** `--max-usd` limited the plan but was not enforced during the runs. Stopped by hand, containers removed.
- **Fix:** `EvalContext.spendCeiling`. Every run's pre-flight checks eval spend booked since the batch started; `--max-budget-usd`, and so the amount booked on a timeout, is capped at what is left of the ceiling. A run that doesn't fit is refused and the batch stops. Scheduled batches use their planned amount as the ceiling. Test: a ceiling holds even when runs are booked at their cap.
- **Open issue:** the timeout rate (7/33 at 300 s) makes cap-booking dominate the ledger. Raising `EVAL_TIMEOUT_SECONDS` or changing how unreadable runs are booked is an owner decision (budget accounting).

**Snapshot 2026.10.20-1** published after the final policy run (no LLM calls): 32 recommended_provisional + 1 blocked (davila7, for the warning), 0 skipped.

**Other:** `gates --all`; `auto-evals --max-usd` (an extra ceiling, used for the owner-approved USD 4.13); PRD 0.5 (FR-C9, FR-D9a, FR-P10).

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
- `@anthropic-ai/sdk` — Anthropic API client for classification (plan section 3).
- `pg-boss` — Postgres-backed scheduler for the daily discovery job (plan section 3).
- `@modelcontextprotocol/sdk` — MCP client for gate 0/3 (list tools over stdio in the sandbox, or HTTP for remote servers) (plan section 3).
- `semver` — resolve dependency ranges to concrete versions for OSV queries.
- `hono`, `@hono/node-server` — triage web server (plan section 3).
- `esbuild` (plugin dev) — bundle the plugin's MCP server into one file (plan 4.1).
- `yaml`, `zod` added to `apps/evals` (already workspace dependencies) — task metadata and tools file parsing.
- `@cc-setup-agent/evals` (workspace) added to `apps/pipeline` — the weekly scheduled eval job reuses the M9 harness.
