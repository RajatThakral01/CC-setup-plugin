# Progress

## Current state

- **Session range:** M8.3 round 2 (owner answers 2026-10-20: vetoes, policy-v2/v3, gate 3 coverage, gold tiers, snapshot, eval batch, block lifting).
- **Current milestone:** 8.3 done. Snapshot `2026.10.20-1` published (32 provisional + 1 blocked). Next: owner decisions on eval timeouts and booking (see Open questions), then M10.
- **Total Anthropic API spend to date (ledger):** USD 11.2771 (eval USD 10.7879, of which USD 10.50 is 7 timed-out runs booked at the USD 1.50 cap; classification USD 0.4892). Weekly cap USD 20 (USD 11.14 used this week), total cap USD 40.
- **Remote:** https://github.com/RajatThakral01/CC-setup-plugin — pushed after every milestone; CI green.

## Milestones

| #   | Milestone                   | Status                                              | Commit |
| --- | --------------------------- | --------------------------------------------------- | ------ |
| 0   | Repo and tooling            | Done                                                | M0     |
| 1   | Shared schemas and database | Done                                                | M1     |
| 2   | Seed catalog importer       | Done                                                | M2     |
| 3   | Discovery jobs              | Done                                                | M3     |
| 4   | Credibility gates 0 to 3    | Done                                                | M4     |
| 5   | Triage UI                   | Done                                                | M5     |
| 6   | Signed catalog snapshot     | Done                                                | M6     |
| 7   | Plugin MCP server           | Done                                                | M7     |
| 8   | Plugin packaging            | Built; owner acceptance pending                     | M8     |
| 8.1 | Fixes before acceptance     | Done                                                | M8.1   |
| 9   | Eval harness                | Built; pilot done; full eval pending owner go-ahead | M9     |
| 8.2 | Fixes after M8 acceptance   | Done; owner re-acceptance pending                   | M8.2   |
| 8.3 | Autonomous curation         | Done; snapshot waits for the owner's report         | M8.3   |
| 10  | End-to-end acceptance       |                                                     |        |

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

## Milestone 8 — Plugin packaging, commands and skill (built; owner acceptance pending)

Built: plugin manifest, MCP server declaration, `/setup`, `/setup-check`, `/setup-rollback`, `/explain` commands, the `setup-guide` skill (plan M8 step order and rules), local marketplace, single-file bundle (`pnpm plugin:build`), `README.md` with install steps, `docs/M8_ACCEPTANCE.md`.

Automated checks (all green): `claude plugin validate` passes for the plugin and the marketplace; the bundled server starts over stdio, lists its 9 tools, rejects a catalog signed with a foreign key, and analyses a fixture project; the bundle contains no database, pipeline or Anthropic SDK code; packaging test (manifests, commands, skill, tool names referenced by the skill and commands).

Acceptance (owner-run, pending):

- [ ] Owner installs the plugin into Claude Code from the local marketplace and completes `/setup` on a fresh Next.js app.
- [ ] `/setup-rollback` restores the original files exactly (byte compare). Covered by an automated byte-compare test on fixtures; the live check is in the owner's steps.

## Milestone 8.1 — Fixes before acceptance (done)

Built:

- **Opus for users:** model rules moved to `apps/plugin/server/model-rules.ts`; Opus is suggested only for complex work with budget sensitivity `low`, with a cost note. `complexity` is inferred by the skill from the goal (no sixth question). `pnpm check:models` exempts exactly that file. LLM client and config Opus refusal unchanged; CLAUDE.md states the distinction.
- **Vendor matching:** the vendor preference applies only to unflagged items with at least medium confidence; otherwise normal ranking, and the plan says why.
- **Hook recipes:** `format-on-edit` (Prettier or Biome), `lint-on-edit` (ESLint or Biome), `typecheck-on-stop` (typecheck script or `tsc --noEmit`), offered per detected tooling, approved one by one, merged into `.claude/settings.json` as a diff; existing hooks are never changed; re-runs are idempotent.
- **NFR-9:** Claude Code version detected from the MCP handshake (fallback `claude --version`); `generate_config` refuses outside `>= 2.0.0 < 2.2.0` with a clear message.
- **Python image:** config now refuses Python images below 3.13. `.env.example` line still to be changed by the owner (blocked by the `.env.*` deny rule; command in the session report).
- `docs/M8_ACCEPTANCE.md` updated (version check, Opus suggestion, hook proposals and a hook check).

