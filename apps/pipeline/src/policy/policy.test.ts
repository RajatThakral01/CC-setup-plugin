import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient, createLogger, parseConfig, type MessagesApi } from '@cc-setup-agent/core';
import {
  acceptedVersions,
  acceptVersion,
  budgetLedger,
  buildDigest,
  heldChanges,
  catalogItems,
  createLedgerGuard,
  eq,
  evalRuns,
  insertCandidate,
  itemVersions,
  policyDecisions,
  rawSourceRecords,
  resolveHeldChange,
  scorecards,
  signalSnapshots,
  statusEvents,
  transitionStatus,
  vetoItem,
} from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import {
  approvalPolicySchema,
  categoryRulesSchema,
  isoWeekStart,
  type Classification,
  type EvalSummary,
  type GateResults,
} from '@cc-setup-agent/shared';
import { fakeHttp } from '../../../../test/support/http.js';
import { readCategoryRules, readPolicy } from '../catalog-config.js';
import { classificationInputHash, PROMPT_VERSION } from '../classify/classifier.js';
import { createGithubClient } from '../sources/github.js';
import { createNpmClient } from '../sources/npm.js';
import { planAutoEvals, runAutoEvals } from './auto-evals.js';
import { renderDigestMarkdown } from './digest.js';
import { orgLocks, ruleInputsFrom } from './facts.js';
import { formatPolicyReport, runPolicy } from './run.js';

const GH = 'https://api.github.test';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const README = '# Example\nA tool for tests.';

const policy = approvalPolicySchema.parse({
  version: 'policy-test',
  vendor_tier_provenances: ['anthropic', 'official_vendor'],
  required_gates: ['gate0_hygiene', 'gate1_provenance', 'gate2_health', 'gate3_security'],
  max_days_since_commit: 90,
  supported_stacks: ['nextjs'],
  install_methods: {
    mcp_server: ['npx', 'uvx', 'remote'],
    skill: ['skill_copy'],
    plugin: ['plugin'],
  },
  promotion: { min_days_provisional: 60 },
  demotion: { abandoned_days: 180 },
  auto_evals: { cron: '0 6 * * 1', per_category: 2, total_reserve_usd: 5, headroom: 0.9 },
});
const rules = categoryRulesSchema.parse({
  version: 'rules-test',
  categories: { browser_testing: ['browser', 'playwright'], database: ['postgres', 'database'] },
});

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  await t.db.delete(acceptedVersions);
  await acceptVersion(t.db, 'scanner', 'scanner-v1', 'test: as the migration seeds it');
  for (const table of [
    heldChanges,
    policyDecisions,
    evalRuns,
    budgetLedger,
    statusEvents,
    signalSnapshots,
    scorecards,
    itemVersions,
    rawSourceRecords,
  ])
    await t.db.delete(table);
  await t.db.delete(catalogItems);
});

const gate = (result: 'pass' | 'soft_fail' | 'fail') => ({
  result,
  evidence: [{ label: 'source', url: 'https://github.com/example-org/x' }],
  checkedAt: NOW.toISOString(),
});
const PASS: GateResults = {
  gate0_hygiene: gate('pass'),
  gate1_provenance: gate('pass'),
  gate2_health: gate('pass'),
  gate3_security: gate('pass'),
};
const classification = (over: Partial<Classification> = {}): Classification => ({
  kind: 'mcp_server',
  category: 'browser_testing',
  stacks: ['any'],
  technologies: [],
  summary: 'Drives a browser.',
  provenanceGuess: 'official_vendor',
  relevant: true,
  model: 'claude-haiku-5-5',
  promptVersion: PROMPT_VERSION,
  classifiedAt: NOW.toISOString(),
  ...over,
});

interface Seed {
  id: string;
  provenance?: 'official_vendor' | 'community' | 'anthropic';
  category?: 'browser_testing' | 'database';
  gates?: GateResults;
  findings?: Array<{ severity: 'high' | 'low'; description: string }>;
  lastCommitDays?: number;
  second?: Partial<Classification> | null;
  evalSummary?: EvalSummary;
  stars?: number;
  velocity?: number;
  technologies?: string[];
}

