import { describe, expect, it } from 'vitest';
import type { EvalSummary, GateResults } from './catalog.js';
import {
  approvalCriteria,
  approvalPolicySchema,
  decide,
  evalNeed,
  type ApprovalPolicy,
  type PolicyFacts,
} from './policy.js';

const policy: ApprovalPolicy = approvalPolicySchema.parse({
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
  auto_evals: { cron: '0 6 * * 1', per_category: 3, total_reserve_usd: 5, headroom: 0.9 },
});

const NOW = '2026-10-20T00:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const gate = (result: 'pass' | 'soft_fail' | 'fail' | 'not_run', notes?: string) => ({
  result,
  evidence: [],
  checkedAt: NOW,
  ...(notes ? { notes } : {}),
});
const allPass: GateResults = {
  gate0_hygiene: gate('pass'),
  gate1_provenance: gate('pass'),
  gate2_health: gate('pass'),
  gate3_security: gate('pass'),
};
const summary = (over: Partial<EvalSummary> = {}): EvalSummary => ({
  taskSetVersion: 'browser_testing-v1-x',
  model: 'claude-haiku-5-5',
  claudeCodeVersion: '2.1.303',
  baselineItemId: null,
  runs: 15,
  successRate: 0.8,
  baselineSuccessRate: 0.4,
  meanTokens: 1000,
  meanCostUsd: 0.01,
  meanWallSeconds: 60,
  contextOverheadTokens: 100,
  verdict: 'better',
  ...over,
});

/** An official-vendor candidate that meets every approval criterion. */
const base = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  id: 'example-mcp-alpha',
  status: 'candidate',
  kind: 'mcp_server',
  category: 'browser_testing',
  provenance: 'official_vendor',
  install: { method: 'npx', package: 'example-mcp-alpha', version: '1.2.3', envVars: [] },
  pinnedVersion: '1.2.3',
  gates: allPass,
  findings: [],
  lastCommitAt: daysAgo(10),
  relevant: true,
  stacks: ['any'],
  outOfScope: [],
  agreement: { agreed: true, needsSecondOpinion: false, detail: 'models agree' },
  evalSummary: null,
  incumbentId: null,
  approvedAt: null,
  approvedBy: null,
  veto: null,
  acknowledgedFindings: [],
  now: NOW,
  ...over,
});

const failedIds = (f: PolicyFacts) =>
  approvalCriteria(f, policy)
    .criteria.filter((c) => !c.ok)
    .map((c) => c.id);

