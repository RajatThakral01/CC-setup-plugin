# Claude Code Setup Agent — Product Requirements Document

Oct 19, 2026 · @Rajat

## 1. Document control

This is draft v0.1 of the PRD for a Claude Code plugin that recommends, builds and maintains an evidence-backed Claude Code setup for a given project.

| Field | Value |
| --- | --- |
| Product (working name) | Claude Code Setup Agent |
| Document type | Product Requirements Document |
| Version | 0.1 (draft) |
| Owner | Product owner and solo builder (author) |
| Reviewers | To be named |
| Target release | MVP (Phase 1), dates to be set |

### Change log

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 19 Oct 2026 | First full draft |
| 0.2 | 19 Oct 2026 | FR-D10: candidate intake filter and daily cap (owner decision) |
| 0.3 | 19 Oct 2026 | FR-D10: classify before ranking; relevance-first priority; out-of-scope marking (owner decision) |

## 2. Executive summary

We will build a Claude Code plugin that interviews a developer, reads their project, and generates a short, justified, working Claude Code setup: model and effort, `CLAUDE.md`, MCP servers, skills, subagents, hooks, permissions and plugins.

The setup is drawn from a continuously updated catalog. Every catalog item passes a series of credibility gates: hygiene, provenance, health, security, real-user signal and, for shortlisted items, our own automated evals that run Claude Code with and without the tool.

The product does not recommend a tool because an article praised it. It recommends a tool when evidence shows it beats the current recommendation for that use case. It writes nothing without the user's approval, and it can roll every change back.

Scope for v1 is Claude Code only, starting with one to three project stacks. Other coding agents (Cursor, Codex, Gemini CLI) are explicitly out of scope until v1 proves its value.

## 3. Problem statement

Developers using Claude Code cannot reliably tell which of the many new MCP servers, skills, plugins and settings released each week will actually improve their results for a specific project.

### 3.1 The problem in detail

1. **Tool churn outpaces attention.** New MCP servers, skills, plugins and Claude Code features ship weekly. Keeping up is a part-time job that most developers cannot do.
2. **LLMs give stale advice.** Asking Claude or another model "what's the best setup" returns answers bounded by its training cutoff. It recommends what was popular months ago.
3. **Discovery sources have no quality signal.** Registries list thousands of MCP servers with little judgment. Listicles and blog posts are often SEO-driven, sponsored or written before anyone used the tool.
4. **Popularity signals are gameable.** GitHub stars can be bought. Download counts can be inflated by CI pipelines. Neither proves a tool works.
5. **More tools is often worse.** Each MCP server adds tool definitions to the context window and expands the security surface. A bloated setup can lower output quality.
6. **MCP servers carry real security risk.** An MCP server is third-party code running on the developer's machine. Malicious tool descriptions can carry prompt injections ("tool poisoning").
7. **Configuration is tedious and error-prone.** Even with the right tool list, writing `CLAUDE.md`, `.mcp.json`, permissions and hooks correctly takes time and documentation reading.

### 3.2 Who feels it

Any developer who uses Claude Code for real projects, most sharply those starting a new project or returning to Claude Code after a few months away.

### 3.3 Why now

- MCP has become the standard way to connect coding agents to tools, and the number of servers keeps growing.
- Claude Code now has plugin and skill systems, so a setup can be packaged and installed as a unit.
- Headless Claude Code (`claude -p`) makes automated, repeatable evaluation of tools practical.

### 3.4 Problem in one sentence

There is no trusted, current, evidence-based way to answer: "For this project, what is the best Claude Code setup today, and is it actually better than what I have?"

## 4. Goals, non-goals and success metrics

The product succeeds if a user goes from an empty or stale project to a verified, working Claude Code setup in under 15 minutes, and that setup measurably outperforms a default setup on our benchmark tasks.

### 4.1 Goals

1. Recommend a minimal, justified Claude Code setup for a stated goal and stack.
2. Generate and, with approval, apply the complete configuration.
3. Back every recommendation with a visible credibility scorecard.
4. Keep the catalog current, with new items discovered within 48 hours of release.
5. Tell users when their existing setup has a better, safer or still-maintained alternative.

### 4.2 Non-goals (v1)

- Supporting coding agents other than Claude Code.
- Listing every tool that exists. The catalog is curated, not exhaustive.
- Hosting or proxying MCP servers.
- Managing secrets or API keys on the user's behalf.
- Recommending general application libraries (React vs Vue). We recommend the agent environment, not the app stack.
- Paid tiers, billing or team management.

