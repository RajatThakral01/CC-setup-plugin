# cc-setup-agent

A Claude Code plugin (`setup-agent`) that recommends, writes and verifies an evidence-backed Claude Code setup for a project, plus the backend that builds its catalog. MVP: Next.js projects, local-first.

- `apps/plugin`: the plugin users install (MCP server, `/setup` commands, setup skill).
- `apps/pipeline`: discovery, credibility gates, signed catalog snapshots.
- `apps/triage`: local web UI where the maintainer approves catalog items.
- `docs/`: PRD, implementation plan, progress and decisions.

## Requirements

Node.js 24 (the plugin itself needs Node 20+), pnpm (via `corepack enable pnpm`), Docker (for Postgres and the gate sandbox), Claude Code 2.1+.

## Backend quick start

```sh
pnpm install
docker compose up -d          # Postgres on localhost:5433
pnpm db:migrate
cp .env.example .env          # then fill in the secrets (see the file)
pnpm run pipeline seed        # import catalog/seed.yaml
pnpm run pipeline discover    # daily discovery, intake, classification (costs a little)
pnpm run pipeline gates --pending
pnpm triage                   # http://127.0.0.1:4400 — approve items
pnpm run pipeline snapshot    # sign and publish the catalog to .snapshots/
```

## Install the plugin (local marketplace)

1. Build the plugin's bundled MCP server:

   ```sh
   pnpm plugin:build           # writes apps/plugin/dist/server.js
   ```

2. Tell the plugin where the signed catalog is. Add to your shell profile (use the absolute path of this repo):

   ```sh
   export CC_SETUP_AGENT_CATALOG_URL="file:///absolute/path/to/this/repo/.snapshots/"
   ```

3. In Claude Code (restart it after step 2), add this repo as a marketplace and install the plugin:

   ```
   /plugin marketplace add /absolute/path/to/this/repo
   /plugin install setup-agent@cc-setup-agent
   ```

   Or from a terminal: `claude plugin marketplace add <path>` and `claude plugin install setup-agent@cc-setup-agent`.

4. Restart Claude Code, open a project, and run `/setup` (namespaced form: `/setup-agent:setup`).

Commands: `/setup`, `/setup-check`, `/setup-rollback [backup id]`, `/explain <item>`.

The plugin never asks for secret values, shows a diff before every write, writes only through Claude Code's normal permission prompts, and backs up files to `.claude/setup-agent/backups/` first.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test
SANDBOX_TESTS=1 pnpm test     # also run the real-Docker sandbox tests
```

See `CLAUDE.md` for the full command list and project rules.
