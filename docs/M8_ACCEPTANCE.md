# Milestone 8 — owner acceptance test (re-run after M8.2)

> Superseded by `docs/M10_ACCEPTANCE.md` (2026-10-20). Kept for the record.

Two checks from the plan:

1. Install the plugin from the local marketplace and complete `/setup` on a fresh Next.js app.
2. `/setup-rollback` restores the original files exactly (byte compare).

Allow about 40 minutes. Commands starting with `!` can be typed into Claude Code's prompt; the rest go in a terminal. `<repo>` means the absolute path of this repository (for example `/Users/you/Desktop/claude_code_setup_agent`).

**Switch off auto mode for the whole test** (Shift+Tab until the mode line no longer says auto, or start with `claude --permission-mode default`). Otherwise Claude Code writes files without asking, and the per-file permission prompts this test checks never appear.

## A. Prepare a catalog (backend)

1. Make sure Postgres is up: `cd <repo> && docker compose up -d`, then `pnpm db:migrate` (M8.2 adds migration `0004`).
2. Review the re-classified items in triage: `pnpm triage`, open http://127.0.0.1:4400, sign in, tick **needs classification review** and press Filter. Every item listed had its kind or category changed by the classify-v3 run. For each one, check the kind and category at the top of the item page and either **Save kind and category** as they are (confirms them) or correct them. Saved values are owner-set: no future re-classification changes them. The list of changed items is also in the M8.2 session report.
3. Re-check the approved items (status `recommended_provisional`) in the same way. An approved item with no category is skipped by the snapshot (it can't be recommended); either give it a category or move it back to `watchlist`.
4. Publish a signed snapshot: `pnpm run pipeline snapshot`. Expect `Snapshot YYYY.MM.DD-N: <n> item(s)`, and check that "skipped" is empty or lists only items you expect.
5. Confirm the files exist: `ls <repo>/.snapshots` shows `latest.json`, `catalog-*.json`, `.sig`, `.sha256`.

## B. Install the plugin

6. Rebuild the plugin bundle: `cd <repo> && pnpm plugin:build` → `apps/plugin/dist/server.js`.
7. `CC_SETUP_AGENT_CATALOG_URL` is already in your shell profile from the first run (`echo $CC_SETUP_AGENT_CATALOG_URL` prints `file://<repo>/.snapshots/`).
8. Update the installed plugin: in Claude Code run `/plugin marketplace update cc-setup-agent`, then `/plugin` and update or reinstall `setup-agent@cc-setup-agent`. (First time: `/plugin marketplace add <repo>` and `/plugin install setup-agent@cc-setup-agent`.)
9. Quit and restart Claude Code. `/plugin` shows `setup-agent` enabled; `/mcp` shows the `setup-agent` server connected. `claude --version` must be 2.0.x or 2.1.x (NFR-9).

## C. Fresh Next.js app and `/setup`

10. In a terminal, outside the repo (create-next-app 16 also writes `AGENTS.md` and a `pnpm-workspace.yaml` with settings only):
    ```sh
    cd ~/Desktop && rm -rf ccsa-acceptance && npx create-next-app@latest ccsa-acceptance --ts --tailwind --app --eslint --use-pnpm --no-src-dir --import-alias "@/*"
    cd ccsa-acceptance && git init -q 2>/dev/null; git add -A && git commit -qm "fresh app"
    ```
11. Record the starting state for the byte compare. This lists tracked and untracked files but skips git-ignored ones (build output such as `tsconfig.tsbuildinfo`, which the typecheck hook creates, and `node_modules`):
    ```sh
    git ls-files -co --exclude-standard -z | grep -zv '^.claude/setup-agent/' | sort -z | xargs -0 shasum -a 256 > /tmp/ccsa-before.txt
    ```
12. Start Claude Code in `ccsa-acceptance` (auto mode off) and run `/setup`. Answer deploy target `vercel`. Check:
    - it calls `sync_catalog` and reports the catalog version (no "signature is invalid" warning);
    - it reports what it detected: Next.js app router, pnpm, TypeScript, Tailwind CSS 4, ESLint, **AGENTS.md**, and **not** a monorepo;
    - it asks at most five questions;
    - **recommendation quality** (the M8 failure):
      - every recommended item has a _Why_ line naming a specific signal, e.g. "Tailwind CSS 4 detected in package.json (tailwindcss ^4)" or "You said you deploy to Vercel". No generic reasons such as "the project is a git repository";
      - every item shows **Fit** (strong or good, with a reason) and **Credibility** (the gates) on separate lines;
      - no Cloudflare deploy item for a Vercel deploy; no Discord or CLAUDE.md-management item filed under git or code review;
      - a needed category with no fitting item says "no suitable item in the catalog yet" and recommends nothing there;
      - provisional items say "approved on gate, security and classification evidence; not yet confirmed by evals over 60 days"; "new" appears only for items published within the last 180 days;
      - the context overhead counts skills and plugins too (their descriptions), and names anything it couldn't measure;
    - the model suggestion has a cost note (budget `low` plus a goal like "re-architect the data layer" gives Opus; other answers give Sonnet);
    - hooks proposed for a fresh app: `lint-on-edit` and `typecheck-on-stop` (`format-on-edit` only if you add Prettier). Keep both;
    - keep or drop items one by one (drop at least one item);
    - it calls `backup_setup` (note the backup id);
    - **diffs**: say "one file at a time". It must show the **full** diff of the first file, write only that file after you approve it and Claude Code's permission prompt, then wait for you before showing the next file. No "see the tool output above" summaries; every file's diff is shown in full, including `.claude/settings.json`;
    - **plugin installs** (if a plugin was kept): the commands end in `--scope project`, and it says they're recorded in `.claude/settings.json` (covered by rollback) while the plugin code sits in Claude Code's user-level cache. Run them when asked;
    - it lists required environment variables by name only and never asks for values;
    - it runs `verify_setup` and reports pass or fail per check per item, with fixes.
13. Look at the result:
    - `CLAUDE.md` has a block between `<!-- setup-agent:start -->` and `<!-- setup-agent:end -->` that imports `@AGENTS.md` (instead of copying it), lists the real `pnpm dev` / `pnpm build` / `pnpm start` / `pnpm lint` commands, and has one line per tool saying when to use it, with no internal category names such as `git_github`;
    - `.mcp.json` has pinned versions (`pkg@1.2.3`, never `latest`) and `${VAR}` placeholders only;
    - `.claude/settings.json` lists the servers in `enabledMcpjsonServers`, has a `hooks` section whose commands end in `# setup-agent:<hook id>` (lint has a PostToolUse and a Stop entry), and `enabledPlugins` if you installed a plugin.
14. Hook checks (run `/hooks` to see them):
    - **Lint error (blocking):** ask Claude to add `let module = {};` at the top of the `Home` function in `app/page.tsx`. `@next/next/no-assign-module-variable` is an **error** in the Next.js 16 ESLint config (verified in `@next/eslint-plugin-next` 16.0.1), so the lint hook must report it back to Claude, which then fixes it.
    - **Lint warning (non-blocking):** ask Claude to add an unused variable `const unused = 1;` inside the `Home` component. That's only a warning; the hook must pass it back as a note (Claude mentions it or fixes it), without blocking the edit.
    - **Bash edit:** ask Claude to make the same `let module = {};` change with a shell command (e.g. `sed`) instead of its edit tool. When Claude finishes the turn, the Stop hook lints the changed files from git and sends the error back.
    - **Type error:** ask Claude to add `const n: number = "text";` to `app/page.tsx`. When Claude finishes the turn, the typecheck hook sends the TypeScript error back and Claude fixes it.
    - Optional, existing hooks: before `/setup`, put your own hook in `.claude/settings.json` (e.g. a `PreToolUse` hook `echo mine`); after `/setup` it must still be there, unchanged.
15. Broken-server check: edit `.mcp.json`, change one server's version to `0.0.0-does-not-exist` and, if it needs an API key, make sure that variable is **not** set. Ask Claude to "run verify_setup". It must report **all** failures for that server together: `package_resolves` fails (version not published), `env_present` fails (if a key is needed) and the server start result, each with a fix. Undo the edit afterwards.

## D. Rollback

16. Run `/setup-rollback`. It first previews (dry run): the files to restore or remove and, if a plugin was installed, the exact `claude plugin uninstall … --scope project` (and `marketplace remove`) commands, offered before the restore. Confirm.
17. Byte compare:
    ```sh
    git ls-files -co --exclude-standard -z | grep -zv '^.claude/setup-agent/' | sort -z | xargs -0 shasum -a 256 > /tmp/ccsa-after.txt
    diff /tmp/ccsa-before.txt /tmp/ccsa-after.txt && echo "IDENTICAL"
    ```
    Expected output: `IDENTICAL`. (`.claude/setup-agent/backups/` is the plugin's own backup folder; git-ignored build output such as `tsconfig.tsbuildinfo` is left out by `git ls-files --exclude-standard`.)

## E. Report back

Tell me pass or fail for steps 9, 12 (especially the recommendation-quality and diff points), 13, 14 (each hook check), 15 and 17, and paste any error text. The plugin's log is on Claude Code's MCP stderr (`/mcp` → setup-agent → logs).
