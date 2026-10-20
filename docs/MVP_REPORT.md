# MVP report (Milestone 10)

Status on 2026-10-20, before the owner's final acceptance test (`docs/M10_ACCEPTANCE.md`). Owner-run items are marked **pending owner test**. They are updated from the owner's results.

- **Catalog:** snapshot `2026.10.20-2`, signed, with 32 `recommended_provisional` items and 1 blocked item.
- **Plugin:** `setup-agent` 0.2.0, bundle rebuilt 2026-10-20.
- **Claude Code:** 2.1.304 on the host, 2.1.303 in the eval image.
- **Tests:** 733 passing, plus 5 real-Docker tests that run in CI; the eval sandbox tests also pass locally with real Docker. CI is green on every pushed milestone.

## PRD 17.2 acceptance criteria (as amended for the approval policy, PRD 0.4/0.5)

| #   | Criterion                                                                                                       | Status                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `/setup` on a fresh Next.js project produces a plan with reasons, scorecards and excluded items                 | Automated: pass. **Pending owner test**                                         |
| 2   | Each item can be approved or rejected individually                                                              | Automated: pass. **Pending owner test**                                         |
| 3   | Generated files pass schema validation and are written only after Claude Code permission prompts                | Automated (schema): pass. **Pending owner test** (prompts)                      |
| 4   | Existing `CLAUDE.md` and `.mcp.json` content is preserved                                                       | Automated: pass. **Pending owner test**                                         |
| 5   | Backups are created and `/setup-rollback` restores them exactly                                                 | Automated: pass. M8 owner test: pass. **Pending owner re-test**                 |
| 6   | No secret values appear in any generated file, log or tool response                                             | Automated: pass. **Pending owner test**                                         |
| 7   | `verify_setup` correctly reports a deliberately broken MCP server                                               | Automated: pass. M8 owner test failed, fixed in M8.2. **Pending owner re-test** |
| 8   | Catalog contains at least 50 approved items (policy or owner) for the MVP stack, each with a complete scorecard | **Fail: 32 approved.** Scorecards complete (32/32). Needs an owner decision     |
| 9   | At least one category shows eval results against an incumbent                                                   | **Pass**                                                                        |
| 10  | A `blocked` item installed in a test project triggers the warning on the next run                               | Automated and bundle smoke test: pass. **Pending owner test**                   |
| 11  | The recommended setup beats the default setup on the MVP benchmark tasks                                        | **Not run.** Needs a harness change and a paid run; owner decision              |

### Evidence

**1. Plan with reasons, scorecards, excluded items**

- `server.test.ts` "runs the core journey on a fresh project" (through an MCP client).
- `recommend.test.ts`:
  - one fitting item per needed category;
  - a specific signal named in every reason;
  - fit and credibility shown separately;
  - gaps reported as "no suitable item in the catalog yet";
  - output byte-identical across runs (FR-R8).
- Live: M10 step 10.

**2. Per-item approval**

- `packaging.test.ts` "tells the model never to handle secret values and to approve per item" (skill and command text).
- `generate.test.ts` "refuses unknown or non-recommended items".
- Live: M10 step 10.

**3. Schema validation and permission prompts**

- Every MCP tool output is validated by the shared zod schemas (`server.test.ts`).
- Generated files are covered by snapshot tests (`generate.test.ts`).
- The skill requires a full diff and one file at a time (`packaging.test.ts`). The MCP server never writes project files except backups and rollback (plan 2.3), so every write goes through Claude Code's own tools and their permission prompts.
- Live: M10 step 10, with auto mode off.

**4. Existing content preserved**

- `generate.test.ts`:
  - "never changes content outside the managed block, and keeps unknown servers";
  - a 300-case randomised property test that `.mcp.json` merges never drop unknown servers;
  - "keeps every existing settings key";
  - "refuses invalid existing JSON instead of overwriting it";
  - "adds approved hook recipes … keeping existing hooks".
- Live: M10 steps 8 and 11.

**5. Backups and exact rollback**

- `backup.test.ts`:
  - "restores the original files exactly after a generated config is written" (byte compare);
  - refuses a corrupted backup;
  - lists project-scope plugin installs with their uninstall commands.
- The M8 owner acceptance (2026-10-19) passed the rollback byte compare.
- Live re-test: M10 steps 14 to 16.

**6. No secrets**

- `.mcp.json` holds `${VAR}` placeholders only (generate snapshot tests).
- `verify.test.ts` "reports missing env vars by name only".
- The logger redacts secret-looking fields (pino `redact` in `packages/core/src/logger.ts`; no dedicated test), and HTTP errors strip URL query strings (`http.test.ts`).
- The eval relay never puts the real API key in the agent container or the logs (`relay.test.ts`, real-Docker driver test).
- gitleaks runs in CI.
- Live: M10 step 11 (grep).

**7. Broken server**

- `verify.test.ts`:
  - "reports a deliberately broken server with a fix";
  - "runs every check for a server and reports all failures together";
  - "does not start a remote server that is missing its credentials".
- The M8 owner test failed this check; it was fixed in M8.2 (E).
- Live re-test: M10 step 13.

**8. At least 50 approved items**

- 32 items are `recommended_provisional` in snapshot `2026.10.20-2`: 27 approved by the policy (`policy-v1`, `policy-v2`), 5 by the owner and re-checked by policy-v2.
- All 32 meet the current policy criteria. All have gates 0 to 3 at `pass` and high confidence.
- Why there are no more (`policy --dry-run`, 2026-10-20; 140 items held):
  - 13 official-vendor items fail **only** category agreement. Their Sonnet second opinion was asked and disagreed with Haiku, so more second opinions won't change them.
  - 6 official-vendor items fail **only** the gates (soft fails count as not passing).
  - 8 community items fail only category agreement and a winning eval.
  - The rest fail several criteria, mostly incomplete gates or install details.