### 4.3 Success metrics

All targets are initial hypotheses, to be revised after the first 30 days of real usage.

| Metric | Definition | v1 target |
| --- | --- | --- |
| Time to working setup | `/setup` start to `verify_setup` passing | Under 15 minutes |
| Setup acceptance rate | Share of recommended items the user approves | Over 70% |
| Verify pass rate | Share of applied setups where all servers start and no config errors occur | Over 95% |
| Eval uplift | Benchmark success rate, recommended setup vs default setup, same model | Positive in every supported stack |
| Discovery latency | Release date to catalog candidate entry | Under 48 hours |
| Catalog freshness | Share of recommended items re-checked in the last 30 days | 100% |
| Rollback rate | Share of applied setups the user rolls back within 7 days | Under 10% |
| Security incidents | Recommended items later found malicious | Zero |

## 5. Target users and personas

The primary v1 user is an individual developer who already uses Claude Code and wants a better setup without researching the ecosystem themselves.

| Persona | Context | Main need | Main fear | Priority |
| --- | --- | --- | --- | --- |
| Builder starting a new project | Solo or small-team developer, comfortable with Claude Code basics | A strong setup on day one | Wasting hours on tools that don't help | Primary |
| Returning user | Used Claude Code months ago, setup is stale | Know what changed and what to replace | Breaking a setup that mostly works | Primary |
| Newcomer to Claude Code | Knows how to code, new to agentic tools | A safe, simple, explained starting point | Installing something risky they don't understand | Secondary |
| Team lead | Standardising Claude Code across a team repo | One reviewed, shared project config | Security and inconsistency across developers | Later (Phase 3) |
| Catalog maintainer (internal) | The product owner reviewing candidates | A fast triage queue with evidence | Recommending something bad or malicious | Primary (internal) |

## 6. Competitive landscape and differentiation

Discovery and installation are already served; nobody yet combines use-case matching, evidence-based credibility and a verified working config, and that combination is our only defensible position.

This landscape reflects knowledge as of mid-2026 and was not re-verified with live web research. Re-check it before any external use.

| Category | Examples | What they do well | Gap we fill |
| --- | --- | --- | --- |
| MCP registries | Official MCP Registry, Smithery, Glama, PulseMCP, mcp.so, Docker MCP Catalog | Broad listings, install metadata, some quality scores | No use-case fit, no outcome evals, little curation |
| Curated lists | awesome-claude-code, awesome-mcp-servers, cursor.directory | Human taste, community input | Go stale, no evidence, no config output |
| Installers and templates | claude-code-templates (aitmpl.com), plugin and skill marketplaces | One-command install | Install what you pick; don't pick for you or prove it works |
| Fresh docs for agents | Context7 | Current library docs inside the agent | Docs only, not environment setup |
| Model benchmarks | Artificial Analysis, SWE-bench, Aider leaderboard, LMArena | Model comparison | Models only, not tools or configs |
| Platform vendors | Anthropic (`/init`, plugin marketplaces) | Native integration, trusted | May not rank third-party tools; can absorb basic setup features |

### 6.1 Differentiators

1. **Outcome evals.** We run Claude Code with and without each shortlisted tool on fixed tasks and publish the results.
2. **Fewer, better recommendations.** We optimise for the smallest setup that wins, and explain what we left out.
3. **Working output.** We generate and verify the actual config files, not a reading list.
4. **Ongoing maintenance.** `check_updates` tells users when their setup has drifted, been superseded or become unsafe.

### 6.2 Biggest competitive threat

Anthropic or a large marketplace adds evidence-based recommendations natively. Mitigation: keep the eval data and catalog portable, and focus on depth in a few stacks where we can be clearly better.

## 8. User journeys and use cases

The core journey is interview, analyse, recommend, approve, apply, verify; every other use case is a variation of it.

### 8.1 Core journey: new project setup

1. User installs the plugin and runs `/setup` inside a project folder.
2. The agent calls `analyze_project` and reports what it detected (language, framework, package manager, existing `.claude/` config).
3. The agent asks at most five questions: goal, deployment target, budget sensitivity, risk tolerance, preferred workflow (for example, test-first).
4. The agent calls `recommend_setup` and shows a plan: each item with its reason, scorecard summary and trade-off, plus items deliberately left out.
5. The user approves, removes or swaps items individually.
6. The agent calls `generate_config`, shows the diffs, and Claude Code writes the approved files through its normal permission prompts.
7. The agent tells the user which environment variables to set, without ever asking for the values.
8. The agent calls `verify_setup` and reports pass or fail per item, with fixes for failures.

