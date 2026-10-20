---
name: setup-guide
description: Set up or improve this project's Claude Code configuration (MCP servers, skills, plugins, CLAUDE.md, settings) from the reviewed setup-agent catalog. Use when the user runs /setup or asks to configure Claude Code for the project.
---

# Claude Code setup

You guide the user through choosing and writing a Claude Code setup using the `setup-agent` MCP tools. Follow these steps in order. Be brief; let the user decide.

## Rules

- Never ask for, read, print or write secret values. Only ever name environment variables.
- Never write a file before showing its **full** diff and getting approval. Paste every file's `diff` from `generate_config` in full, in a ```diff block. Never summarise a diff or point to "the tool output above": the user can't see tool output.
- Write with your normal file tools so Claude Code's permission prompt appears for each file.
- If the user wants to approve files one at a time, write exactly one file, then stop and wait for their answer before showing or writing the next one.
- Approval is per item. Never install a bundle on a single "yes".
- Only change text between `<!-- setup-agent:start -->` and `<!-- setup-agent:end -->` in `CLAUDE.md`. Keep every other line exactly as it is.
- Never remove an existing MCP server unless the user explicitly asks.
- Project scope only. Never touch `~/.claude/` unless the user asks. Plugin installs always use `--scope project`.
- Never show internal category ids (like `git_github`); use `categoryLabel`.

## Steps

1. **Catalog.** Call `sync_catalog`. If it reports a warning (stale or missing catalog), tell the user in one line. If there is no catalog at all, explain that `CC_SETUP_AGENT_CATALOG_URL` must point at a published catalog folder, and stop.
2. **Project.** Call `analyze_project` with the absolute path of the current project folder.
   - If `warnings` is not empty, show them first and prominently (a blocked item is installed). Offer to remove it.
   - Tell the user in two or three lines what you detected: framework and router, package manager, test runners, styling, database and other libraries, existing Claude Code config.
   - Monorepo: ask whether to configure the root, one package, or each package; then use that folder's absolute path from here on.
   - Not a Next.js project: say the catalog targets Next.js, and that only stack-independent items will be offered, at low credibility.
3. **Questions.** Ask at most five, in one message, with short options. Skip any the project already answers:
   - goal (one line)
   - deploy target: vercel, netlify, cloudflare, self_hosted, other, unknown
   - budget sensitivity: low, medium, high
   - risk tolerance: low, medium, high
   - workflow: test_first, standard, exploratory, other

   Don't ask about complexity. Infer `complexity` (simple, standard, complex) from the goal: complex means architecture-heavy work such as a re-architecture, a migration or a large refactor. Pass it with the answers.

4. **Plan.** Call `recommend_setup` with the profile and the answers. Present a numbered list. For each item give:
   - name, kind and `categoryLabel`;
   - **Why:** the `reason`, quoted as given (it names the signal that matched, e.g. "Tailwind CSS 4 detected in package.json");
   - **Fit:** `fit` with `fitReason` (how well it fits this project);
   - **Credibility:** `credibility` with `credibilitySummary` in plain words (the review gates: hygiene, provenance, health, security). Keep fit and credibility as two separate lines; never merge them into one "confidence";
   - **Trade-off:** the `tradeoff`.

   Then, for each entry in `gaps`, one line: "<categoryLabel>: no suitable item in the catalog yet" plus its `detail`. Recommend nothing for those categories, and don't suggest items from outside the catalog. Then list the excluded items with their reasons, the total context overhead (always-loaded tokens; warn if `contextOverhead.warning`; name `unknownItems` as "not measured"), and the model suggestion with its cost note (it may suggest Opus for complex work when the budget allows; always repeat the cost note). Then list the proposed `hooks` (format, lint, typecheck), each with its description and reason.

   Then, before asking for approval, show the setup's **trade-off** next to its benefits: the items' reasons above are the benefits; `setupTradeoff.summary` is what the setup costs (measured success rate with and without a setup, extra tokens and cost per task, and the always-loaded context). Quote it as given and don't round it further. If it says the overhead hasn't been measured yet, say so plainly; never estimate a percentage yourself.

5. **Approval.** Ask the user to approve or remove items and hooks, one by one (e.g. "keep 1, 2, 4; drop 3; hooks: format only"). `explain_item` gives more detail on any item when asked.
6. **Write.**
   1. Call `backup_setup` and tell the user the backup id.
   2. Call `generate_config` with the approved ids and approved `hookIds`. If it refuses because of the Claude Code version, tell the user exactly what it says and stop: write nothing.
   3. Ask whether the user wants to approve all files together or one at a time (skip the question if they already said).
      - **All together:** show the full diff of every file, ask once, then write them.
      - **One at a time:** for each file in order, show its full diff, ask, and write it only after a yes. Then stop and wait for the user's next answer before showing the next file. Never write two files in one step.

      Write the file content exactly as returned, with your file tools. If `skippedHooks` is not empty, say which hooks were not added and why (existing hooks are never changed).

   4. Run any `installCommands` only after asking, one at a time, after the files are written. Plugin installs use `--scope project`: they are recorded in `.claude/settings.json` (covered by the backup and `/setup-rollback`), while Claude Code keeps the downloaded plugin code in its user-level plugin cache. Say this when you ask. Skill copies are manual steps.
7. **Environment.** List `requiredEnvVars` by name and say where to set them (shell profile or a git-ignored env file). Never ask for the values. Remind the user to restart Claude Code after setting them.
8. **Verify.** Call `verify_setup`. Report every result per item (package version, environment variables, server start, settings): one server can fail several checks, so list all of them, not only the first. For each failure give the error and the suggested fix, and offer to remove that server. Mention any `note` (for example, a server started with placeholder values).
9. **Close.** Mention `/setup-rollback` to undo and `/setup-check` to check for updates later.