- This follows the owner's rule "when unsure, don't recommend". Reaching 50 means one of:
  - (a) accept 32 as an owner exception for the MVP;
  - (b) a policy change, for example accepting gate soft fails for official vendors, or letting the rules plus one model decide category for official vendors;
  - (c) more evals (community items) and the next discovery runs.

**9. Eval results against an incumbent**

- browser_testing: `chromedevtools-chrome-devtools-mcp` 1.11.0 against the incumbent `anthropics-skills-webapp-testing`, Stage A (Haiku, 3 runs × 5 tasks):
  - candidate 12/15, baseline 11/15, after timeouts were counted as failures;
  - verdict `equal`.
- Shown in triage (item page, eval section) and in the snapshot (`evalSummary`).
- `microsoft-playwright-mcp` has 3 runs (3/3) and no verdict yet.
- Task sets exist for browser_testing, docs, database and code_review (5 tasks each, selftest 5/5). Only browser_testing has paid runs.

**10. Blocked item warning**

- `server.test.ts` "warns about an installed blocked item on the next run".
- `updates.test.ts`: the blocked warning, plus a version that stays blocked after an unblock (FR-P10).
- Bundle smoke test (2026-10-20): the built `dist/server.js`, with snapshot `2026.10.20-2` and an inert `.mcp.json` entry named after the blocked `davila7-claude-code-templates`, returns "claude-code-templates is BLOCKED in the catalog (security). Remove it from .mcp.json now." from `analyze_project`.
- Live: M10 step 18.

**11. Recommended setup vs default setup**

- Not measured. The harness compares **one** item against the category incumbent (FR-E4). It has no arm that installs a whole recommended setup.
- What it needs:
  - a "setup" arm (the items `recommend_setup` picks for the fixture app, installed together): a free code change;
  - a paid run over the 20 tasks (4 task sets × 5).
- Estimate from measured costs (Haiku USD 0.0057 mean per run over 27 runs; Sonnet USD 0.13 from one pilot run):
  - Stage A (Haiku, 3 runs × 2 arms × 20 tasks): about USD 0.7 to 1.4;
  - Stage B (Sonnet, 1 run × 2 arms × 20 tasks): about USD 5.4;
  - a whole setup adds context, so runs may cost more.
- This is also the PRD success metric "eval uplift".

## Other M10 plan steps

- **Full loop on live data** (plan M10 task 1):
  - discovery last ran live 2026-10-19;
  - gates, policy and snapshot ran 2026-10-20;
  - a fresh `discover` (classification costs a few cents) and `policy` run before the final snapshot is optional: owner go-ahead.
- **Broken server and blocked item** (plan M10 tasks 2 and 3): owner-run, M10 steps 13 and 18. The blocked check uses the catalog's existing blocked item instead of blocking a real approved item.

## Spend

| Purpose        | USD        |
| -------------- | ---------- |
| Classification | 0.4892     |
| Evals          | 0.3379     |
| **Total**      | **0.8271** |

Caps: USD 20 per week, USD 40 in total. This week: USD 0.69.

The 7 eval runs that timed out on 2026-10-20 were first booked at the USD 1.50 cap (USD 10.50 in total). On the owner's instruction they were re-booked at USD 0.05 in total, split by relay call count, and marked "estimated from relay call counts, checked against console". The original bookings are kept in `budget_ledger_corrections`.

## Known issues and limitations

- **Approved items:** 32 of the 50 targeted (criterion 8).
- **Eval coverage:**
  - only browser_testing has eval results, and only Stage A (Haiku);
  - docs, database and code_review have task sets but no runs;
  - the database tasks use SQLite, so the Postgres, Prisma, Neon and Redis items aren't evaluated (backlog: needs a Postgres service in the eval sandbox).
- **Blocked-item detection** covers MCP servers in `.mcp.json` only. A blocked skill or plugin installed in a project isn't detected yet.
- **Gate 3:** 21 items have gate 3 `not_run` (no runnable install, remote servers needing credentials, manual subagents and hook recipes). None of them can be approved.
- **Gold set:** classification scores 7/10 on the owner labels; misses are mostly skill-vs-plugin confusion.
- **Plugin updates:** Claude Code caches plugins by version, so every plugin release must bump `plugin.json` and `SERVER_VERSION` together (enforced by a test since 0.2.0).
- **Eval timeouts:** fixed with a 90 s limit per command and transcripts that survive a kill, but not yet confirmed in a paid run.

## Phase 2 recommendations

1. **Evals:** add a whole-setup arm and measure eval uplift (criterion 11, the PRD's main success metric) before anything else.
2. **Evals:** run the new task sets, starting with the incumbents of docs and code_review. Add a Postgres task set.
3. **Catalog:** decide on criterion 8 (exception or policy change), then let the weekly policy and eval jobs grow the catalog.
4. **Plugin:** extend blocked-item detection to skills and plugins.
5. **Plan 12.2:**
   - more stacks;
   - download trends;
   - community signals;
   - gate 4;
   - anti-gaming checks;
   - weekly `check_updates`;
   - evals in every category, re-run on model or Claude Code changes (FR-E8);
   - a Gate B review against the PRD success metrics.
6. **Hosting** per plan 12.1:
   - managed Postgres;
   - the worker as a service;
   - object storage for snapshots and eval logs;
   - a secret manager for the signing key.