### 8.2 Use cases

| ID | Use case | Trigger | Outcome | Phase |
| --- | --- | --- | --- | --- |
| UC-01 | Set up a new project | `/setup` in a project with no Claude Code config | Approved setup written and verified | 1 |
| UC-02 | Improve an existing setup | `/setup` where `.claude/` or `.mcp.json` exists | Diff-based plan: keep, replace, remove, add | 1 |
| UC-03 | Explain a tool | "Is X any good?" or `/explain X` | Scorecard with evidence and alternatives | 1 |
| UC-04 | Check for updates | `/setup-check` or a weekly prompt | List of superseded, unmaintained or unsafe items, with replacements | 2 |
| UC-05 | Roll back | `/setup-rollback` | Config restored to the last backup | 1 |
| UC-06 | Compare two tools | "X vs Y for testing" | Side-by-side scorecard and eval results | 2 |
| UC-07 | Set up from a goal only | Empty folder, user describes the project | Setup recommended for the stated stack before code exists | 2 |
| UC-08 | Team baseline | Team lead runs setup in a shared repo | Project-scope config committed for the team, no user-scope changes | 3 |
| UC-09 | Triage new candidates (internal) | Daily discovery run | Ranked candidate queue with gate results for the maintainer | 1 |

## 7. Product scope and phased release plan

v1 is one Claude Code plugin for one stack, with a small hand-reviewed catalog and evals in at least one category; everything else waits behind a measurable gate.

### 7.1 In scope (MVP)

- Claude Code only, on macOS, Linux and Windows (WSL).
- One project stack (proposed: Next.js website).
- Catalog of 50 to 100 reviewed items: MCP servers, skills, plugins, subagents, hook recipes, model settings.
- Discovery sources: Claude Code changelog, MCP Registry, GitHub, official marketplaces.
- Credibility gates 0 to 3, plus outcome evals for at least one category.
- `/setup`, `verify_setup`, `/setup-rollback`, `/explain`.

### 7.2 Out of scope (MVP)

- Other coding agents, team features, paid tiers.
- Web crawling of blogs and articles.
- Automatic `recommended` status without human approval.

### 7.3 Roadmap

&#91;embedded content: phased release · 3 phases, 2 gates\]

Dates are not yet set. Phase 1 is the current focus; each gate is a go or no-go decision, and a failed gate means fixing the current phase, not starting the next.

## 9. Functional requirements

Requirements are grouped by module; P0 is required for MVP, P1 for the release after, P2 later.