describe('approval (FR-P2, FR-P3, FR-P5)', () => {
  it('approves an official-vendor item that meets every criterion', () => {
    const d = decide(base(), policy);
    expect(d).toMatchObject({
      action: 'approve',
      to: 'recommended_provisional',
      tier: 'official_vendor',
    });
    expect(d.action === 'approve' && d.reason).toContain('all criteria hold');
  });

  it('treats Anthropic as the official-vendor tier', () => {
    expect(decide(base({ provenance: 'anthropic' }), policy).action).toBe('approve');
  });

  it('approves from watchlist too', () => {
    expect(decide(base({ status: 'watchlist' }), policy).action).toBe('approve');
  });

  it.each([
    [
      'a soft-failed gate',
      { gates: { ...allPass, gate0_hygiene: gate('soft_fail') } },
      'gates_pass',
    ],
    ['an ungated item', { gates: null }, 'gates_pass'],
    ['gate 3 not run', { gates: { ...allPass, gate3_security: gate('not_run') } }, 'gates_pass'],
    [
      'a security flag',
      { findings: [{ severity: 'high' as const, description: 'vulnerable dependency' }] },
      'no_security_flags',
    ],
    [
      'a category without agreement',
      { agreement: { agreed: false, needsSecondOpinion: false, detail: 'models disagree' } },
      'category_agreed',
    ],
    ['an old last commit', { lastCommitAt: daysAgo(91) }, 'maintained'],
    ['an unknown last commit', { lastCommitAt: null }, 'maintained'],
    [
      'a manual install',
      { install: { method: 'manual' as const, url: 'https://example.test/x', envVars: [] } },
      'install_known',
    ],
    ['no install details', { install: null }, 'install_known'],
    ['no pinned version', { pinnedVersion: null }, 'install_known'],
    ['an install method that does not fit the kind', { kind: 'plugin' as const }, 'install_known'],
    ['a subagent (no automatic install)', { kind: 'subagent' as const }, 'install_known'],
    ['an irrelevant item', { relevant: false }, 'stack_fit'],
    ['a Python-only item', { stacks: ['python'] }, 'stack_fit'],
    ['an out-of-scope item', { outOfScope: ['nextjs'] }, 'stack_fit'],
    ['a losing eval', { evalSummary: summary({ verdict: 'worse' }) }, 'no_losing_eval'],
    ['a veto', { veto: { by: 'human:owner', reason: 'no', at: NOW } }, 'not_vetoed'],
  ] as const)('refuses %s', (_label, over, criterion) => {
    const f = base(over as Partial<PolicyFacts>);
    const d = decide(f, policy);
    expect(d.action).toBe('hold');
    expect(failedIds(f)).toContain(criterion);
  });

  it('never approves a security-flagged item, even when everything else holds', () => {
    const f = base({
      gates: { ...allPass, gate3_security: gate('fail') },
      findings: [{ severity: 'critical', description: 'prompt injection' }],
    });
    expect(decide(f, policy).action).toBe('hold');
  });

  it('requires a winning eval for the community tier', () => {
    expect(failedIds(base({ provenance: 'community' }))).toEqual(['eval_beats_incumbent']);
    expect(
      decide(base({ provenance: 'community', evalSummary: summary({ verdict: 'equal' }) }), policy)
        .action,
    ).toBe('hold');
    expect(decide(base({ provenance: 'community', evalSummary: summary() }), policy).action).toBe(
      'approve',
    );
  });

  it('ignores a community eval run against a different incumbent', () => {
    const f = base({
      provenance: 'community',
      incumbentId: 'example-skill-beta',
      evalSummary: summary({ baselineItemId: null }),
    });
    expect(decide(f, policy).action).toBe('hold');
    expect(evalNeed(f, policy).worth).toBe(true);
  });

  it('asks for a second opinion only when it is the one missing piece', () => {
    const pending = { agreed: false, needsSecondOpinion: true, detail: 'second opinion pending' };
    expect(decide(base({ agreement: pending }), policy)).toMatchObject({
      action: 'hold',
      needsSecondOpinion: true,
    });
    expect(decide(base({ agreement: pending, lastCommitAt: daysAgo(200) }), policy)).toMatchObject({
      needsSecondOpinion: false,
    });
    // Community items get their eval first, then the second opinion.
    expect(decide(base({ agreement: pending, provenance: 'community' }), policy)).toMatchObject({
      needsSecondOpinion: false,
    });
  });
});

describe('promotion (FR-P4)', () => {
  const provisional = (over: Partial<PolicyFacts> = {}) =>
    base({
      status: 'recommended_provisional',
      approvedAt: daysAgo(61),
      approvedBy: 'policy:policy-v1',
      evalSummary: summary(),
      ...over,
    });

  it('promotes after a passing eval and 60 days provisional', () => {
    expect(decide(provisional(), policy)).toMatchObject({ action: 'promote', to: 'recommended' });
  });

  it('waits for 60 days', () => {
    const d = decide(provisional({ approvedAt: daysAgo(59) }), policy);
    expect(d).toMatchObject({ action: 'hold' });
    expect(d.reason).toContain('59 of 60 day(s)');
  });

  it('needs a passing eval', () => {
    expect(decide(provisional({ evalSummary: null }), policy).action).toBe('hold');
    expect(
      decide(provisional({ evalSummary: summary({ verdict: 'inconclusive' }) }), policy).action,
    ).toBe('hold');
  });

  it('counts "equal" only against a real incumbent, not against no tool', () => {
    expect(decide(provisional({ evalSummary: summary({ verdict: 'equal' }) }), policy).action).toBe(
      'hold',
    );
    expect(
      decide(
        provisional({
          incumbentId: 'example-skill-beta',
          evalSummary: summary({ verdict: 'equal', baselineItemId: 'example-skill-beta' }),
        }),
        policy,
      ).action,
    ).toBe('promote');
  });

  it('does not promote an owner-approved item that fails the approval criteria', () => {
    expect(
      decide(
        provisional({
          approvedBy: 'human:owner',
          category: null,
          agreement: { agreed: false, needsSecondOpinion: false, detail: 'no category' },
        }),
        policy,
      ).action,
    ).toBe('hold');
  });

  it('keeps recommended items as they are without a trigger', () => {
    expect(
      decide(base({ status: 'recommended', approvedBy: 'policy:policy-v1' }), policy).action,
    ).toBe('hold');
  });
});

