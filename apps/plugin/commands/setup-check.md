---
description: Check the installed setup for blocked, deprecated or outdated items
---

1. Call the setup-agent `sync_catalog` tool, then `check_updates` with the absolute path of the current project folder.
2. Show blocked items first and prominently, with the reason and an offer to remove them from `.mcp.json` (show the diff and ask before writing).
3. Then list deprecated, superseded and outdated items with their replacements, and items not in the catalog (kept as they are).
4. If nothing needs attention, say so in one line, with the catalog version and age.