### 9.1 Discovery (staying current)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-D1 | Ingest the Claude Code changelog and releases daily and flag changes to config formats, settings keys, plugin structure or model options. | P0 |
| FR-D2 | Poll the official MCP Registry API daily for new and updated servers. | P0 |
| FR-D3 | Search the GitHub API daily for repos with topics such as `mcp-server`, `claude-code`, `claude-skills`, `claude-code-plugin`, created or updated in the last 7 days. Record star velocity. | P0 |
| FR-D4 | Query npm and PyPI for packages with MCP and Claude Code keywords. Record weekly download trend. | P1 |
| FR-D5 | Track official plugin marketplaces and vendor-published MCP servers. | P0 |
| FR-D6 | Track commit diffs of selected awesome-lists as a curated discovery signal. | P1 |
| FR-D7 | Pull discussion signals from Hacker News (Algolia API) and Reddit (r/ClaudeAI, r/ClaudeCode). Used as signals, never as the sole basis for a recommendation. | P1 |
| FR-D8 | Deduplicate records into one entity per tool, keyed by canonical repo URL or package name. | P0 |
| FR-D9 | Use an LLM to classify each new entity: category, what it does, supported stacks, official vs community. Store the classification with its model and prompt version. | P0 |
| FR-D10 | Every raw source record is stored. An entity enters with status `candidate` only when it passes the intake filter: not a fork, not archived, has a licence and a description, and at least 10 stars (repos owned by orgs in `catalog/vendors.yaml` and MCP Registry verified publishers skip the star threshold); MCP Registry entries must also be the latest version and have a repo URL. Up to 300 filter-passing records per day are classified first (within the classification budget), so relevance is known before ranking. At most 30 new candidates per day, prioritised by relevance to the MVP stack (Next.js), then vendor allowlist, then star velocity, then stars. Accepted items that are not relevant to a stack are marked out of scope for it (hidden from that stack's triage queue by default, never deleted or rejected). Stored raw records are re-checked daily and become candidates once they pass. Discovery never sets status `recommended`. | P0 |
| FR-D11 | Generic blog and listicle crawling is out of scope for v1. | P0 |

### 9.2 Credibility gates

Gates run in order from cheapest to most expensive. An item failing a hard gate stops there.

| ID | Gate | Checks | Fail behaviour | Priority |
| --- | --- | --- | --- | --- |
| FR-C0 | Hygiene | License present, README, real code (not empty or a bare fork), installs and starts | Hard fail: `rejected` | P0 |
| FR-C1 | Provenance | Official vendor vs community; publisher verified in registry; author's other maintained projects | Soft: lowers confidence | P0 |
| FR-C2 | Health | Last commit, release cadence, issue response time, contributor count, download trend | Soft; no commit in 180 days = `watchlist` | P0 |
| FR-C2a | Anti-gaming | Star-to-download ratio, star bursts, stars from new accounts | Flag for manual review | P1 |
| FR-C3 | Security | Scan tool descriptions for hidden instructions; list capabilities (shell, file, network); dependency vulnerabilities (OSV); install scripts; sandboxed run with network monitoring | Hard fail on injection or undisclosed exfiltration: `blocked` | P0 |
| FR-C4 | Real-user signal | Count independent first-hand reports across sources; LLM classifies first-hand vs hype | Soft | P1 |
| FR-C5 | Outcome eval | See 9.3 | Determines `recommended` vs incumbent | P0 for MVP stacks |
| FR-C6 | Scorecard | Store each gate result with evidence links, timestamps and an overall confidence (low, medium, high) | n/a | P0 |
| FR-C7 | Status lifecycle | `candidate`, `watchlist`, `recommended (provisional)`, `recommended`, `deprecated`, `blocked`, `rejected` | n/a | P0 |
| FR-C8 | Re-check | Re-run gates 0 to 3 every 30 days on all recommended items, and on any new release | Downgrade on failure | P0 |
| FR-C9 | Human approval | In v1, `recommended` requires maintainer approval in the triage queue | n/a | P0 |

### 9.3 Eval harness

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-E1 | Maintain 5 to 10 benchmark tasks per category and stack, each with an automatic pass or fail check (tests, file assertions, output match). | P0 |
| FR-E2 | Run Claude Code headless (`claude -p`) in an isolated container, with and without the candidate, at least 3 runs each. | P0 |
| FR-E3 | Record success rate, tokens used, wall time, tool-definition context overhead and error count per run. | P0 |
| FR-E4 | Compare the candidate against the current recommended incumbent in its category, not against nothing. | P0 |
| FR-E5 | Pin the model, Claude Code version and task set for each eval run, so results are reproducible. | P0 |
| FR-E6 | Enforce a weekly eval budget (tokens and money) and queue overflow by priority. | P0 |
| FR-E7 | Tools that need third-party accounts use sandbox or test accounts, or are marked "not evaluated" with reduced confidence. | P1 |
| FR-E8 | Re-run evals for recommended items when the model or Claude Code version changes materially. | P1 |

### 9.4 Recommendation engine

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-R1 | Accept goal, detected stack and constraints (budget, risk tolerance, workflow preferences). | P0 |
| FR-R2 | Recommend only `recommended` or `recommended (provisional)` items; never `candidate`, `blocked` or `rejected`. | P0 |
| FR-R3 | Prefer the smallest set that covers the use case. Flag total tool-definition context overhead. | P0 |
| FR-R4 | For each item, return reason, scorecard summary, trade-off and confidence. | P0 |
| FR-R5 | Return the items deliberately excluded and why. | P0 |
| FR-R6 | Recommend model and effort level with a cost vs capability note. | P0 |
| FR-R7 | Detect conflicts (two tools covering the same job, incompatible versions) and resolve to one. | P0 |
| FR-R8 | Recommendations must be reproducible: same input and catalog version produce the same output. | P1 |

### 9.5 Config generation and apply

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-G1 | Generate `CLAUDE.md`, `.mcp.json`, `.claude/settings.json` (permissions, hooks, env placeholders), subagents, skills and plugin install commands. | P0 |
| FR-G2 | Write to project scope by default. Touch user scope (`~/.claude/`) only on explicit request. | P0 |
| FR-G3 | Show a diff for every file before writing. Writes go through Claude Code's own permission prompts. | P0 |
| FR-G4 | Approval is per item, never one approval for a bundle. | P0 |
| FR-G5 | Back up every existing file before changing it, with a manifest of what was changed. | P0 |
| FR-G6 | Pin exact versions for MCP servers and packages. Never use `latest`. | P0 |
| FR-G7 | Never write secret values. Use environment variable placeholders and list required variables. | P0 |
| FR-G8 | Merge with existing config rather than overwrite; preserve user content in `CLAUDE.md`. | P0 |
| FR-G9 | Validate generated files against the current Claude Code config schema before showing them. | P0 |

### 9.6 Verify, update and rollback

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-V1 | `verify_setup` checks each MCP server starts, required env vars are set (presence only), settings parse, and there are no duplicate tools. | P0 |
| FR-V2 | On failure, return the item, the error and a suggested fix. | P0 |
| FR-U1 | `check_updates` compares the installed setup with the current catalog: superseded, deprecated, blocked, new version available. | P1 |
| FR-U2 | A blocked item already installed triggers a prominent warning on the next plugin run. | P0 |
| FR-B1 | `/setup-rollback` restores the last backup in one command and reports what it restored. | P0 |

## 10. Plugin and MCP interface

The product ships as one Claude Code plugin that bundles a local MCP server, slash commands and a setup skill; the MCP server returns plans and file contents, and Claude Code itself writes files under its normal permission prompts.

### 10.1 Plugin contents

| Component | Purpose |
| --- | --- |
| MCP server (local, stdio) | Exposes the tools below; reads a synced local copy of the catalog |
| `/setup` command | Starts the core journey (UC-01, UC-02) |
| `/setup-check` command | Runs `check_updates` (UC-04) |
| `/setup-rollback` command | Restores the last backup (UC-05) |
| `/explain` command | Scorecard for one tool (UC-03) |
| Setup skill | Instructions for the interview, plan presentation and approval rules |

### 10.2 MCP tools

| Tool | Input | Output | Side effects |
| --- | --- | --- | --- |
| `analyze_project` | project path | detected language, framework, package manager, test runner, existing Claude Code config | None (read-only) |
| `recommend_setup` | goal, stack, constraints | ranked items with reason, scorecard summary, trade-off, confidence; excluded items; model recommendation; context overhead estimate | None |
| `explain_item` | item name or id | full scorecard, evidence links, eval results, alternatives | None |
| `generate_config` | approved item list, existing config | file contents and diffs, required env var names, install commands | None (returns content only) |
| `verify_setup` | project path | per-item pass or fail, errors, suggested fixes | Starts servers briefly to test them |
| `check_updates` | project path | superseded, deprecated, blocked or outdated items with replacements | None |
| `rollback_setup` | project path, backup id (optional) | restored file list | Restores backed-up files |
| `sync_catalog` | none | catalog version and changes | Downloads signed catalog snapshot |

### 10.3 Interface rules

- The MCP server never writes project files except during `rollback_setup`, which restores files the plugin itself backed up.
- No tool accepts or returns secret values.
- Every response carries the catalog version used, so results are traceable.
- Tool descriptions are short, to keep the plugin's own context overhead low.

## 11. Data model

Five core entities: the catalog item, its signals over time, its scorecard, eval runs, and the user's applied setup (stored only on the user's machine).