async function seed(s: Seed): Promise<void> {
  const category = s.category ?? 'browser_testing';
  const hash = classificationInputHash({ description: 'desc', components: null, readme: README });
  await insertCandidate(
    t.db,
    {
      id: s.id,
      name: s.id,
      description: 'desc',
      sourceUrl: `https://github.com/example-org/${s.id}`,
      kind: 'mcp_server',
      category,
      stacks: ['any'],
      ...(s.technologies ? { technologies: s.technologies } : {}),
      provenance: s.provenance ?? 'official_vendor',
      install: { method: 'npx', package: s.id, version: '1.0.0', envVars: [] },
      classification: classification({ category }),
      classificationState: 'classified',
      classificationInputHash: hash,
      ...(s.second === null
        ? {}
        : {
            secondOpinion: {
              ...classification({ category, model: 'claude-sonnet-5-5' }),
              ...s.second,
              inputHash: hash,
            },
          }),
    },
    'system',
    'fixture',
  );
  await t.db.insert(itemVersions).values({ itemId: s.id, version: '1.0.0', pinned: true });
  await t.db.insert(scorecards).values({
    itemId: s.id,
    version: '1.0.0',
    gateResults: s.gates ?? PASS,
    securityFindings: s.findings ?? [],
    confidence: 'high',
    ...(s.evalSummary ? { evalSummary: s.evalSummary } : {}),
  });
  await t.db.insert(signalSnapshots).values({
    itemId: s.id,
    capturedAt: NOW,
    lastCommitAt: daysAgo(s.lastCommitDays ?? 5),
    stars: s.stars ?? 100,
    starVelocity7d: s.velocity ?? 1,
  });
}

function deps(withLlm = false, replies: string[] = []) {
  const config = parseConfig({});
  const create = vi.fn(async () => ({
    content: [
      {
        type: 'text',
        text:
          replies.shift() ??
          JSON.stringify({
            kind: 'mcp_server',
            category: 'browser_testing',
            stacks: ['any'],
            technologies: [],
            summary: 'Drives a browser.',
            provenance_guess: 'official_vendor',
            relevant: true,
          }),
      },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 2000, output_tokens: 80 },
  }));
  const routes = Object.fromEntries(
    ['example-mcp-alpha', 'example-mcp-beta', 'example-mcp-gamma'].map((id) => [
      `${GH}/repos/example-org/${id}/readme`,
      () => new Response(README),
    ]),
  );
  const { http } = fakeHttp(routes);
  const logger = createLogger({ level: 'silent' });
  return {
    create,
    deps: {
      db: t.db,
      config,
      logger,
      github: createGithubClient(http, 'test-token', GH),
      npm: createNpmClient(http, 'https://npm.example.test'),
      policy,
      rules,
      ...(withLlm
        ? {
            llm: createLlmClient({
              config,
              guard: createLedgerGuard(t.db, config),
              messages: { create } as unknown as MessagesApi,
            }),
          }
        : {}),
    },
  };
}

const statusOf = async (id: string) =>
  (await t.db.select().from(catalogItems).where(eq(catalogItems.id, id)))[0]?.status;
const lastEvent = async (id: string) =>
  (await t.db.select().from(statusEvents).where(eq(statusEvents.itemId, id))).at(-1);

