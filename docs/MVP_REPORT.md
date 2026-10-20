# MVP report (Milestone 10)

Status on 2026-10-20, before the owner's final acceptance test (`docs/M10_ACCEPTANCE.md`). Owner-run items are marked **pending owner test**. They are updated from the owner's results.

- **Catalog:** snapshot `2026.10.20-2`, signed, with 32 `recommended_provisional` items and 1 blocked item.
- **Plugin:** `setup-agent` 0.2.0, bundle rebuilt 2026-10-20.
- **Claude Code:** 2.1.304 on the host, 2.1.303 in the eval image.
- **Tests:** 741 passing, plus 6 real-Docker tests that run in CI; the eval sandbox tests also pass locally with real Docker. CI is green on every pushed milestone.

## PRD 17.2 acceptance criteria (as amended for the approval policy, PRD 0.4/0.5)

| #   | Criterion                                                                                                       | Status                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `/setup` on a fresh Next.js project produces a plan with reasons, scorecards and excluded items                 | Automated: pass. **Pending owner test**                                                                                                         |
| 2   | Each item can be approved or rejected individually                                                              | Automated: pass. **Pending owner test**                                                                                                         |
| 3   | Generated files pass schema validation and are written only after Claude Code permission prompts                | Automated (schema): pass. **Pending owner test** (prompts)                                                                                      |
| 4   | Existing `CLAUDE.md` and `.mcp.json` content is preserved                                                       | Automated: pass. **Pending owner test**                                                                                                         |
| 5   | Backups are created and `/setup-rollback` restores them exactly                                                 | Automated: pass. M8 owner test: pass. **Pending owner re-test**                                                                                 |
| 6   | No secret values appear in any generated file, log or tool response                                             | Automated: pass. **Pending owner test**                                                                                                         |
| 7   | `verify_setup` correctly reports a deliberately broken MCP server                                               | Automated: pass. M8 owner test failed, fixed in M8.2. **Pending owner re-test**                                                                 |
| 8   | Catalog contains at least 50 approved items (policy or owner) for the MVP stack, each with a complete scorecard | **Owner-accepted exception** (2026-10-20): 32 approved, scorecards complete (32/32)                                                             |
| 9   | At least one category shows eval results against an incumbent                                                   | **Pass**                                                                                                                                        |
| 10  | A `blocked` item installed in a test project triggers the warning on the next run                               | Automated and bundle smoke test: pass. **Pending owner test**                                                                                   |
| 11  | The recommended setup beats the default setup on the MVP benchmark tasks                                        | **Ahead, not confirmed:** Haiku screening 60/60 vs 56/60 (+7 points, under the 0.2 confirmation threshold). Sonnet confirmation: owner decision |

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
- **Owner decision (2026-10-20): accepted as an MVP exception.** Reason: "quality over count; catalog grows via discovery and evals". The policy is not loosened to reach a number; the weekly discovery, policy and eval jobs grow the catalog.

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

Run 2026-10-20 with `pnpm evals setup-compare` (Haiku `claude-haiku-5-5`, Claude Code 2.1.303, catalog `2026.10.20-2`, 4 task sets × 5 tasks × 3 runs per arm). Report: `reports/setup-eval-2026-10-20-fast.md`.

- **Recommended setup:** what the plugin itself recommends and generates for the fixture app with fixed answers.
  - Recommended: context7, webapp-testing (skill), security-guidance (plugin), plus the `typecheck-on-stop` hook.
  - Installed in the eval: webapp-testing, security-guidance, the generated `CLAUDE.md` block and `.claude/settings.json`.
  - context7 needs an account key, so it is not evaluated (FR-E7).
  - security-guidance runs without its optional Agent SDK, because PyPI isn't reachable from the sandbox; it then uses pattern warnings plus a single-shot review.
- **Default setup:** the same fixture with no tools and no setup files.

| Category        | Recommended setup: passed | Default: passed | Lead   | Mean tokens (setup / default) | Mean time   | Mean cost per run   |
| --------------- | ------------------------- | --------------- | ------ | ----------------------------- | ----------- | ------------------- |
| browser_testing | 15/15 (100%)              | 14/15 (93%)     | +7     | 207,625 / 173,056             | 43 s / 55 s | USD 0.0048 / 0.0040 |
| code_review     | 15/15 (100%)              | 12/15 (80%)     | +20    | 168,637 / 142,481             | 37 s / 22 s | USD 0.0042 / 0.0035 |
| database        | 15/15 (100%)              | 15/15 (100%)    | 0      | 280,102 / 203,890             | 58 s / 44 s | USD 0.0070 / 0.0050 |
| docs            | 15/15 (100%)              | 15/15 (100%)    | 0      | 297,756 / 273,386             | 58 s / 51 s | USD 0.0064 / 0.0057 |
| **all**         | **60/60 (100%)**          | **56/60 (93%)** | **+7** | 238,530 / 198,203             | 49 s / 43 s | USD 0.0056 / 0.0045 |

