import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, parseConfig } from '@cc-setup-agent/core';
import { budgetLedger, evalRuns } from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { createLocalArtifactStore } from './artifacts.js';
import { measuredCosts } from './costs.js';
import { mcpConfigFor, type RunSpec } from './driver.js';
import { compareSetup, formatSetupReport } from './evaluate-setup.js';
import type { EvalContext } from './runner.js';
import {
  buildSetupArm,
  FIXTURE_SETUP_ANSWERS,
  type PluginClient,
  type SetupArmReport,
  type SetupTool,
} from './setup-arm.js';
import type { EvalTask, TaskSet } from './tasks.js';
import { createFakeDriver, type FakeRunBehaviour } from './testing.js';
import type { EvalItem, ItemTool } from './tools.js';

const FAST = 'claude-haiku-5-5';
const CATALOG = '2026.01.01-1';

const evalItem = (id: string, kind: EvalItem['kind']): EvalItem => ({
  id,
  kind,
  install: { method: kind === 'skill' ? 'skill_copy' : 'npx', envVars: [] },
  version: kind === 'skill' ? 'sha-aaaaaaa' : '1.0.0',
  sourceUrl: `https://github.com/example-org/${id}`,
  contextOverheadTokens: 100,
});

describe('buildSetupArm', () => {
  it('installs every evaluable recommended item with the generated CLAUDE.md and settings', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'ccsa-fixture-'));
    await writeFile(join(fixture, 'package.json'), '{}');
    await mkdir(join(fixture, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(fixture, 'node_modules', 'x', 'index.js'), '');
    const calls: Record<string, unknown> = {};
    const client: PluginClient = {
      analyze: async (path) => {
        calls['analyze'] = await readdir(path);
        return { catalogVersion: CATALOG, profile: { stacks: ['nextjs'] }, warnings: [] } as never;
      },
      recommend: async (input) => {
        calls['recommend'] = input;
        return {
          catalogVersion: CATALOG,
          items: [
            { id: 'example-mcp-alpha' },
            { id: 'example-skill-beta' },
            { id: 'example-plugin-gamma' },
          ],
          gaps: [{ category: 'deploy' }],
          hooks: [{ id: 'typecheck-on-stop' }],
        } as never;
      },
      generate: async (input) => {
        calls['generate'] = input;
        return {
          files: [
            { path: 'CLAUDE.md', action: 'create', content: '# block', diff: '' },
            { path: '.mcp.json', action: 'create', content: '{}', diff: '' },
            { path: '.claude/settings.json', action: 'create', content: '{"hooks":{}}', diff: '' },
          ],
        } as never;
      },
      close: async () => undefined,
    };
    const resolve = async (id: string): Promise<ItemTool> => {
      if (id === 'example-mcp-alpha')
        return {
          kind: 'mcp',
          item: evalItem(id, 'mcp_server'),
          server: { command: 'npx', args: ['-y', '@example/alpha@1.0.0', '--headless'] },
          prewarm: [['npm', 'exec', '--yes', '--package=@example/alpha@1.0.0', '--', 'true']],
        };
      if (id === 'example-skill-beta')
        return {
          kind: 'skill',
          item: evalItem(id, 'skill'),
          files: [{ path: 'SKILL.md', content: Buffer.from('# beta') }],
        };
      throw new Error(`${id}: install method plugin isn't supported in evals yet`);
    };

    const { tool, report } = await buildSetupArm({
      client,
      fixtureDir: fixture,
      answers: FIXTURE_SETUP_ANSWERS,
      resolve,
    });

    expect(calls['analyze']).toEqual(['package.json']); // a copy, without node_modules
    expect(calls['recommend']).toMatchObject({ answers: FIXTURE_SETUP_ANSWERS });
    expect(calls['generate']).toMatchObject({
      approvedIds: ['example-mcp-alpha', 'example-skill-beta'],
      hookIds: ['typecheck-on-stop'],
    });
    expect(tool.label).toBe(`recommended setup (catalog ${CATALOG})`);
    expect(tool.items.map((i) => i.id)).toEqual(['example-mcp-alpha', 'example-skill-beta']);
    // The harness's own server entry (with eval-only flags) replaces the generated .mcp.json.
    expect(JSON.parse(mcpConfigFor(tool))).toEqual({
      mcpServers: {
        'example-mcp-alpha': { command: 'npx', args: ['-y', '@example/alpha@1.0.0', '--headless'] },
      },
    });
    expect(tool.prewarm).toHaveLength(1);
    expect(tool.files.map((f) => f.path).sort()).toEqual([
      '.claude/settings.json',
      '.claude/skills/example-skill-beta/SKILL.md',
      'CLAUDE.md',
    ]);
    expect(report).toMatchObject({
      catalogVersion: CATALOG,
      recommended: ['example-mcp-alpha', 'example-skill-beta', 'example-plugin-gamma'],
      installed: ['example-mcp-alpha', 'example-skill-beta'],
      skipped: [{ id: 'example-plugin-gamma', reason: expect.stringContaining('plugin') }],
      hooks: ['typecheck-on-stop'],
      gaps: ['deploy'],
    });
  });
});