describe('runPolicy', () => {
  it('approves an eligible vendor item with the policy actor, an audited reason and a stored decision', async () => {
    await seed({ id: 'example-mcp-alpha' });
    const report = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(report.outcomes[0]).toMatchObject({ applied: true, decision: { action: 'approve' } });
    expect(await statusOf('example-mcp-alpha')).toBe('recommended_provisional');
    const event = await lastEvent('example-mcp-alpha');
    expect(event?.actor).toBe('policy:policy-test');
    expect(event?.reason).toContain('official-vendor tier, all criteria hold');
    const [decision] = await t.db.select().from(policyDecisions);
    expect(decision).toMatchObject({
      action: 'approve',
      applied: true,
      policyVersion: 'policy-test',
    });
    expect(decision?.criteria.every((c) => c.ok)).toBe(true);
  });

  it('changes nothing in a dry run, but stores the decision as not applied', async () => {
    await seed({ id: 'example-mcp-alpha' });
    await runPolicy(deps().deps, { apply: false, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    expect((await t.db.select().from(policyDecisions))[0]).toMatchObject({
      action: 'approve',
      applied: false,
    });
  });

  it('asks the strong model only when that is the missing piece, then approves on agreement', async () => {
    await seed({ id: 'example-mcp-alpha', second: null });
    await seed({ id: 'example-mcp-beta', second: null, lastCommitDays: 200 });
    const { deps: d, create } = deps(true);
    const report = await runPolicy(d, { apply: true, secondOpinions: true, now: NOW });
    expect(create).toHaveBeenCalledTimes(1);
    expect(report.secondOpinions).toMatchObject({ asked: 1, agreed: 1 });
    expect(await statusOf('example-mcp-alpha')).toBe('recommended_provisional');
    expect(await statusOf('example-mcp-beta')).toBe('candidate');
    const ledger = await t.db.select().from(budgetLedger);
    expect(ledger.map((r) => r.model)).toEqual(['claude-sonnet-5-5']);
  });

  it('holds an item when the second opinion disagrees, without creating any task', async () => {
    await seed({ id: 'example-mcp-alpha', second: null });
    const disagree = JSON.stringify({
      kind: 'mcp_server',
      category: 'search',
      stacks: ['any'],
      technologies: [],
      summary: 'Fetches pages.',
      provenance_guess: 'official_vendor',
      relevant: true,
    });
    const report = await runPolicy(deps(true, [disagree]).deps, {
      apply: true,
      secondOpinions: true,
      now: NOW,
    });
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    expect(report.outcomes[0]?.decision.reason).toContain('models disagree');
  });

  it('never approves security-flagged or vetoed items', async () => {
    await seed({
      id: 'example-mcp-alpha',
      findings: [{ severity: 'high', description: 'vulnerable dependency' }],
    });
    await seed({ id: 'example-mcp-beta' });
    await vetoItem(t.db, 'example-mcp-beta', 'human:owner', 'not useful');
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    expect(await statusOf('example-mcp-beta')).toBe('candidate');
  });

  it('requires a winning eval for community items', async () => {
    await seed({ id: 'example-mcp-alpha', provenance: 'community' });
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    const decision = (await t.db.select().from(policyDecisions))[0];
    expect(decision?.criteria.find((c) => !c.ok)?.id).toBe('eval_beats_incumbent');
  });

  it('demotes approved items with an audited reason (abandoned → watchlist, new finding → blocked)', async () => {
    await seed({ id: 'example-mcp-alpha', lastCommitDays: 200 });
    await seed({
      id: 'example-mcp-beta',
      findings: [{ severity: 'high', description: 'new CVE' }],
    });
    for (const id of ['example-mcp-alpha', 'example-mcp-beta'])
      await t.db
        .update(catalogItems)
        .set({ status: 'recommended_provisional' })
        .where(eq(catalogItems.id, id));
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('watchlist');
    expect(await lastEvent('example-mcp-alpha')).toMatchObject({
      actor: 'policy:policy-test',
      reason: expect.stringContaining('no commit for 200 days'),
    });
    expect(await statusOf('example-mcp-beta')).toBe('blocked');
  });

  it('builds a digest of what the policy did, with reasons and evidence links', async () => {
    await seed({ id: 'example-mcp-alpha' });
    await seed({ id: 'example-mcp-beta', lastCommitDays: 120 });
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    const digest = await buildDigest(t.db, isoWeekStart(new Date()));
    expect(digest.approved.map((e) => e.itemId)).toEqual(['example-mcp-alpha']);
    expect(digest.heldByCriterion).toEqual([{ criterion: 'maintained', items: 1 }]);
    const md = renderDigestMarkdown(digest, 'http://127.0.0.1:4400');
    expect(md).toContain('example-mcp-alpha');
    expect(md).toContain('http://127.0.0.1:4400/items/example-mcp-alpha');
    expect(md).toContain('[source](https://github.com/example-org/example-mcp-alpha)');
    expect(md).toContain('| maintained | 1 |');
    expect(md).not.toMatch(/please review|needs review|action required/i);
  });
});

describe('policy config files', () => {
  it('parses catalog/policy.yaml and catalog/category-rules.yaml', async () => {
    const p = await readPolicy();
    expect(p.version).toMatch(/^policy-v\d+$/);
    expect(p.max_days_since_commit).toBe(90);
    expect(p.promotion.min_days_provisional).toBe(60);
    expect(p.demotion.abandoned_days).toBe(180);
    const r = await readCategoryRules();
    expect(r.min_signals).toBeGreaterThanOrEqual(2);
    expect(Object.keys(r.categories).length).toBeGreaterThan(10);
  });

  it('reads rule inputs from stored raw records', () => {
    const inputs = ruleInputsFrom(
      {
        id: 'example-mcp-alpha',
        name: 'Example',
        publisher: 'x',
        sourceUrl: 'https://github.com/example-org/example-mcp-alpha',
        components: null,
      },
      [
        { source: 'github_repo', payload: { topics: ['playwright'] } },
        { source: 'npm_package', payload: { latest: { keywords: ['browser', 7] } } },
        { source: 'marketplace', payload: { plugin: { keywords: ['e2e'], tags: ['testing'] } } },
      ],
    );
    expect(inputs).toMatchObject({
      topics: ['playwright'],
      keywords: ['browser', 'e2e', 'testing'],
      publisher: 'example-org',
    });
  });
});

describe('scheduled evals (FR-P7)', () => {
  const taskSet = async () => ({
    category: 'browser_testing' as const,
    version: 'browser_testing-v1-test',
    technologies: ['playwright'],
    tasks: Array.from({ length: 5 }, (_, i) => ({ id: `task-${i}` })) as never,
  });
  const evalDeps = (env: Record<string, string> = {}) => ({
    ...deps().deps,
    config: parseConfig(env),
    taskSet,
  });

  /** Measured mean costs per model (the M9 pilot's order of magnitude). */
  const measure = () =>
    t.db.insert(evalRuns).values(
      (
        [
          ['r1', 'claude-haiku-5-5', 0.01],
          ['r2', 'claude-sonnet-5-5', 0.13],
        ] as const
      ).map(([runId, model, costUsd]) => ({
        runId,
        taskId: 'pilot',
        taskSetVersion: 'pilot-set',
        model,
        claudeCodeVersion: '2.1.303',
        withTool: true,
        success: true,
        costUsd,
      })),
    );

  it('prices runs at the per-run cap until costs are measured', async () => {
    await seed({ id: 'example-mcp-alpha', provenance: 'community' });
    const plan = await planAutoEvals(evalDeps(), NOW);
    // 5 tasks × (3 + 1) runs × USD 1.50, plus the same for the baseline > USD 15.30 plannable.
    expect(plan.batch).toEqual([]);
    expect(plan.deferred[0]?.reason).toContain('needs ~USD 60.00');
  });

  it('plans the most promising community candidates within the budget, per category', async () => {
    await measure();
    await seed({ id: 'example-mcp-alpha', provenance: 'community', velocity: 1 });
    await seed({ id: 'example-mcp-beta', provenance: 'community', velocity: 9 });
    await seed({ id: 'example-mcp-gamma', provenance: 'community', velocity: 5 });
    // Not worth an eval: fails another criterion.
    await seed({ id: 'example-mcp-delta', provenance: 'community', lastCommitDays: 200 });
    const plan = await planAutoEvals(evalDeps(), NOW);
    expect(plan.batch.map((b) => b.id)).toEqual(['example-mcp-beta', 'example-mcp-gamma']);
    expect(plan.deferred).toEqual([{ id: 'example-mcp-alpha', reason: 'per-category limit (2)' }]);
    // 5 tasks × (3 × 0.01 + 0.13) = USD 0.80; the no-tool baseline is paid once.
    expect(plan.batch[0]?.candidateUsd).toBeCloseTo(0.8, 6);
    expect(plan.batch[0]?.baselineUsd).toBeCloseTo(0.8, 6);
    expect(plan.batch[1]?.baselineUsd).toBe(0);
    expect(plan.estimateUsd).toBeCloseTo(2.4, 6);
    expect(plan.estimateUsd).toBeLessThanOrEqual(plan.budget.plannableUsd);
  });

  it('only judges a vendor-specific item on tasks that use its technology', async () => {
    await measure();
    await seed({
      id: 'example-skill-alpha',
      provenance: 'community',
      technologies: ['playwright', 'cypress'],
    });
    await seed({ id: 'example-mcp-beta', provenance: 'community', technologies: ['example-db'] });
    const plan = await planAutoEvals(evalDeps(), NOW);
    expect(plan.batch.map((b) => b.id)).toEqual(['example-skill-alpha']);
    expect(plan.deferred).toEqual([
      {
        id: 'example-mcp-beta',
        reason: 'needs example-db; the browser_testing tasks use playwright',
      },
    ]);
  });

  it('never plans past the weekly cap or into the total reserve', async () => {
    await seed({ id: 'example-mcp-alpha', provenance: 'community' });
    // Weekly eval share USD 17, but only USD 6 of the total cap is left (reserve USD 5).
    await t.db.insert(budgetLedger).values({
      weekStart: '2026-09-07',
      purpose: 'eval',
      model: 'claude-haiku-5-5',
      costUsd: 34,
    });
    const plan = await planAutoEvals(evalDeps(), NOW);
    expect(plan.budget.plannableUsd).toBeCloseTo(0.9, 6);
    expect(plan.batch).toEqual([]);
    expect(plan.deferred[0]?.reason).toMatch(/^budget/);
  });

  it('logs the plan before spending, needs --confirm-spend when manual, and runs when scheduled', async () => {
    await seed({ id: 'example-mcp-alpha', provenance: 'community' });
    await measure();
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push('execute');
      return { status: 'queued' as const, reason: 'test', runs: [] };
    });
    const onPlan = async () => {
      order.push('plan');
    };
    await expect(
      runAutoEvals(evalDeps(), { trigger: 'manual', execute, onPlan, now: NOW }),
    ).rejects.toThrow(/--confirm-spend/);
    expect(execute).not.toHaveBeenCalled();
    order.length = 0;
    const dry = await runAutoEvals(evalDeps(), {
      trigger: 'manual',
      dryRun: true,
      execute,
      onPlan,
      now: NOW,
    });
    expect(dry.results).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    order.length = 0;
    const run = await runAutoEvals(evalDeps(), { trigger: 'scheduled', execute, onPlan, now: NOW });
    expect(order).toEqual(['plan', 'execute']);
    expect(run.results).toHaveLength(1);
  });
});