- **The default's 4 failures:**
  - `review-discount` 3/3: it missed the documented rounding and range checks;
  - `contact-form-submit` 1/3: it timed out trying to download a browser it can't reach.
- **The recommended setup** never failed and never timed out. It used about 20% more tokens and about 25% more cost per run.
- **Verdict:** the recommended setup is ahead in every category where the default lost anything, and never behind. The overall lead (+7 points) is under the 0.2 confirmation threshold, so by the harness's own rule it is **not confirmed**.
- **Ceiling effect:** both arms score 100% on database and docs, so with Haiku these tasks can't separate the setups.
- **Cost of the comparison:** USD 0.61 in actual usage (121 runs, 3 default runs reused from the first, stopped attempt).

## Other M10 plan steps

- **Full loop on live data** (plan M10 task 1), run 2026-10-20 on the owner's go-ahead:
  - `discover`: 4/4 sources, 30 new candidates, 300 records classified (USD 0.0773);
  - `gates --pending`: 30 gated, 0 errors;
  - `policy`: 0 approved, 2 demoted, both caused by a scanner false positive (see Known issues);
  - **no snapshot published:** the owner tests with `2026.10.20-2`, and the changes since then come from that false positive.
- **Broken server and blocked item** (plan M10 tasks 2 and 3): owner-run, M10 steps 13 and 18. The blocked check uses the catalog's existing blocked item instead of blocking a real approved item.

## Spend

| Purpose        | USD        |
| -------------- | ---------- |
| Classification | 0.5665     |
| Evals          | 2.3331     |
| **Total**      | **2.8996** |

Caps: USD 20 per week, USD 40 in total. This week: USD 2.76.

- **Evals** include a USD 1.38 reservation left by one setup run that was stopped mid-flight on 2026-10-20 (`20261020-88aefc2cd0`, about a minute in, real cost likely under a cent). It stays booked until the owner decides; without it, total spend is USD 1.52.
- **The 7 timed-out runs** of 2026-10-20 were re-booked at USD 0.05 in total on the owner's instruction ("estimated from relay call counts, checked against console"); the original USD 1.50 bookings are kept in `budget_ledger_corrections`.

## Known issues and limitations

- **Approved items:** 32 of the 50 targeted (criterion 8, owner-accepted exception).
- **Gate 3 false positives (found 2026-10-20, owner decision pending):**
  - the M4 injection rule for a plugin's first `SKILL.md` blocked three official plugins whose text quotes or discusses instructions:
    - `anthropics-claude-plugins-official-receipts` quotes "ignore previous instructions" as an attack to refuse;
    - `awslabs-agent-plugins-aws-transform`: "do NOT tell the user that recurring analyses require deploying infrastructure";
    - `awslabs-agent-plugins-databases-on-aws`: "Do not silently skip validation — inform the user";
  - the injection cause locks the `anthropics` and `awslabs` orgs, so the policy demoted the owner approvals of `frontend-design` and `webapp-testing` to candidate in the database;
  - the published snapshot `2026.10.20-2` is unaffected.
- **Eval coverage:**
  - item-vs-incumbent results exist only for browser_testing (Stage A, Haiku);
  - the whole-setup comparison covers all four task sets;
  - on database and docs both arms score 100% with Haiku (ceiling effect), so harder tasks are needed to tell setups apart;
  - the database tasks use SQLite, so the Postgres, Prisma, Neon and Redis items aren't evaluated (backlog: needs a Postgres service in the eval sandbox).
- **Eval sandbox limits:**
  - items that need accounts (context7) aren't evaluated;
  - PyPI isn't reachable, so plugins that pip-install helpers at start (security-guidance's Agent SDK) run in their fallback mode;
  - the eval relay booked no usage in real runs until 2026-10-20 (compressed responses; fixed and verified).
- **Blocked-item detection** covers MCP servers in `.mcp.json` only. A blocked skill or plugin installed in a project isn't detected yet.
- **Gate 3:** 21 items have gate 3 `not_run` (no runnable install, remote servers needing credentials, manual subagents and hook recipes). None of them can be approved.
- **Gold set:** classification scores 7/10 on the owner labels; misses are mostly skill-vs-plugin confusion.
- **Plugin updates:** Claude Code caches plugins by version, so every plugin release must bump `plugin.json` and `SERVER_VERSION` together (enforced by a test since 0.2.0).
- **Eval timeouts:** confirmed fixed in the paid run. The one timeout in 121 runs was an agent looping on a blocked browser download, and it was booked at its actual USD 0.0048, not the cap.

## Phase 2 recommendations

1. **Evals:** harder benchmark tasks (both arms hit 100% on database and docs with Haiku), then re-measure eval uplift (criterion 11, the PRD's main success metric) with Sonnet confirmation.
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
