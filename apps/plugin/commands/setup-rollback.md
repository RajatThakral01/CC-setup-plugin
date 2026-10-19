---
description: Restore the setup files from the last setup-agent backup
argument-hint: '[backup id]'
---

1. Tell the user which files will be restored or removed, and ask for confirmation.
2. Call the setup-agent `rollback_setup` tool with the absolute path of the current project folder (and `backupId` if the user gave one: $ARGUMENTS).
3. Report exactly which files were restored and which were removed. Remind the user to restart Claude Code so MCP server changes take effect.
