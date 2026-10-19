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