describe('compareSetup (recommended setup vs default)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    await t.db.delete(evalRuns);
    await t.db.delete(budgetLedger);
  });

  const setup: SetupTool = {
    kind: 'setup',
    label: `recommended setup (catalog ${CATALOG})`,
    items: [evalItem('example-mcp-alpha', 'mcp_server')],
    servers: { 'example-mcp-alpha': { command: 'npx', args: [] } },
    prewarm: [],
    files: [{ path: 'CLAUDE.md', content: Buffer.from('# block') }],
    plugins: [],
  };
  const task = (category: TaskSet['category'], id: string): EvalTask => ({
    id,
    category,
    version: 1,
    title: id,
    prompt: `Do ${id}`,
    dir: '/nonexistent',
    checkFiles: new Map(),
  });
  const set = (category: TaskSet['category']): TaskSet => ({
    category,
    version: `${category}-v1-test0001`,
    technologies: [],
    tasks: [task(category, `${category}-a`), task(category, `${category}-b`)],
  });
  const report: SetupArmReport = {
    catalogVersion: CATALOG,
    answers: FIXTURE_SETUP_ANSWERS,
    recommended: ['example-mcp-alpha', 'example-plugin-gamma'],
    installed: ['example-mcp-alpha'],
    skipped: [{ id: 'example-plugin-gamma', reason: 'plugin' }],
    hooks: ['typecheck-on-stop'],
    gaps: [],
    files: ['CLAUDE.md'],
  };

  const context = async (behaviour: (spec: RunSpec) => FakeRunBehaviour, env = {}) => {
    const config = parseConfig({ EVAL_RUN_MAX_USD: '1.5', ...env });
    const driver = createFakeDriver(behaviour);
    const ctx: EvalContext = {
      config,
      logger: createLogger({ level: 'silent' }),
      db: t.db,
      driver,
      artifacts: createLocalArtifactStore(await mkdtemp(join(tmpdir(), 'ccsa-evals-'))),
      claudeCodeVersion: '2.1.303',
      image: 'ccsa-eval:test',
      measured: () => measuredCosts(t.db),
    };
    return { ctx, driver };
  };

  it('runs both arms per task, reports per category, and reuses cached default runs', async () => {
    // The setup solves every docs task; the default solves half; browser_testing is a tie.
    const behaviour = (spec: RunSpec): FakeRunBehaviour => ({
      success:
        spec.tool.kind === 'setup' ||
        spec.task.category === 'browser_testing' ||
        spec.task.id.endsWith('-a'),
      costUsd: spec.tool.kind === 'setup' ? 0.02 : 0.01,
    });
    const { ctx, driver } = await context(behaviour);
    const sets = [set('browser_testing'), set('docs')];
    const r = await compareSetup(ctx, { taskSets: sets, setup, runs: 2, model: FAST });

    expect(driver.calls).toHaveLength(16); // 2 categories × 2 tasks × 2 runs × 2 arms
    expect(r.stopped).toBeNull();
    const docs = r.categories.find((c) => c.category === 'docs')!;
    expect(docs.setup).toMatchObject({ runs: 4, passed: 4, successRate: 1 });
    expect(docs.baseline).toMatchObject({ runs: 4, passed: 2, successRate: 0.5 });
    expect(docs.lead).toBeCloseTo(0.5, 9);
    expect(r.categories.find((c) => c.category === 'browser_testing')!.lead).toBe(0);
    expect(r.overall.lead).toBeCloseTo(0.25, 9);
    expect(r.ambiguous).toBe(false);
    expect(r.overall.setup.meanCostUsd).toBeCloseTo(0.02, 6);

    const rows = await t.db.select().from(evalRuns);
    const setupRows = rows.filter((x) => x.stage === 'setup');
    expect(setupRows).toHaveLength(8);
    expect(setupRows.every((x) => x.itemId === null && x.withTool)).toBe(true);
    expect(rows.filter((x) => x.stage === 'baseline' && !x.withTool)).toHaveLength(8);

    // A second comparison reuses the 8 cached default runs and only runs the setup arm.
    const again = await context(behaviour);
    const r2 = await compareSetup(again.ctx, { taskSets: sets, setup, runs: 2, model: FAST });
    expect(again.driver.calls.every((c) => c.tool.kind === 'setup')).toBe(true);
    expect(again.driver.calls).toHaveLength(8);
    expect(r2.overall.baseline.runs).toBe(8);

    const md = formatSetupReport(r, report, '2026-01-01');
    expect(md).toContain('| docs | 4/4 (100%)');
    expect(md).toContain('| **all** |');
    expect(md).toContain('Not installable in the eval sandbox: example-plugin-gamma (plugin)');
  });

  it('calls a small or mixed lead ambiguous', async () => {
    const { ctx } = await context((spec) => ({
      // setup wins docs, loses browser_testing
      success:
        spec.task.category === 'docs' ? spec.tool.kind === 'setup' : spec.tool.kind !== 'setup',
      costUsd: 0.01,
    }));
    const r = await compareSetup(ctx, {
      taskSets: [set('browser_testing'), set('docs')],
      setup,
      runs: 1,
      model: FAST,
    });
    expect(r.overall.lead).toBe(0);
    expect(r.ambiguous).toBe(true);
  });

  it('stops cleanly at the budget, keeping the results it has', async () => {
    // A measured mean of USD 0.6 per run: the first task's batch (4 runs) passes the pre-flight,
    // and the USD 2 batch ceiling stops the comparison part-way.
    await t.db.insert(evalRuns).values({
      runId: 'example-measured',
      taskId: 'pilot',
      taskSetVersion: 'pilot-set',
      model: FAST,
      claudeCodeVersion: '2.1.303',
      withTool: false,
      success: true,
      costUsd: 0.6,
      costSource: 'relay',
    });
    const { ctx } = await context(() => ({ success: true, costUsd: 0.6 }), {
      WEEKLY_BUDGET_USD: '5',
      BUDGET_SPLIT_CLASSIFY_USD: '1',
    });
    const r = await compareSetup(
      { ...ctx, spendCeiling: { limitUsd: 2, since: new Date(0) } },
      { taskSets: [set('docs')], setup, runs: 2, model: FAST },
    );
    expect(r.stopped).toMatch(/^docs\/docs-a: .*batch ceiling/);
    expect(r.newRuns.length).toBe(3);
    const booked = (await t.db.select().from(budgetLedger)).reduce((sum, x) => sum + x.costUsd, 0);
    expect(booked).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('treats a setup-arm timeout as a failure, like a default-arm one', async () => {
    const { ctx } = await context(() => ({ success: true, costUsd: 0.01, timedOut: true }));
    const r = await compareSetup(ctx, { taskSets: [set('docs')], setup, runs: 1, model: FAST });
    expect(r.overall.setup.passed).toBe(0);
    expect(r.overall.baseline.passed).toBe(0);
  });
});