Tests: model rules, scanner exception narrowness, vendor gating (flagged, low, medium), tooling detection, hook recipes, generated hook commands executed against fake formatter/linter/typecheck binaries (exit codes, `stop_hook_active`), hook merge (append-only, idempotent, same-tool skip, malformed config), generate with hooks, version gate (unit + through the MCP server), Python image guard. 461 tests (+4 real-Docker skipped locally, run separately: 34 sandbox tests green).

## Milestone 9 — Eval harness (built; pilot run; full evaluation waits for the owner)

Built (`apps/evals`):

- Next.js fixture app and 5 `browser_testing` tasks with hidden, deterministic Playwright checks and known-good solutions; `pnpm evals selftest` proves each check fails on the broken state and passes on the solution (5/5, real image, no API calls).
- Eval image (`pnpm evals image`): pinned node base, fixture with dependencies, Chromium builds for the fixture and for Playwright MCP, Claude Code 2.1.303.
- Docker driver with its own sandbox policy: the agent container never holds the API key (relay swaps a placeholder for the real key), the relay refuses non-Haiku/Sonnet models (so no Opus), egress only to an allowlist (others denied and logged), no mounts, non-root, limits, always removed.
- Runner: budget pre-flight with measured costs, `--max-budget-usd` capped at what's left, ledger rows from Claude Code's reported usage, `eval_runs` rows (now with `stage`), artifacts via `ArtifactStore`.
- Two-stage evaluation (Haiku screening ×3, Sonnet confirmation ×1) against the category incumbent, baseline cache by key, early stop, batch pre-flight with `eval_queue`, summary on the scorecard; triage shows the summary and every run.
- CLI: `image`, `selftest`, `pilot`, `run`, `plan`, `queue`, `cleanup`; paid commands need `--confirm-spend`.

Acceptance:

- [x] Pilot costs recorded; weekly run plan computed and documented (DECISIONS, M9 pilot).
- [x] One category has 5 tasks with deterministic checks that pass on a known-good solution and fail on the broken starting state (`pnpm evals selftest`, 5/5).
- [ ] At least one candidate evaluated against a baseline, with results visible in triage. **Not run: the owner allowed only the pilot this session.** Built and tested with the fake driver (`evaluate.test.ts`) and a triage route test; the pilot runs already show on the Playwright MCP item page. Command when approved: `pnpm evals run --item microsoft-playwright-mcp --confirm-spend` (incumbent: `anthropics-skills-webapp-testing`).
- [x] Ledger never exceeds USD 20 in any ISO week; a test drives worst-case runs until refusal (eval ≤ 17, week ≤ 20).
- [x] No Opus call is possible anywhere: config refusal and `check:models` (CI), `runOne` refuses before running, the relay refuses Opus requests (test), and the container maps every alias to Haiku/Sonnet (real-Docker test).

Tests (499 + 5 real-Docker, all green): task loader and version hashing, output parser, policy (every rule), relay (key swap, model refusal, egress denial, no key in logs), costs and plan maths, runner/evaluate on a test DB with a fake driver (ledger, artifacts, Opus refusal, pre-flight, hard stop, cap at budget left, unparsed output, cache keys, early stop, Stage B, queue), real-Docker driver with a fake `claude`, triage eval section.

## Milestone 8.2 — Fixes after the M8 owner acceptance (done; owner re-acceptance pending)

