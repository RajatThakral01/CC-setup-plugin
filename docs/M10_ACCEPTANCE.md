# Milestone 10 — final owner acceptance test

This replaces `docs/M8_ACCEPTANCE.md`. It checks the owner-run items of PRD 17.2 on a fresh Next.js app, using the policy-approved catalog. Results go into `docs/MVP_REPORT.md`.

Allow about 60 minutes. Commands starting with `/` go into Claude Code's prompt; the rest go in a terminal. `<repo>` means the absolute path of this repository (for example `/Users/you/Desktop/claude_code_setup_agent`).

**Switch off auto mode for the whole test.** Press Shift+Tab until the mode line no longer says auto, or start with `claude --permission-mode default`. Otherwise Claude Code writes files without asking, and the per-file permission prompts this test checks never appear.

No step costs Anthropic API money beyond your own Claude Code session.

## A. Catalog (backend)

1. Start Postgres and apply migrations (0008 to 0010 are new):
   ```sh
   cd <repo> && docker compose up -d && pnpm db:migrate
   ```
2. Check the published snapshot: `cat <repo>/.snapshots/latest.json` shows version `2026.10.20-2` (or newer).
   - It holds 32 approved items (`recommended_provisional`): 27 approved by the policy, 5 by you and re-checked by policy-v2.
   - It also holds 1 blocked item (`davila7-claude-code-templates`, for the warning check in step 18).
   - No triage review is needed: approval is by policy (PRD 9.2a). Optional: `pnpm run pipeline digest` writes this week's digest to `reports/`.

## B. Update the plugin

The installed plugin is a cached copy from 2026-10-19, saved under version `0.1.0`, and it predates the M8.2 fixes. The plugin is now `0.2.0`. Claude Code caches plugins by version, so this update is required.

3. Rebuild the bundle: `cd <repo> && pnpm install && pnpm plugin:build`. Expect `dist/server.js` of about 836 KB. (It is already built; rebuilding is harmless.)
4. `echo $CC_SETUP_AGENT_CATALOG_URL` prints `file://<repo>/.snapshots/`. If it is empty, add `export CC_SETUP_AGENT_CATALOG_URL="file://<repo>/.snapshots/"` to your shell profile and open a new terminal.
5. Update the plugin from a terminal:
   ```sh
   claude plugin marketplace update cc-setup-agent
   claude plugin update setup-agent@cc-setup-agent --scope user
   ls ~/.claude/plugins/cache/cc-setup-agent/setup-agent/
   ```
   The `ls` must list `0.2.0`. If it only shows `0.1.0`, reinstall:
   ```sh
   claude plugin uninstall setup-agent@cc-setup-agent --scope user
   claude plugin install setup-agent@cc-setup-agent --scope user
   ```
6. Start Claude Code, then check:
   - `/plugin` shows `setup-agent` enabled;
   - `/mcp` shows the `setup-agent` server connected;
   - `claude --version` is 2.0.x or 2.1.x (NFR-9).

## C. Fresh Next.js app and `/setup`

7. Create the app outside the repo. create-next-app 16 also writes `AGENTS.md` and a settings-only `pnpm-workspace.yaml`.
   ```sh
   cd ~/Desktop && rm -rf ccsa-acceptance && npx create-next-app@latest ccsa-acceptance --ts --tailwind --app --eslint --use-pnpm --no-src-dir --import-alias "@/*"
   cd ccsa-acceptance && git add -A && git commit -qm "fresh app"
   ```
8. Optional, for the "existing hooks are kept" check: create `.claude/settings.json` containing `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}`, then `git add -A && git commit -qm "own hook"`.
9. Record the starting state for the byte compare. This lists tracked and untracked files, but skips git-ignored ones such as `tsconfig.tsbuildinfo` (created by the typecheck hook) and `node_modules`:
   ```sh
   git ls-files -co --exclude-standard -z | grep -zv '^.claude/setup-agent/' | sort -z | xargs -0 shasum -a 256 > /tmp/ccsa-before.txt
   ```