### 11.1 `catalog_item`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable slug |
| `name` | string | Display name |
| `kind` | enum | `mcp_server`, `skill`, `plugin`, `subagent`, `hook_recipe`, `model_setting`, `claude_code_feature` |
| `category` | enum | For example `testing`, `browser`, `database`, `docs`, `deploy`, `code_review` |
| `stacks` | string\[\] | Supported stacks, for example `nextjs`, `python-data` |
| `source_url` | url | Canonical repo or package page |
| `publisher` | string | Organisation or author |
| `provenance` | enum | `official_vendor`, `community`, `anthropic` |
| `install` | object | Install command, pinned version, required env var names |
| `capabilities` | string\[\] | `shell`, `file_read`, `file_write`, `network`, and so on |
| `context_overhead_tokens` | int | Measured size of tool definitions |
| `status` | enum | Lifecycle from FR-C7 |
| `first_seen`, `last_checked` | datetime |  |
| `supersedes`, `superseded_by` | id | Replacement chain |

### 11.2 `signal_snapshot` (time series)

`item_id`, `captured_at`, `stars`, `star_velocity_7d`, `downloads_7d`, `last_commit_at`, `open_issues`, `median_issue_response_hours`, `contributors`, `mentions_firsthand`, `mentions_total`.

### 11.3 `scorecard`

