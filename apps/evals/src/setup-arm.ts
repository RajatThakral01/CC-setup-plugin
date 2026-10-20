import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  analyzeProjectOutputSchema,
  generateConfigOutputSchema,
  recommendSetupOutputSchema,
  syncCatalogOutputSchema,
  type SetupAnswers,
} from '@cc-setup-agent/shared';
import type { z } from 'zod';
import { EvalError } from './errors.js';
import type { EvalItem, ItemTool, ToolSetup } from './tools.js';

export type SetupTool = Extract<ToolSetup, { kind: 'setup' }>;
type AnalyzeOutput = z.output<typeof analyzeProjectOutputSchema>;
type RecommendOutput = z.output<typeof recommendSetupOutputSchema>;
type GenerateOutput = z.output<typeof generateConfigOutputSchema>;

/** The plugin's built MCP server: the setup arm uses the product exactly as users get it. */
export const DEFAULT_PLUGIN_BUNDLE = fileURLToPath(
  new URL('../../plugin/dist/server.js', import.meta.url),
);
/** The fixture every eval task starts from. */
export const DEFAULT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/next-app', import.meta.url));

/**
 * `/setup` answers for the fixture shop (M10). Fixed so the setup arm is reproducible; the deploy
 * target is unknown because the fixture has no deploy config.
 */
export const FIXTURE_SETUP_ANSWERS: SetupAnswers = {
  goal: 'Maintain and extend this small Next.js shop: fix bugs, add features and keep it tested.',
  deployTarget: 'unknown',
  budgetSensitivity: 'medium',
  riskTolerance: 'medium',
  workflow: 'standard',
};

/** The three plugin calls the setup arm needs. */
export interface PluginClient {
  analyze(path: string): Promise<AnalyzeOutput>;
  recommend(input: {
    profile: AnalyzeOutput['profile'];
    answers: SetupAnswers;
  }): Promise<RecommendOutput>;
  generate(input: {
    path: string;
    approvedIds: string[];
    hookIds: string[];
  }): Promise<GenerateOutput>;
  close(): Promise<void>;
}

/**
 * Starts the plugin bundle over stdio. It introduces itself as `claude-code` at the eval image's
 * pinned version, because that is the Claude Code that will run the generated setup (NFR-9 gate).
 */
export async function createPluginClient(options: {
  bundlePath: string;
  catalogUrl: string;
  dataDir: string;
  claudeCodeVersion: string;
}): Promise<PluginClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.bundlePath],
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? options.dataDir,
      PLUGIN_DATA_DIR: options.dataDir,
      CC_SETUP_AGENT_CATALOG_URL: options.catalogUrl,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'claude-code', version: options.claudeCodeVersion });
  await client.connect(transport);
  const call = async <T extends z.ZodType>(
    name: string,
    args: Record<string, unknown>,
    schema: T,
  ) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    if (r.isError) throw new EvalError(`plugin ${name} failed: ${text.slice(0, 500)}`);
    return schema.parse(JSON.parse(text)) as z.output<T>;
  };
  await call('sync_catalog', {}, syncCatalogOutputSchema);
  return {
    analyze: (path) => call('analyze_project', { path }, analyzeProjectOutputSchema),
    recommend: (input) => call('recommend_setup', input, recommendSetupOutputSchema),
    generate: (input) => call('generate_config', input, generateConfigOutputSchema),
    close: () => client.close(),
  };
}

export interface SetupArmReport {
  catalogVersion: string;
  answers: SetupAnswers;
  recommended: string[];
  installed: string[];
  /** Recommended items the eval sandbox can't install (plugins, items needing accounts). */
  skipped: Array<{ id: string; reason: string }>;
  hooks: string[];
  gaps: string[];
  files: string[];
}

/**
 * Builds the "recommended setup" arm: `/setup`'s analysis and recommendation for a copy of the
 * fixture, every installable recommended item, and the files `generate_config` writes for them
 * (CLAUDE.md block, settings with hooks). `.mcp.json` is replaced by the harness's own server
 * entries, which add the eval-only flags (e.g. headless browsers) from `tools.yaml`.
 */
export async function buildSetupArm(deps: {
  client: PluginClient;
  fixtureDir: string;
  answers: SetupAnswers;
  resolve: (id: string) => Promise<ItemTool>;
}): Promise<{ tool: SetupTool; report: SetupArmReport }> {
  const work = await mkdtemp(join(tmpdir(), 'ccsa-setup-arm-'));
  const app = join(work, 'app');
  await cp(deps.fixtureDir, app, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.next)([\\/]|$)/.test(src),
  });
  const analysis = await deps.client.analyze(app);
  const rec = await deps.client.recommend({ profile: analysis.profile, answers: deps.answers });

  const items: EvalItem[] = [];
  const servers: SetupTool['servers'] = {};
  const prewarm: string[][] = [];
  const files: SetupTool['files'] = [];
  const plugins: SetupTool['plugins'] = [];
  const skipped: SetupArmReport['skipped'] = [];
  for (const r of rec.items) {
    let setup: ItemTool;
    try {
      setup = await deps.resolve(r.id);
    } catch (error) {
      skipped.push({ id: r.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (setup.kind === 'mcp') {
      servers[setup.item.id] = setup.server;
      prewarm.push(...setup.prewarm);
      items.push(setup.item);
    } else if (setup.kind === 'skill') {
      for (const f of setup.files)
        files.push({ path: `.claude/skills/${setup.item.id}/${f.path}`, content: f.content });
      items.push(setup.item);
    } else {
      plugins.push({ id: setup.item.id, files: setup.files });
      items.push(setup.item);
    }
  }

  const hookIds = rec.hooks.map((h) => h.id);
  const generated = await deps.client.generate({
    path: app,
    approvedIds: items.map((i) => i.id),
    hookIds,
  });
  for (const f of generated.files)
    if (f.path !== '.mcp.json' && f.action !== 'unchanged')
      files.push({ path: f.path, content: Buffer.from(f.content) });

  return {
    tool: {
      kind: 'setup',
      label: `recommended setup (catalog ${rec.catalogVersion})`,
      items,
      servers,
      prewarm,
      files,
      plugins,
    },
    report: {
      catalogVersion: rec.catalogVersion,
      answers: deps.answers,
      recommended: rec.items.map((i) => i.id),
      installed: items.map((i) => i.id),
      skipped,
      hooks: hookIds,
      gaps: rec.gaps.map((g) => g.category),
      files: [
        ...new Set(
          files.map((f) =>
            f.path.startsWith('.claude/skills/')
              ? f.path.split('/').slice(0, 3).join('/') + '/'
              : f.path,
          ),
        ),
      ],
    },
  };
}
