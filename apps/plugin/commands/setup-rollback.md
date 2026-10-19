---
description: Restore the setup files from the last setup-agent backup
argument-hint: '[backup id]'
---

1. Call the setup-agent `rollback_setup` tool with the absolute path of the current project folder, `dryRun: true` (and `backupId` if the user gave one: $ARGUMENTS). Nothing changes yet.
2. Tell the user which files will be restored and which removed. If `plugins` or `marketplaces` is not empty, say these were installed at project scope after the backup: restoring `.claude/settings.json` turns them off for this project, but Claude Code keeps their downloaded copy. List each `uninstallCommand` and `removeCommand` exactly, and offer to run them first (one at a time, after asking). Ask for confirmation.
3. After a yes (and after any uninstall commands the user approved), call `rollback_setup` again with the same arguments and `dryRun: false`.
4. Report exactly which files were restored and which were removed, and any plugin commands the user chose not to run (so they can run them later). Remind the user to restart Claude Code so MCP server and plugin changes take effect.