10. Start Claude Code in `ccsa-acceptance` with auto mode off, and run `/setup`. Answer deploy target `vercel`. For the goal, write something ordinary, such as "build a small shop". Check each point:
    - **Catalog:** it calls `sync_catalog` and reports catalog `2026.10.20-2`, with no signature warning.
    - **Detection:** Next.js App Router, pnpm, TypeScript, Tailwind CSS 4, ESLint, **AGENTS.md**, and **not** a monorepo.
    - **Questions:** at most five.
    - **Plan (PRD 17.2 #1):** the plan has a reason for every item, its scorecard (gates, confidence), and a list of excluded items with why.
    - **Recommendation quality:**
      - every item has a _Why_ line naming a specific signal, for example "Tailwind CSS 4 detected in package.json" or "You said you deploy to Vercel". No generic reasons;
      - **Fit** and **Credibility** are shown on separate lines;
      - **deploy:** the catalog's only deploy item is Netlify, so with `vercel` it must say "no suitable item in the catalog yet" for deploy and recommend nothing there;
      - **vendor-specific items** for products the fresh app doesn't use are not recommended: MongoDB, Redis, Neon, Prisma, Auth0, WorkOS, Datadog, Sentry, SonarQube, Meilisearch, Exa, Tavily;
      - no Discord, CLAUDE.md-management or Cloudflare items (vetoed);
      - provisional items say "approved on gate, security and classification evidence; not yet confirmed by evals over 60 days";
      - "new" appears only for items first published in the last 180 days;
      - the context overhead counts skills and plugins too, and names anything it couldn't measure;
      - an item needing an API key (for example context7, `CONTEXT7_API_KEY`) lists the variable **by name only** and never asks for its value.
    - **Model:** the model suggestion has a cost note, and suggests Sonnet for this goal.
    - **Hooks:** for a fresh app it proposes `lint-on-edit` and `typecheck-on-stop` (`format-on-edit` only if Prettier is present). Keep both.
    - **Per item (PRD 17.2 #2):** keep or drop items one by one. Drop at least one; keep context7 if offered (it is used in step 13).
    - **Backup:** it calls `backup_setup`. Note the backup id.
    - **Diffs:** say "one file at a time". It must show the **full** diff of the first file. It writes that file only after you approve it **and** Claude Code shows its own permission prompt (PRD 17.2 #3). Then it waits before showing the next file, and every file gets a full diff, including `.claude/settings.json`.
    - **Plugin installs** (if you kept a plugin): the commands end in `--scope project`, and it explains that they are recorded in `.claude/settings.json` (covered by rollback). Run them when asked.
    - **Verify:** it runs `verify_setup` and reports pass or fail per check, per item, with fixes.
11. Look at the result:
    - **`CLAUDE.md`** has a block between `<!-- setup-agent:start -->` and `<!-- setup-agent:end -->`. The block imports `@AGENTS.md` (it doesn't copy it), lists the real `pnpm dev` / `pnpm build` / `pnpm start` / `pnpm lint` commands, and has one "when to use" line per tool, with no internal category names. Text outside the block is unchanged (PRD 17.2 #4).
    - **`.mcp.json`** has pinned versions (`pkg@1.2.3`, never `latest`) and `${VAR}` placeholders only.
    - **`.claude/settings.json`** has:
      - the servers in `enabledMcpjsonServers`;
      - a `hooks` section whose commands end in `# setup-agent:<hook id>`, with a PostToolUse and a Stop entry for lint;
      - your own `echo mine` hook unchanged (if you did step 8);
      - `enabledPlugins` if you installed a plugin.
    - **No secrets (PRD 17.2 #6):** `grep -rIiE 'sk-ant|api[_-]?key"?\s*[:=]\s*"[^$]' CLAUDE.md .mcp.json .claude/` finds nothing (placeholders like `${CONTEXT7_API_KEY}` don't match).
12. Hook checks (`/hooks` lists them):
    - **Lint error (blocking):** ask Claude to add `let module = {};` at the top of the `Home` function in `app/page.tsx`. That is an ESLint **error** in Next.js 16 (`@next/next/no-assign-module-variable`); the hook must report it back and Claude fixes it.
    - **Lint warning (non-blocking):** ask Claude to add `const unused = 1;` inside `Home`. The hook passes the warning back as a note without blocking the edit.
    - **Bash edit:** ask Claude to make the `let module = {};` change with `sed` instead of its edit tool. At the end of the turn the Stop hook lints the changed files and sends the error back.
    - **Type error:** ask Claude to add `const n: number = "text";` to `app/page.tsx`. At the end of the turn the typecheck hook sends the TypeScript error back, and Claude fixes it.
    - Ask Claude to undo all four test edits, so `app/page.tsx` is back to its original state.
13. **Broken server (PRD 17.2 #7):**
    - Edit `.mcp.json`: set one server's version to `0.0.0-does-not-exist` (context7: `@upstash/context7-mcp@0.0.0-does-not-exist`), and make sure its key (`CONTEXT7_API_KEY`) is **not** set in your shell.
    - Ask Claude to "run verify_setup". It must report **all** failures for that server together, each with a fix: `package_resolves` fails, `env_present` fails, and `server_starts` reports its result.
    - Undo the edit afterwards.

## D. Rollback and byte compare

14. Run `/setup-rollback`.
    - It first previews: the files to restore or remove, and, if a plugin was installed, the exact `claude plugin uninstall … --scope project` (and `marketplace remove`) commands. Run those when offered, then confirm the restore.
15. Byte compare (PRD 17.2 #5):
    ```sh
    git ls-files -co --exclude-standard -z | grep -zv '^.claude/setup-agent/' | sort -z | xargs -0 shasum -a 256 > /tmp/ccsa-after.txt
    diff /tmp/ccsa-before.txt /tmp/ccsa-after.txt && echo "IDENTICAL"
    ```
    Expected: `IDENTICAL`.
16. Backups exist: `ls .claude/setup-agent/backups/` shows the backup id from step 10.

## E. Blocked item warning (PRD 17.2 #10)

The catalog's only blocked item is `davila7-claude-code-templates` (blocked for a prompt-injection finding). Never install its real code. The check uses an inert `.mcp.json` entry with that name: it runs `node -e 0`, which does nothing.

17. In `ccsa-acceptance`, write `.mcp.json` with exactly:
    ```json
    {
      "mcpServers": { "davila7-claude-code-templates": { "command": "node", "args": ["-e", "0"] } }
    }
    ```
18. Start a **new** Claude Code session there. If Claude Code asks whether to enable the project's MCP server, decline (the check doesn't need it). Then:
    - run `/setup-check`: it must show this item first, as blocked, with the tool's message "claude-code-templates is BLOCKED in the catalog (security). Remove it from .mcp.json now." and an offer to remove it (decline);
    - run `/setup` and stop after the analysis: the same warning must appear before any recommendation.
19. Clean up: `git checkout -- . && git clean -fd` (or delete the folder).

## F. Report back

Tell me pass or fail for each of these, and paste any error text:

- 5 (`0.2.0` in the cache);
- 10 (each bullet, especially the plan contents, recommendation quality, the per-item choices and the diffs/permission prompts);
- 11;
- 12 (each hook check);
- 13;
- 15;
- 16;
- 18.

The plugin's log is on Claude Code's MCP stderr (`/mcp` → setup-agent → logs). I'll record the results in `docs/MVP_REPORT.md`.