The owner's M8 acceptance on a fresh Next.js 16 app passed install, hooks (typecheck) and the rollback byte compare, and failed recommendation quality and the broken-server check. Fixed:

- **A. Recommendation quality:**
  - Triage shows kind and category prominently and lets the owner edit them; owner-set values are never re-classified.
  - The classify-v3 prompt uses README and component lists, has stricter categories and a new `technologies` field. All non-rejected items were re-classified; changed items are flagged for review in triage.
  - Per-category fit rules (vendor-specific items need the vendor detected or stated; deploy needs the stated target) and a minimum fit bar, with "no suitable item in the catalog yet" gaps.
  - Reasons name the specific signal. Fit and credibility are shown separately.
  - Context overhead includes skills and plugins (descriptions always loaded; largest body on use).
  - Provisional means "approved before evals"; "new" only for items under 180 days old.
- **B. Project analysis:** AGENTS.md detected (and imported from the CLAUDE.md block); a settings-only `pnpm-workspace.yaml` is not a monorepo.
- **C. Config and skill:**
  - The CLAUDE.md block has the real package.json commands, the `@AGENTS.md` import and one "when to use" line per tool, with no category ids.
  - The skill shows every file's full diff and writes one file at a time when asked.
  - Plugin installs use `--scope project`; `/setup-rollback` previews and gives the uninstall commands.
- **D. Hooks:** lint warnings go back to Claude as non-blocking context and errors stay blocking; a Stop-hook lint pass over git-changed files covers shell edits.
- **E. verify_setup:** runs every check per server (package version resolves, env vars, start with placeholder values for local servers) and reports all failures together.
- **F.** `docs/M8_ACCEPTANCE.md` rewritten: a real ESLint error and a type error, a byte compare that ignores git-ignored build output, and auto mode switched off.
- **G.** Python Playwright 1.64.0 in the eval image, checked by `pnpm evals selftest`.

Live: gates re-run on all 140 non-rejected items (0 errors), `classify --all` (USD 0.0388): **47 items changed kind or category** and are flagged "needs classification review" in triage. Two of them are approved items that now have no category (Discord, CLAUDE.md management); the snapshot leaves them out. Snapshot `2026.10.19-2` published (8 items). Eval image `ccsa-eval:2ccdf8d0b1836b19` built; `pnpm evals selftest` 6/6 (Python Playwright + 5 tasks), no API calls.

Tests: 544 passing (+5 real-Docker run in CI). Each item has regression tests:

- triage edit, review filter and owner lock;
- the classifier prompt, components input and `--all` mode;
- fit rules, gaps, signals, fit vs credibility, context cost, provisional and new wording;
- AGENTS.md and monorepo detection;
- the CLAUDE.md block;
- skill and command text (full diffs, one file at a time, project scope, rollback preview);
- project-scope plugin rollback;
- lint warnings, errors and the Stop pass, run against fake tools in a real git repo;
- verify with all failures together;
- the eval image Dockerfile and its Python Playwright check.

Details and decisions: DECISIONS "Milestone 8.2".

## Milestone 8.3 — Autonomous curation (done)

Owner decision: no manual review of classifications or tools; "when unsure, don't recommend".

Built:

- **Docs:** PRD 0.4 (FR-C9 policy approval with optional veto, FR-D9a, FR-P1 to FR-P9), plan rule 4, 6.1 and an M8.3 section, CLAUDE.md.
- **Status rules:** actor `policy:<version>`; demotion to candidate; the policy can't use override notes, approve flagged or vetoed items; approvals record the reviewer.
- **Classification without review:**
  - rules + Haiku + Sonnet second opinion must agree;
  - input hash with `classify --changed`;
  - gold set (`catalog/classification-gold.yaml` + owner locks) and `classify:eval` with the prompt gate;
  - owner-approved kind/category kept on re-classification;
  - Sonnet 5.5 thinking fix (`between_tools`).