describe('demotion (FR-P6)', () => {
  const approved = (over: Partial<PolicyFacts> = {}) =>
    base({
      status: 'recommended_provisional',
      approvedAt: daysAgo(5),
      approvedBy: 'policy:policy-v1',
      ...over,
    });

  it('blocks on a new security finding', () => {
    expect(
      decide(
        approved({ findings: [{ severity: 'high', description: 'CVE-0000-0001 in dep' }] }),
        policy,
      ),
    ).toMatchObject({ action: 'demote', to: 'blocked', trigger: 'security_finding' });
  });

  it('ignores findings the owner acknowledged with an override note, but not new ones', () => {
    const findings = [{ severity: 'high' as const, description: 'known finding' }];
    expect(
      decide(
        approved({ approvedBy: 'human:owner', findings, acknowledgedFindings: ['known finding'] }),
        policy,
      ).action,
    ).toBe('hold');
    expect(
      decide(
        approved({
          approvedBy: 'human:owner',
          findings: [...findings, { severity: 'critical', description: 'new finding' }],
          acknowledgedFindings: ['known finding'],
        }),
        policy,
      ),
    ).toMatchObject({ to: 'blocked' });
  });

  it('moves to watchlist when install or start fails in a re-check', () => {
    expect(
      decide(
        approved({ gates: { ...allPass, gate0_hygiene: gate('fail', 'did not install') } }),
        policy,
      ),
    ).toMatchObject({ action: 'demote', to: 'watchlist', trigger: 'install_or_start_failed' });
    // A policy approval relied on a clean start; losing it is enough.
    expect(
      decide(
        approved({ gates: { ...allPass, gate0_hygiene: gate('soft_fail', 'start not verified') } }),
        policy,
      ),
    ).toMatchObject({ to: 'watchlist' });
    // An owner approval of a soft-failed item stays valid.
    expect(
      decide(
        approved({
          approvedBy: 'human:owner',
          gates: { ...allPass, gate0_hygiene: gate('soft_fail') },
        }),
        policy,
      ).action,
    ).toBe('hold');
  });

  it('moves to watchlist after 180 days without a commit', () => {
    expect(decide(approved({ lastCommitAt: daysAgo(181) }), policy)).toMatchObject({
      to: 'watchlist',
      trigger: 'abandoned',
    });
    expect(decide(approved({ lastCommitAt: daysAgo(179) }), policy).action).toBe('hold');
  });

  it('goes back to candidate after an eval regression', () => {
    expect(decide(approved({ evalSummary: summary({ verdict: 'worse' }) }), policy)).toMatchObject({
      to: 'candidate',
      trigger: 'eval_regression',
    });
  });

  it('demotes a vetoed item first', () => {
    expect(
      decide(
        approved({
          veto: { by: 'human:owner', reason: 'misleading', at: NOW },
          findings: [{ severity: 'high', description: 'x' }],
        }),
        policy,
      ),
    ).toMatchObject({ to: 'candidate', trigger: 'owner_veto' });
  });

  it('applies to recommended items as well, and never to candidates', () => {
    expect(
      decide(approved({ status: 'recommended', lastCommitAt: daysAgo(400) }), policy),
    ).toMatchObject({ action: 'demote' });
    expect(decide(base({ lastCommitAt: daysAgo(400) }), policy).action).toBe('hold');
  });
});

describe('evalNeed (FR-P7)', () => {
  it('is worth it when the eval is the missing evidence', () => {
    expect(evalNeed(base({ provenance: 'community' }), policy).worth).toBe(true);
    expect(
      evalNeed(
        base({
          provenance: 'community',
          agreement: { agreed: false, needsSecondOpinion: true, detail: 'pending' },
        }),
        policy,
      ).worth,
    ).toBe(true);
  });

  it('is not worth it when another criterion fails or the eval is current', () => {
    expect(
      evalNeed(base({ provenance: 'community', lastCommitAt: daysAgo(100) }), policy),
    ).toMatchObject({ worth: false });
    expect(evalNeed(base({ evalSummary: summary() }), policy)).toMatchObject({
      worth: false,
      reason: 'eval is current',
    });
    expect(evalNeed(base({ status: 'recommended' }), policy).worth).toBe(false);
  });

  it('covers provisional items waiting for a promotion eval', () => {
    expect(evalNeed(base({ status: 'recommended_provisional' }), policy).worth).toBe(true);
  });
});
