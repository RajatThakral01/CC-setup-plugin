---
description: Show the scorecard and evidence for one catalog item
argument-hint: '<item id or name>'
---

Call the setup-agent `explain_item` tool with id "$ARGUMENTS" (call `sync_catalog` first if it reports no catalog). Summarise in plain words: what it is, its status, confidence, each credibility gate with its evidence links, security flags, eval results if any, its trade-offs (context overhead, capabilities, required environment variable names) and the alternatives in the same category.
