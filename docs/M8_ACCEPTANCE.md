# Milestone 8 — owner acceptance test

Two checks from the plan:

1. Install the plugin from the local marketplace and complete `/setup` on a fresh Next.js app.
2. `/setup-rollback` restores the original files exactly (byte compare).

Allow about 30 minutes. Commands starting with `!` can be typed into Claude Code's prompt; the rest go in a terminal. `<repo>` means the absolute path of this repository (for example `/Users/you/Desktop/claude_code_setup_agent`).

## A. Prepare a catalog (backend)

1. Make sure Postgres is up: `cd <repo> && docker compose up -d`.
2. Fix the signing key path in `.env`: `SNAPSHOT_SIGNING_KEY_PATH` must be the real path printed by `pnpm keys:generate`, e.g. `/Users/you/.config/cc-setup-agent/snapshot-signing-key.pem` (it currently holds the `<you>` placeholder).
3. Approve items in triage (if not done yet): `pnpm triage`, open http://127.0.0.1:4400, sign in, and move at least a handful of in-scope items to `recommended_provisional` with a reason. For a meaningful test include at least: one docs MCP server (e.g. Next.js DevTools MCP or Context7), one browser-testing item (e.g. Playwright MCP), and one item that needs an environment variable. Items flagged by the security gate need an override note.
4. Publish a signed snapshot: `pnpm run pipeline snapshot`. Expect `Snapshot YYYY.MM.DD-N: <n> item(s)`, and check that "skipped" is empty or only lists items you expect (e.g. approved items without install details).
5. Confirm files exist: `ls <repo>/.snapshots` shows `latest.json`, `catalog-*.json`, `.sig`, `.sha256`.

## B. Install the plugin

6. Build the plugin bundle: `cd <repo> && pnpm plugin:build` → `apps/plugin/dist/server.js`.
7. Point the plugin at the catalog: add `export CC_SETUP_AGENT_CATALOG_URL="file://<repo>/.snapshots/"` to your shell profile (`~/.zshrc`), then open a new terminal (`echo $CC_SETUP_AGENT_CATALOG_URL` should print it).
8. Start Claude Code from that terminal, anywhere, and run:
   - `/plugin marketplace add <repo>`
   - `/plugin install setup-agent@cc-setup-agent`
9. Quit and restart Claude Code. Run `/plugin` and confirm `setup-agent` is installed and enabled. Run `/mcp` and confirm the `setup-agent` server is connected. Check `claude --version`: setup-agent writes config only for Claude Code 2.0.x and 2.1.x (NFR-9); on any other version `generate_config` refuses with a message and nothing is written.

## C. Fresh Next.js app and `/setup`

10. In a terminal, outside the repo:
    ```sh
    cd ~/Desktop && npx create-next-app@latest ccsa-acceptance --ts --tailwind --app --eslint --use-pnpm --no-src-dir --import-alias "@/*"
    cd ccsa-acceptance && git init -q 2>/dev/null; git add -A && git commit -qm "fresh app"
    ```
11. Record the starting state for the byte compare:
    ```sh
    find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256 > /tmp/ccsa-before.txt
    ```
12. Start Claude Code in `ccsa-acceptance` and run `/setup` (or `/setup-agent:setup`). Check that:
    - it calls `sync_catalog` and reports the catalog version (no "signature is invalid" warning);
    - it reports what it detected (Next.js app router, pnpm, TypeScript, Tailwind);
    - it asks at most five questions;
    - the plan lists each item with reason, scorecard summary, trade-off and confidence, plus excluded items, context overhead and a model suggestion with a cost note (answer budget sensitivity `low` and give an architecture-heavy goal such as "re-architect the data layer" to see an Opus suggestion; any other answers give Sonnet);
    - it proposes hooks for the detected tooling: a fresh `create-next-app` project has ESLint and TypeScript but no Prettier, so expect `lint-on-edit` and `typecheck-on-stop` (and `format-on-edit` only if you add Prettier);
    - you can keep or drop items and hooks one by one (drop at least one item; keep at least one hook);
    - it calls `backup_setup` (note the backup id), shows a diff for each file, and Claude Code asks permission before each write;
    - it lists required environment variables by name only and never asks for values;
    - it runs `verify_setup` and reports pass or fail per item with fixes.
13. Look at the result: `CLAUDE.md` contains a block between `<!-- setup-agent:start -->` and `<!-- setup-agent:end -->`; `.mcp.json` has pinned versions (`pkg@1.2.3`, never `latest`) and `${VAR}` placeholders only; `.claude/settings.json` lists the servers in `enabledMcpjsonServers` and has a `hooks` section whose commands end in `# setup-agent:<hook id>`.
    - Hook check: ask Claude to add an unused variable to `app/page.tsx`. The lint hook should report the ESLint error back to Claude, which then fixes it. Run `/hooks` to see the installed hooks.
    - Optional, existing-hooks check: before `/setup`, put your own hook in `.claude/settings.json` (e.g. a `PreToolUse` hook `echo mine`); after `/setup` it must still be there, unchanged.
14. Optional, broken-server check: edit `.mcp.json`, change one server's version to `0.0.0-does-not-exist`, ask Claude to "run verify_setup" and confirm it reports that server as failing with a fix. Undo the edit afterwards.

## D. Rollback

15. Run `/setup-rollback` and confirm. It should list the restored and removed files (`CLAUDE.md`, `.mcp.json`, `.claude/settings.json` are removed if the fresh app didn't have them).
16. Byte compare:
    ```sh
    find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.claude/setup-agent -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256 > /tmp/ccsa-after.txt
    diff /tmp/ccsa-before.txt /tmp/ccsa-after.txt && echo "IDENTICAL"
    ```
    Expected output: `IDENTICAL`. (`.claude/setup-agent/backups/` is the plugin's own backup folder and is excluded from the compare. If the only difference is an empty `.claude/` folder, that also passes: folders aren't files.)

## E. Report back

Tell me pass or fail for steps 9, 12, 13 (including the hook check), 14 (if run) and 16, and paste any error text. If something fails, the plugin's log is on Claude Code's MCP stderr (`/mcp` → setup-agent → logs).