| Field | Type | Notes |
| --- | --- | --- |
| `item_id`, `version` | string | Scorecard is per item version |
| `gate_results` | object | One entry per gate: pass, soft-fail or fail, evidence links, checked\_at |
| `security_findings` | object\[\] | Severity, description, evidence |
| `eval_summary` | object | Success rate, tokens, time, overhead vs incumbent |
| `confidence` | enum | `low`, `medium`, `high` |
| `reviewer`, `reviewed_at` | string, datetime | Human approval record |

### 11.4 `eval_run`

`run_id`, `item_id`, `item_version`, `baseline_item_id`, `task_set_version`, `model`, `claude_code_version`, `with_tool` (bool), `success`, `tokens`, `wall_seconds`, `errors`, `logs_ref`.

### 11.5 `applied_setup` (local only)

`project_path_hash`, `applied_at`, `catalog_version`, `items` (id and version), `files_changed`, `backup_id`. This never leaves the user's machine.

## 12. Non-functional requirements

Safety and trust outrank speed and breadth: a slow correct recommendation is acceptable, a fast unsafe one is not.

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-1 | Performance | `analyze_project` under 5 s for repos up to 10,000 files. `recommend_setup` under 10 s with a local catalog. |
| NFR-2 | Performance | Plugin's own tool definitions under 2,000 tokens of context overhead. |
| NFR-3 | Reliability | The plugin works offline with the last synced catalog; it states the catalog's age when it is older than 7 days. |
| NFR-4 | Reliability | Discovery jobs are idempotent and retry with backoff; a failed source never blocks the others. |
| NFR-5 | Security | Catalog snapshots are signed; the plugin rejects unsigned or tampered snapshots. |
| NFR-6 | Security | Eval and security sandboxes run in isolated containers with no access to production secrets and egress logging on. |
| NFR-7 | Security | No secret values are read, stored, logged or transmitted by the plugin or backend. |
| NFR-8 | Privacy | No project code, file contents or file paths leave the user's machine. Optional telemetry sends only anonymous counts (items approved, verify pass or fail), opt-in. |
| NFR-9 | Compatibility | Supports the current and previous minor Claude Code versions; refuses to write config for unsupported versions and says why. |
| NFR-10 | Compatibility | macOS, Linux and Windows (WSL) for v1. |
| NFR-11 | Cost | Eval spend capped by a weekly budget set by the maintainer; discovery and gates 0 to 3 run within a free or low-cost API tier where possible. |
| NFR-12 | Transparency | Every recommendation links to its evidence; no hidden ranking factors; no paid placement. |
| NFR-13 | Auditability | Every status change in the catalog is logged with actor, reason and timestamp. |

## 13. System architecture

A hosted backend discovers, scores and evaluates tools and publishes a signed catalog; a local plugin uses that catalog to plan the setup, and Claude Code writes the files.

&#91;embedded content: system architecture · backend and user machine\]

The eval harness is highlighted because it is the differentiator. Data flows one way into the user's machine: the plugin downloads the catalog and never uploads project code.

### 13.1 Proposed technology choices

| Component | Proposed choice | Reason |
| --- | --- | --- |
| Plugin MCP server | TypeScript or Python, stdio transport | Standard for local MCP servers |
| Discovery jobs | Scheduled workers (cron or a job queue) | Simple, idempotent, retryable |
| Catalog database | PostgreSQL | Relational entities plus time-series signals |
| Eval sandbox | Docker containers, egress logged | Isolation and repeatability |
| Snapshot distribution | Signed JSON file on object storage or a release | Cheap, cacheable, verifiable |
| Triage UI | Minimal internal web page | Maintainer approves or rejects candidates |

These are proposals for discussion, not decisions.

## 14. Edge cases and failure handling

The default for any uncertain case is to do less, explain why, and leave the user's existing setup untouched.

### 14.1 Project and environment