describe('policy-v2 on a database', () => {
  it('moves a failing owner approval back to candidate, audited as superseded', async () => {
    await seed({ id: 'example-mcp-alpha', lastCommitDays: 120 });
    await transitionStatus(
      t.db,
      'example-mcp-alpha',
      'recommended_provisional',
      'human:owner',
      'early approval',
    );
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    expect((await lastEvent('example-mcp-alpha'))?.reason).toMatch(
      /^owner approval superseded by policy: maintained: last commit 120 day/,
    );
  });

  it('blocks with a recorded cause, then lifts it once a newer version is clean', async () => {
    await seed({
      id: 'example-mcp-alpha',
      findings: [
        { severity: 'high', rule: 'vulnerable_dependency', description: 'CVE in dep' } as never,
      ],
    });
    await t.db
      .update(catalogItems)
      .set({ status: 'recommended_provisional' })
      .where(eq(catalogItems.id, 'example-mcp-alpha'));
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('blocked');
    // A newer version gets gated clean.
    await t.db.update(itemVersions).set({ pinned: false });
    await t.db
      .insert(itemVersions)
      .values({ itemId: 'example-mcp-alpha', version: '1.0.1', pinned: true });
    await t.db.insert(scorecards).values({
      itemId: 'example-mcp-alpha',
      version: '1.0.1',
      gateResults: PASS,
      securityFindings: [],
      confidence: 'high',
    });
    const report = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(report.outcomes[0]?.decision.action).toBe('lift');
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    const [row] = await t.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, 'example-mcp-alpha'));
    expect(row?.blockedVersions).toEqual(['1.0.0']);
    // Lifted items go back to candidate only; a later run may approve them on their merits.
    expect((await lastEvent('example-mcp-alpha'))?.actor).toBe('policy:policy-test');
  });

  it('locks the org of an item blocked for injection out of auto-approval', async () => {
    await seed({ id: 'example-mcp-alpha' });
    await seed({ id: 'example-mcp-beta' });
    await transitionStatus(
      t.db,
      'example-mcp-beta',
      'blocked',
      'system',
      'gate 3: confirmed prompt injection',
      {
        block: { cause: 'injection', findings: [] },
      },
    );
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await statusOf('example-mcp-alpha')).toBe('candidate');
    const decision = (await t.db.select().from(policyDecisions)).find(
      (d) => d.itemId === 'example-mcp-alpha',
    );
    expect(decision?.criteria.find((c) => !c.ok)).toMatchObject({ id: 'org_not_locked' });
  });
});