- **Approval policy:**
  - `catalog/policy.yaml` (`policy-v1`) with pure evaluators;
  - `pnpm run pipeline policy`;
  - `policy_decisions` per item;
  - gate 0 re-check failures of provisional items → watchlist.
- **Scheduled evals:** `auto-evals` planner/runner within the weekly and total caps (reserve USD 5); the plan is written before spending.
- **Owner role optional:** weekly digest (`reports/digest-<week>.md`, triage `/digest`), one-click veto and lift-veto, a policy panel on every item page; the review filter is an optional view.
- **Worker:** `policy-daily` (classify --changed + policy), `evals-weekly`, `digest-weekly`.

Acceptance:

- [x] Every policy rule has a unit test (approve, each refusal, community eval, promotion, each demotion trigger, veto, eval need): `packages/shared/src/policy.test.ts`, `category-rules.test.ts`.
- [x] The policy never approves security-flagged, vetoed or unknown-install items (unit, `transitionStatus` DB tests, policy run DB tests).
- [x] Policy changes carry `policy:<version>` and an audited reason (DB tests; live: 29 events by `policy:policy-v1`).
- [x] A worse-scoring prompt version can't be applied (gold/prompt-gate tests; classify refuses).
- [x] Scheduled evals stay within the weekly and total caps (incl. reserve) and log the plan before spending (tests).
- [x] Live policy report prepared for the owner; no snapshot published.

Live (2026-10-20):

- **Classification:** `classify --changed` re-classified all 140 items once (no hashes yet): USD 0.0371.
- **Gates:** 3 plugins with stale installs re-gated.
- **Second opinions:** 29 asked, 29 agreed: USD 0.1962.
- **Policy:** 29 approved to provisional (all official-vendor tier), 0 promoted, 0 demoted, 111 held.
- **Gold set:** classify-v3 scores 6/10 (USD 0.0032).
- **Scheduled evals:** 3 browser-testing items planned, worst case USD 4.13; not run.

Tests: 682 passing (+5 real-Docker run in CI). Details: DECISIONS "Milestone 8.3".

### M8.3 round 2 (owner answers, 2026-10-20)

- Vetoes: discord, claude-md-management, cloudflare-skills.
- **policy-v2:** owner approvals re-checked. 5 of the 7 others pass on their own (context7, webapp-testing, frontend-design, sentry-for-ai, fetch); clerk and supabase went back to candidate because their bundled remote MCP server can't be verified.
- **policy-v3:** policy approvals whose gate 3 no longer passes went back to candidate (7).
- **Gate 3 coverage:** every skill, command and agent text, the config files and bundled MCP servers. `not_run` 55 → 21. A false-positive auto-block of 5 items was fixed and, on the owner's answer, unblocked (davila7 stays blocked on real evidence).
- **Approval count:** 39 → 32 (−3 vetoes, −2 superseded owner approvals, −7 incomplete security scans, +6 newly scannable Anthropic/Datadog plugins, −1 net from Datadog's block and unblock).
- **Gold set:** 10 owner + 27 high-agreement labels; classify-v3 scores 7/10 and 24/27.
- **Block lifting:** policy lifts its own vulnerable-dependency blocks only (FR-P10); org lock for injection/exfiltration; snapshots carry blocked versions.
- **Eval batch:** chrome-devtools-mcp `equal` vs webapp-testing (15/15 each); playwright-mcp stopped at 3/3; testdino not evaluable (repo-root skill). Booked USD 10.64 against the USD 4.13 approved, because timed-out runs are booked at their cap and the ceiling was not enforced during the runs. Fixed: per-run batch ceiling.
- Snapshot 2026.10.20-1 published.

## Open questions

- Owner: eval timeouts. 7 of 33 runs hit 300 s and were booked at USD 1.50 each. Raise `EVAL_TIMEOUT_SECONDS`, or book unreadable runs differently (for example from relay-observed usage)?
- Owner: repo-root skills (testdino and others) can't be fetched by the eval harness yet; build that (free code change) before the next batch?