| Case | Expected behaviour |
| --- | --- |
| Empty folder, no code | Ask for the intended stack (UC-07); recommend from the stated stack and mark it as unverified against real code. |
| Monorepo with several stacks | Detect each package; ask whether to configure the root, one package or each package separately. |
| Unsupported stack | Say so plainly; offer only stack-independent items (for example, a docs MCP, safe permissions) at low confidence. |
| Existing hand-written `CLAUDE.md` | Never overwrite; propose additions as a separate, clearly marked section the user approves. |
| Existing `.mcp.json` with unknown servers | Keep them; label them "not in catalog"; never remove without explicit approval. |
| Existing setup already includes a blocked item | Show a prominent warning first, with a removal option and a reason. |
| User-scope config conflicts with project config | Explain which one wins in Claude Code and offer to align them; never edit user scope unasked. |
| Unsupported Claude Code version | Refuse to write config; tell the user which version is needed. |
| No Git repo | Warn that rollback relies on plugin backups only; continue. |
| Read-only or permission-restricted folder | Return contents as diffs for the user to apply manually. |

### 14.2 Tools and catalog

| Case | Expected behaviour |
| --- | --- |
| Recommended MCP server fails to start in `verify_setup` | Report the error and fix; offer to remove it or swap to the next-ranked item. |
| Required env var missing | Report the variable name only; never ask for or print its value. |
| Two recommended tools overlap | Keep the higher-scoring one; list the other as excluded with the reason. |
| An item is renamed or its repo moves | Discovery links it via `supersedes`; existing users are told on next `check_updates`. |
| A tool is abandoned (no commits 180 days) | Move to `watchlist`; recommend a replacement when one exists. |
| A tool is found malicious after users installed it | Set `blocked`; signed catalog update; warning on next plugin run; publish a short advisory. |
| Upstream publishes a new version with breaking changes | Keep pinned version; re-run gates on the new version before recommending it. |
| Catalog older than 7 days, offline | Proceed with a visible staleness warning. |
| Catalog signature invalid | Refuse to use it; fall back to the last valid snapshot. |

### 14.3 Discovery and evals

| Case | Expected behaviour |
| --- | --- |
| Source API rate-limited or down | Back off and retry; other sources continue; alert the maintainer after 24 hours of failure. |
| Sudden star spike on a new repo | Flag for anti-gaming review; do not fast-track. |
| Viral post praising an untested tool | Counts as one mention; no status change without gates. |
| Eval results are flaky (high variance) | Increase runs to 5; if still unstable, mark result "inconclusive". |
| Tool needs a paid third-party account | Use a sandbox account if available, else mark "not evaluated" and cap confidence at medium. |
| Model or Claude Code update changes eval outcomes | Re-run evals for affected categories; hold status changes until results are in. |
| Weekly eval budget exhausted | Queue remaining candidates by priority score; never skip security gates to save budget. |

## 15. Risks and mitigations

The two risks most likely to sink the product are recommending something harmful and the eval moat proving too expensive to maintain.

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | A recommended tool turns out malicious | Low | Critical | Security gate, pinned versions, human approval, signed catalog, `blocked` status with warnings, re-checks every 30 days |
| R2 | Eval costs exceed budget | High | High | Evals only for shortlisted items; weekly cap; small task sets; reuse incumbents' baseline runs |
| R3 | Claude Code config format changes break generated setups | High | High | Changelog ingestion (FR-D1), schema validation (FR-G9), version gating (NFR-9) |
| R4 | Anthropic or a large marketplace ships the same feature | Medium | High | Focus on eval depth and a few stacks; keep data portable; position as complement |
| R5 | Benchmarks don't reflect real-world use, so recommendations mislead | Medium | High | Tasks drawn from real projects; publish task sets; track rollback rate as a reality check |
| R6 | Catalog goes stale because one person maintains it | High | Medium | Automate the funnel; keep the catalog small; staleness warnings; limit stacks |
| R7 | LLM classification or sentiment errors | Medium | Medium | Store prompt and model versions; human review before `recommended`; spot-check samples weekly |
| R8 | Source API terms or rate limits change | Medium | Medium | Multiple sources per signal; caching; respect terms of service |
| R9 | Users distrust automatic writes | Medium | Medium | Per-item approval, diffs, backups, one-command rollback |
| R10 | Gaming by tool authors once the product matters | Low (early) | Medium | Anti-gaming checks; evals over popularity; no paid placement |

### 15.1 Known issues and limitations

- Some tools cannot be evaluated automatically (account-bound, GUI-heavy); they will carry lower confidence.
- Benchmark results are tied to one model and Claude Code version; they age.
- "Best" is partly taste. The product is opinionated and says so.

