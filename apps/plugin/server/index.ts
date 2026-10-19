import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import {
  analyzeProjectInputSchema,
  analyzeProjectOutputSchema,
  backupSetupInputSchema,
  backupSetupOutputSchema,
  checkUpdatesInputSchema,
  checkUpdatesOutputSchema,
  explainItemInputSchema,
  explainItemOutputSchema,
  generateConfigInputSchema,
  generateConfigOutputSchema,
  recommendSetupInputSchema,
  recommendSetupOutputSchema,
  rollbackSetupInputSchema,
  rollbackSetupOutputSchema,
  syncCatalogOutputSchema,
  verifySetupInputSchema,
  verifySetupOutputSchema,
} from '@cc-setup-agent/shared';
import { analyzeProject } from './analyze.js';
import { assertSupportedVersion, detectClaudeCodeVersion } from './cc-version.js';
import { backupSetup, rollbackSetup } from './backup.js';
import {
  loadCatalog,
  NO_CATALOG,
  staleWarning,
  syncCatalog,
  type LoadedCatalog,
} from './catalog.js';
import { explainItem } from './explain.js';
import { PluginError, projectRoot } from './files.js';
import { generateConfig } from './generate.js';
import { log } from './log.js';
import { recommendSetup } from './recommend.js';
import { settingsFromEnv, type PluginSettings } from './settings.js';
import { blockedWarnings, checkUpdates } from './updates.js';
import { verifySetup } from './verify.js';

export const SERVER_NAME = 'setup-agent';
export const SERVER_VERSION = '0.1.0';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok<T extends z.ZodType>(schema: T, value: z.input<T>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(schema.parse(value), null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const message =
    error instanceof PluginError
      ? error.message
      : error instanceof Error
        ? `Unexpected error: ${error.message}`
        : String(error);
  if (!(error instanceof PluginError)) log('error', 'tool failed', { error: message });
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function requireCatalog(settings: PluginSettings): Promise<LoadedCatalog> {
  const catalog = await loadCatalog(settings);
  if (!catalog) throw new PluginError('No catalog yet. Call sync_catalog first.');
  return catalog;
}

/** The plugin's MCP server (plan M7). Tool descriptions are kept short (NFR-2). */
export function createServer(
  settings: PluginSettings = settingsFromEnv(),
  env: Record<string, string | undefined> = process.env,
  deps: { claudeCodeVersion?: () => Promise<string | null> } = {},
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const claudeCodeVersion =
    deps.claudeCodeVersion ?? (() => detectClaudeCodeVersion(server.server.getClientVersion()));
  const tool = <S extends z.ZodObject>(
    name: string,
    description: string,
    input: S,
    run: (args: z.output<S>) => Promise<ToolResult>,
  ) =>
    server.registerTool(name, { description, inputSchema: input.shape }, async (args: unknown) => {
      try {
        return await run(input.parse(args));
      } catch (error) {
        return fail(error);
      }
    });

  tool(
    'sync_catalog',
    'Download and verify the signed catalog; reports its age.',
    syncCatalogOutputSchema.pick({}),
    async () => {
      const r = await syncCatalog(settings);
      const warning = [r.warning, staleWarning(r.catalog, settings.staleAfterDays)]
        .filter(Boolean)
        .join(' ');
      return ok(syncCatalogOutputSchema, {
        catalogVersion: r.catalog?.snapshot.version ?? NO_CATALOG,
        generatedAt: r.catalog?.snapshot.generatedAt ?? new Date(0).toISOString(),
        ageDays: r.catalog?.ageDays ?? 0,
        stale: r.catalog?.stale ?? true,
        updated: r.updated,
        itemCount: r.catalog?.snapshot.items.length ?? 0,
        ...(warning ? { warning } : {}),
      });
    },
  );

  tool(
    'analyze_project',
    'Detect stack and existing Claude Code config (metadata only).',
    analyzeProjectInputSchema,
    async ({ path }) => {
      const root = await projectRoot(path);
      const catalog = await loadCatalog(settings).catch(() => null);
      return ok(analyzeProjectOutputSchema, {
        catalogVersion: catalog?.snapshot.version ?? NO_CATALOG,
        profile: await analyzeProject(root),
        warnings: await blockedWarnings(root, catalog?.snapshot ?? null),
      });
    },
  );

  tool(
    'recommend_setup',
    'Recommend a minimal setup for a profile and answers.',
    recommendSetupInputSchema,
    async ({ profile, answers }) => {
      const { snapshot } = await requireCatalog(settings);
      return ok(
        recommendSetupOutputSchema,
        recommendSetup(snapshot, profile, answers, settings.contextWarnTokens),
      );
    },
  );

  tool(
    'explain_item',
    'Scorecard, evidence and alternatives for one catalog item.',
    explainItemInputSchema,
    async ({ id }) => {
      const { snapshot } = await requireCatalog(settings);
      return ok(explainItemOutputSchema, {
        catalogVersion: snapshot.version,
        ...explainItem(snapshot, id),
      });
    },
  );

  tool(
    'backup_setup',
    'Back up existing setup files before changes.',
    backupSetupInputSchema,
    async ({ path }) => {
      const root = await projectRoot(path);
      const catalog = await loadCatalog(settings).catch(() => null);
      const m = await backupSetup(root, catalog?.snapshot.version ?? NO_CATALOG);
      return ok(backupSetupOutputSchema, {
        catalogVersion: m.catalogVersion,
        backupId: m.backupId,
        files: m.files.filter((f) => f.existed).map((f) => f.path),
      });
    },
  );

  tool(
    'generate_config',
    'File contents and diffs for approved items; writes nothing.',
    generateConfigInputSchema,
    async ({ path, approvedIds, hookIds }) => {
      const root = await projectRoot(path);
      // NFR-9: refuse to generate config for unsupported Claude Code versions.
      const version = assertSupportedVersion(await claudeCodeVersion());
      const { snapshot } = await requireCatalog(settings);
      return ok(generateConfigOutputSchema, {
        catalogVersion: snapshot.version,
        claudeCodeVersion: version,
        ...(await generateConfig(root, snapshot, approvedIds, hookIds)),
      });
    },
  );

  tool(
    'verify_setup',
    'Start configured MCP servers and check env vars and settings.',
    verifySetupInputSchema,
    async ({ path }) => {
      const root = await projectRoot(path);
      const catalog = await loadCatalog(settings).catch(() => null);
      const results = await verifySetup(root, env, settings.verifyTimeoutMs);
      return ok(verifySetupOutputSchema, {
        catalogVersion: catalog?.snapshot.version ?? NO_CATALOG,
        ok: results.every((r) => r.status === 'pass'),
        results,
      });
    },
  );

  tool(
    'check_updates',
    'Blocked, deprecated, superseded or outdated installed items.',
    checkUpdatesInputSchema,
    async ({ path }) => {
      const root = await projectRoot(path);
      const { snapshot } = await requireCatalog(settings);
      return ok(checkUpdatesOutputSchema, {
        catalogVersion: snapshot.version,
        notices: await checkUpdates(root, snapshot),
      });
    },
  );

  tool(
    'rollback_setup',
    'Restore setup files from the latest (or given) backup.',
    rollbackSetupInputSchema,
    async ({ path, backupId }) => {
      const root = await projectRoot(path);
      const catalog = await loadCatalog(settings).catch(() => null);
      return ok(rollbackSetupOutputSchema, {
        catalogVersion: catalog?.snapshot.version ?? NO_CATALOG,
        ...(await rollbackSetup(root, backupId)),
      });
    },
  );

  return server;
}