describe('M10 safeguards against false-block cascades', () => {
  const ownerApprove = (id: string) =>
    transitionStatus(t.db, id, 'recommended_provisional', 'human:owner', 'owner approval');
  const status = async (id: string) =>
    (await t.db.select().from(catalogItems).where(eq(catalogItems.id, id)))[0]?.status;
  const blockForInjection = (id: string, cause: 'injection' | 'suspected_injection') =>
    transitionStatus(t.db, id, 'blocked', 'system', `gate 3: ${cause}`, {
      block: { cause, findings: ['Instruction aimed at the model in SKILL.md'] },
    });

  it('never locks a vendor org automatically; it flags it instead (b, the 2026-10-20 incident)', async () => {
    // Two owner approvals and a newly blocked item, all from one org: today's shape.
    for (const id of ['example-mcp-alpha', 'example-mcp-beta', 'example-mcp-gamma'])
      await seed({ id });
    await ownerApprove('example-mcp-alpha');
    await ownerApprove('example-mcp-beta');
    await blockForInjection('example-mcp-gamma', 'injection');

    // Without the vendor exemption the block locks the org and demotes both approvals.
    const before = await runPolicy(
      { ...deps().deps, vendorOrgs: new Set<string>() },
      { apply: false, secondOpinions: false, now: NOW },
    );
    expect(
      before.outcomes.filter((o) => o.decision.action === 'demote').map((o) => o.decision.reason),
    ).toEqual([
      expect.stringContaining('org_not_locked'),
      expect.stringContaining('org_not_locked'),
    ]);

    // With it: nothing is demoted, and the would-be lock is a flag for the digest.
    const vendorOrgs = new Set(['example-org']);
    const after = await runPolicy(
      { ...deps().deps, vendorOrgs },
      { apply: true, secondOpinions: false, now: NOW },
    );
    expect(after.outcomes.filter((o) => o.decision.action === 'demote')).toEqual([]);
    expect(await status('example-mcp-alpha')).toBe('recommended_provisional');
    const { locks, vendorFlags } = await orgLocks(t.db, vendorOrgs);
    expect(locks.size).toBe(0);
    expect(vendorFlags).toEqual([
      { org: 'example-org', itemId: 'example-mcp-gamma', cause: 'injection' },
    ]);
    const md = renderDigestMarkdown(
      { ...(await buildDigest(t.db, isoWeekStart(new Date()))), orgLockFlags: vendorFlags },
      'http://127.0.0.1:4400',
    );
    expect(md).toContain('## Org-lock flags: vendor orgs (1)');
    expect(md).toContain('`example-org`');
  });

  it('a suspected injection locks no org, blocks no version, and is lifted after a clean re-check (a)', async () => {
    await seed({ id: 'example-mcp-alpha' });
    await seed({ id: 'example-mcp-beta' });
    await ownerApprove('example-mcp-beta');
    await blockForInjection('example-mcp-alpha', 'suspected_injection');
    const [row] = await t.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, 'example-mcp-alpha'));
    expect(row?.blockedVersions).toEqual([]);
    expect((await orgLocks(t.db, new Set())).locks.size).toBe(0);

    // Not re-checked since the block: it stays blocked.
    const waiting = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(waiting.outcomes.find((o) => o.id === 'example-mcp-alpha')?.decision.reason).toMatch(
      /waiting for a gate 3 re-check/,
    );
    // A clean gate 3 re-check after the block: the policy lifts it.
    const later = new Date(Date.now() + 60_000).toISOString();
    await t.db
      .update(scorecards)
      .set({
        gateResults: { ...PASS, gate3_security: { ...PASS.gate3_security!, checkedAt: later } },
      })
      .where(eq(scorecards.itemId, 'example-mcp-alpha'));
    const lifted = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(lifted.outcomes.find((o) => o.id === 'example-mcp-alpha')).toMatchObject({
      decision: { action: 'lift', to: 'candidate' },
      applied: true,
    });
    expect(await status('example-mcp-beta')).toBe('recommended_provisional');
  });

  it('holds more than 3 demotions of approved items in one run, and applies 3 (d)', async () => {
    const ids = ['example-mcp-a', 'example-mcp-b', 'example-mcp-c', 'example-mcp-d'];
    for (const id of ids) {
      // Unmaintained: each owner approval is superseded by the policy.
      await seed({ id, lastCommitDays: 120 });
      await ownerApprove(id);
    }
    const report = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(report.outcomes.filter((o) => o.held === 'mass_demotion')).toHaveLength(4);
    for (const id of ids) expect(await status(id)).toBe('recommended_provisional');
    expect(await t.db.select().from(heldChanges)).toHaveLength(4);
    expect(formatPolicyReport(report, true)).toContain('HELD FOR THE OWNER: 4');

    // A second run holds the same changes again, without duplicates.
    await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(await t.db.select().from(heldChanges)).toHaveLength(4);

    // The owner applies one and dismisses another; a moved item can't be applied blindly.
    const [h1, h2, h3] = await t.db.select().from(heldChanges).orderBy(heldChanges.id);
    await resolveHeldChange(t.db, h1!.id, 'apply', 'human:owner');
    expect(await status(h1!.itemId)).toBe('candidate');
    const [event] = (
      await t.db.select().from(statusEvents).where(eq(statusEvents.itemId, h1!.itemId))
    ).slice(-1);
    expect(event).toMatchObject({ actor: 'policy:policy-test' });
    expect(event?.reason).toMatch(/held: mass_demotion; applied by human:owner/);
    await resolveHeldChange(t.db, h2!.id, 'dismiss', 'human:owner');
    await transitionStatus(t.db, h3!.itemId, 'watchlist', 'human:owner', 'moved by hand');
    await expect(resolveHeldChange(t.db, h3!.id, 'apply', 'human:owner')).rejects.toThrow(
      /now watchlist/,
    );
    await expect(resolveHeldChange(t.db, h2!.id, 'apply', 'human:owner')).rejects.toThrow(
      /already dismissed/,
    );
    await expect(resolveHeldChange(t.db, h3!.id, 'apply', 'policy:x' as never)).rejects.toThrow(
      /only the owner/,
    );
  });

  it('applies up to 3 demotions of approved items at once', async () => {
    for (const id of ['example-mcp-a', 'example-mcp-b', 'example-mcp-c']) {
      await seed({ id, lastCommitDays: 120 });
      await ownerApprove(id);
    }
    const report = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(report.outcomes.filter((o) => o.applied && o.decision.action === 'demote')).toHaveLength(
      3,
    );
    expect(await t.db.select().from(heldChanges)).toEqual([]);
  });

  it('holds demotions from a changed policy until a clean run or the owner accepts it (c)', async () => {
    await seed({ id: 'example-mcp-alpha', lastCommitDays: 60 });
    await ownerApprove('example-mcp-alpha');
    const base = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(base.outcomes.filter((o) => o.decision.action === 'demote')).toEqual([]);

    // A stricter maintenance rule would now demote the approval: it is held, not applied.
    const stricter = { ...policy, max_days_since_commit: 30 };
    const changed = await runPolicy(
      { ...deps().deps, policy: stricter },
      { apply: true, secondOpinions: false, now: NOW },
    );
    expect(changed.outcomes.find((o) => o.id === 'example-mcp-alpha')?.held).toBe('policy_change');
    expect(changed.acceptedNow).toEqual([]);
    expect(await status('example-mcp-alpha')).toBe('recommended_provisional');
    expect(formatPolicyReport(changed, true)).toMatch(
      /policy policy-test#\w{8} is not accepted yet/,
    );

    // A change that demotes nothing takes effect on its own after the clean run.
    const harmless = { ...policy, promotion: { min_days_provisional: 61 } };
    const clean = await runPolicy(
      { ...deps().deps, policy: harmless },
      { apply: true, secondOpinions: false, now: NOW },
    );
    expect(clean.acceptedNow).toEqual(['policy']);
  });

  it('holds demotions that rest on findings of an unaccepted scanner version (c)', async () => {
    await seed({
      id: 'example-mcp-alpha',
      findings: [{ severity: 'high', description: 'new finding from a newer scanner' }],
    });
    // An approved item whose latest re-check, by a newer scanner, found a new high finding.
    await t.db
      .update(catalogItems)
      .set({ status: 'recommended_provisional' })
      .where(eq(catalogItems.id, 'example-mcp-alpha'));
    await t.db.update(scorecards).set({ scannerVersion: 'scanner-v2' });
    const held = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(held.outcomes.find((o) => o.id === 'example-mcp-alpha')).toMatchObject({
      decision: { action: 'demote', to: 'blocked' },
      held: 'scanner_change',
      applied: false,
    });
    await acceptVersion(t.db, 'scanner', 'scanner-v2', 'human:owner');
    const applied = await runPolicy(deps().deps, { apply: true, secondOpinions: false, now: NOW });
    expect(applied.outcomes.find((o) => o.id === 'example-mcp-alpha')?.applied).toBe(true);
    expect(await status('example-mcp-alpha')).toBe('blocked');
  });
});