## 16. Dependencies and assumptions

The product depends on Claude Code's plugin, MCP and headless modes staying available, and on a handful of public APIs for discovery.

### 16.1 Dependencies

| Dependency | Used for | If it changes or fails |
| --- | --- | --- |
| Claude Code plugins, MCP support, settings files | Delivery and config targets | Version gating; schema updates from changelog |
| Claude Code headless mode (`claude -p`) | Eval harness | Evals pause; catalog keeps last results |
| Anthropic API | Eval runs, LLM classification | Budget and rate limits apply |
| Official MCP Registry API | Discovery | Fall back to GitHub and npm |
| GitHub API | Discovery and health signals | Rate-limited; authenticated token required |
| npm and PyPI APIs | Download trends | Degrade to GitHub-only health |
| OSV vulnerability database | Security gate | Cache last results; flag stale scans |
| Hacker News Algolia API, Reddit API | Real-user signals | Gate 4 confidence lowered |
| Docker or equivalent containers | Sandboxed evals and security runs | Evals pause |

### 16.2 Assumptions

- Users already have Claude Code installed and working.
- Users accept a curated, opinionated catalog over an exhaustive one.
- A small benchmark (5 to 10 tasks per category) gives a useful signal.
- One maintainer can review the weekly triage queue in under 2 hours.
- MVP covers one stack (for example, Next.js websites); stacks two and three follow in Phase 2.

## 17. Analytics, monitoring and acceptance criteria

MVP is accepted when a new user can complete the core journey end to end on a supported stack and every P0 requirement passes its test.

### 17.1 Monitoring

| What | Signal | Alert when |
| --- | --- | --- |
| Discovery jobs | Run status per source, items found | Any source fails for 24 hours |
| Gate pipeline | Queue length, gate pass rates | Candidate queue over 200, or security gate errors |
| Eval harness | Runs completed, spend vs budget, flaky rate | Spend over 90% of weekly budget |
| Catalog | Age of last signed snapshot, items past re-check date | Snapshot older than 7 days |
| Plugin (opt-in telemetry) | Verify pass rate, approvals, rollbacks | Verify pass rate under 90% in a week |

### 17.2 MVP acceptance criteria

- [ ] `/setup` on a fresh Next.js project produces a plan with reasons, scorecards and excluded items.
- [ ] Each item can be approved or rejected individually.
- [ ] Generated files pass schema validation and are written only after Claude Code permission prompts.
- [ ] Existing `CLAUDE.md` and `.mcp.json` content is preserved.
- [ ] Backups are created and `/setup-rollback` restores them exactly.
- [ ] No secret values appear in any generated file, log or tool response.
- [ ] `verify_setup` correctly reports a deliberately broken MCP server.
- [ ] Catalog contains at least 50 reviewed items for the MVP stack, each with a complete scorecard.
- [ ] At least one category shows eval results against an incumbent.
- [ ] A `blocked` item installed in a test project triggers the warning on the next run.
- [ ] The recommended setup beats the default setup on the MVP benchmark tasks.

## 18. Open questions and glossary

### 18.1 Open questions

- [ ] Product name?
- [ ] Which stack is the MVP: Next.js website, Python data pipeline, or Shopify app?
- [ ] Weekly eval budget (tokens and money)?
- [ ] Is the catalog public (open data, community trust) or private (competitive moat)?
- [ ] Where does the backend run, and who pays for it?
- [ ] Is opt-in telemetry acceptable to target users at all?
- [ ] Long-term model: free personal tool, open source, or paid team product?
- [ ] Should eval task sets be published so others can reproduce results?

### 18.2 Glossary

| Term | Meaning |
| --- | --- |
| MCP | Model Context Protocol, the standard for connecting agents to external tools |
| MCP server | A program exposing tools to Claude Code through MCP |
| Skill | A folder of instructions Claude Code loads for a specific kind of task |
| Plugin | An installable Claude Code bundle of commands, skills, subagents, hooks and MCP servers |
| Hook | A command Claude Code runs automatically at a set point (for example, after an edit) |
| Subagent | A specialised agent Claude Code can delegate work to |
| Incumbent | The item currently recommended in a category, which candidates must beat |
| Context overhead | Tokens the tool's definitions add to every request |
| Tool poisoning | Hidden instructions in an MCP tool's description that try to manipulate the agent |
| Provisional | Recommended, but too new to judge long-term maintenance |
