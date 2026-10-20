import { z } from 'zod';
import type { Agreement } from './category-rules.js';
import {
  CLEARING_VERDICTS,
  gateIdSchema,
  isNextjsRelevant,
  type EvalSummary,
  type GateId,
  type GateResults,
  type Install,
  type SecurityFinding,
} from './catalog.js';
import {
  kindSchema,
  provenanceSchema,
  type Category,
  type Kind,
  type Provenance,
  type Status,
} from './enums.js';
import { isHumanActor, isPolicyActor } from './status.js';

/**
 * The approval policy (PRD 9.2a), versioned, in `catalog/policy.yaml`. Every number the rules use
 * lives here, so a policy change is a reviewed file change with a new version.
 */
export const approvalPolicySchema = z.object({
  version: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, 'version: lowercase slug'),
  /** Provenances in the official-vendor tier (vendors from catalog/vendors.yaml, via gate 1). */
  vendor_tier_provenances: z.array(provenanceSchema).min(1),
  /** Gates that must pass (not soft-fail) for approval. */
  required_gates: z.array(gateIdSchema).min(1),
  /** Healthy maintenance: a commit within this many days (FR-P2). */
  max_days_since_commit: z.number().int().positive(),
  /** Stacks an item must fit (at least one). */
  supported_stacks: z.array(z.string().min(1)).min(1),
  /** Install methods that count as real install details, per kind. Other kinds never qualify. */
  install_methods: z.partialRecord(
    kindSchema,
    z.array(z.enum(['npx', 'uvx', 'docker', 'remote', 'plugin', 'skill_copy', 'manual'])),
  ),
  promotion: z.object({ min_days_provisional: z.number().int().nonnegative() }),
  demotion: z.object({
    abandoned_days: z.number().int().positive(),
    /**
     * More demotions of approved items than this in one run are held for the owner instead of
     * applied (M10 safeguard d): a mass demotion is more likely a bug than a real event.
     */
    max_auto_demotions: z.number().int().min(0).default(3),
  }),
  auto_evals: z.object({
    /** pg-boss cron (UTC) for the weekly scheduled eval batch. */
    cron: z.string().min(1),
    /** Most promising eval-ready candidates per category per week. */
    per_category: z.number().int().min(0),
    /** USD of the total budget the scheduled batch never touches (kept for classification). */
    total_reserve_usd: z.number().nonnegative(),
    /** Fraction of the remaining budget a batch may plan, leaving room for cost variance. */
    headroom: z.number().gt(0).max(1),
  }),
});
export type ApprovalPolicy = z.output<typeof approvalPolicySchema>;

/** Severities that count as a security flag (gate 3 fails on them; approval needs an override). */
export const FLAG_SEVERITIES: ReadonlySet<SecurityFinding['severity']> = new Set([
  'high',
  'critical',
]);

/** Everything the policy needs about one item. Gathered from the database; no network. */
export interface PolicyFacts {
  id: string;
  status: Status;
  kind: Kind | null;
  category: Category | null;
  provenance: Provenance | null;
  install: Install | null;
  /** Pinned version from item_versions (what the scorecard and evals refer to). */
  pinnedVersion: string | null;
  /** Latest scorecard for the pinned version. */
  gates: GateResults | null;
  findings: SecurityFinding[];
  lastCommitAt: string | null;
  /** Classifier stack fit inputs. */
  relevant: boolean;
  stacks: string[];
  outOfScope: string[];
  agreement: Agreement;
  /** Eval summary on the pinned version's scorecard. */
  evalSummary: EvalSummary | null;
  /** Current incumbent of the item's category, excluding the item itself; null if none. */
  incumbentId: string | null;
  /** When the item last entered its current recommended status, and who approved it. */
  approvedAt: string | null;
  approvedBy: string | null;
  veto: { by: string; reason: string; at: string } | null;
  /** High/critical findings the owner accepted with an override note at approval. */
  acknowledgedFindings: string[];
  /** Why and at which version the item was last blocked (null when not blocked). */
  blockRecord: BlockRecord | null;
  /** Versions that stay blocked for good, even after a lift (PRD FR-P10). */
  blockedVersions: string[];
  /** Set when the author's org has an item blocked for injection or exfiltration. */
  orgLock: string | null;
  now: string;
}

export type CriterionId =
  | 'not_vetoed'
  | 'org_not_locked'
  | 'gates_pass'
  | 'no_security_flags'
  | 'category_agreed'
  | 'maintained'
  | 'install_known'
  | 'stack_fit'
  | 'no_losing_eval'
  | 'eval_beats_incumbent'
  | 'eval_passing'
  | 'provisional_days';

export interface Criterion {
  id: CriterionId;
  ok: boolean;
  detail: string;
}

export type Tier = 'official_vendor' | 'community';

export type DemotionTrigger =
  | 'owner_veto'
  | 'security_finding'
  | 'install_or_start_failed'
  | 'abandoned'
  | 'eval_regression'
  | 'owner_approval_superseded'
  | 'security_scan_incomplete';

export type PolicyDecision =
  | {
      action: 'demote';
      to: Status;
      trigger: DemotionTrigger;
      reason: string;
      /** For blocks: the cause and the findings, recorded on the item (PRD FR-P10). */
      block?: { cause: BlockCause; findings: string[] };
    }
  | { action: 'lift'; to: 'candidate'; reason: string }
  | {
      action: 'approve';
      to: 'recommended_provisional';
      tier: Tier;
      criteria: Criterion[];
      reason: string;
    }
  | { action: 'promote'; to: 'recommended'; tier: Tier; criteria: Criterion[]; reason: string }
  | {
      action: 'hold';
      tier: Tier | null;
      criteria: Criterion[];
      /** Only the strong-model second opinion is missing for approval or promotion. */
      needsSecondOpinion: boolean;
      reason: string;
    };

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;

export function tierOf(f: Pick<PolicyFacts, 'provenance'>, p: ApprovalPolicy): Tier {
  return f.provenance && p.vendor_tier_provenances.includes(f.provenance)
    ? 'official_vendor'
    : 'community';
}

/** High/critical findings not acknowledged by an owner override. */
export function newFlags(f: Pick<PolicyFacts, 'findings' | 'acknowledgedFindings'>): string[] {
  return f.findings
    .filter((x) => FLAG_SEVERITIES.has(x.severity))
    .map((x) => x.description)
    .filter((d) => !f.acknowledgedFindings.includes(d));
}

/** Install details a user can actually run, pinned, and matching the item's kind (FR-P2, FR-P5). */
export function installCheck(
  f: Pick<PolicyFacts, 'kind' | 'install' | 'pinnedVersion'> & { blockedVersions?: string[] },
  p: ApprovalPolicy,
): Criterion {
  const bad = (detail: string): Criterion => ({ id: 'install_known', ok: false, detail });
  const i = f.install;
  if (!f.kind) return bad('no kind');
  if (!i) return bad('install method unknown');
  if (i.method === 'manual') return bad('install method unknown (manual steps only)');
  const allowed = p.install_methods[f.kind] ?? [];
  if (!allowed.includes(i.method))
    return bad(`install method ${i.method} does not fit kind ${f.kind}`);
  if (!f.pinnedVersion) return bad('no pinned version');
  if (f.blockedVersions?.includes(f.pinnedVersion))
    return bad(`pinned version ${f.pinnedVersion} is blocked`);
  if ((i.method === 'npx' || i.method === 'uvx') && !(i.package && i.version))
    return bad(`${i.method} install without an exact package version`);
  if (i.method === 'remote' && !i.url?.startsWith('https://'))
    return bad('remote install without an https URL');
  if (i.method === 'plugin' && !i.plugin) return bad('plugin install without a marketplace entry');
  if (i.method === 'skill_copy' && !i.url) return bad('skill install without a source folder');
  const what =
    i.method === 'npx' || i.method === 'uvx'
      ? `${i.method} ${i.package}@${i.version}`
      : i.method === 'plugin'
        ? `plugin ${i.plugin?.name}@${i.plugin?.marketplace}`
        : `${i.method} ${i.url}`;
  return { id: 'install_known', ok: true, detail: `${what} (pinned ${f.pinnedVersion})` };
}

/** Did the eval on the pinned version beat the current incumbent (or no tool)? */
function evalAgainstIncumbent(f: PolicyFacts): {
  current: boolean;
  verdict: EvalSummary['verdict'] | null;
  detail: string;
} {
  const s = f.evalSummary;
  if (!s) return { current: false, verdict: null, detail: 'no eval yet' };
  const against = s.baselineItemId ?? 'no tool';
  const now = f.incumbentId ?? 'no tool';
  const rates = `${Math.round(s.successRate * 100)}% vs ${s.baselineSuccessRate === null ? 'n/a' : `${Math.round(s.baselineSuccessRate * 100)}%`}`;
  if (s.baselineItemId !== f.incumbentId)
    return {
      current: false,
      verdict: s.verdict,
      detail: `eval ${s.verdict} against ${against}, but the incumbent is now ${now}`,
    };
  return {
    current: true,
    verdict: s.verdict,
    detail: `${s.verdict} than ${against} (${rates}, ${s.model}, task set ${s.taskSetVersion})`,
  };
}

/** The approval criteria for the item's tier (FR-P2, FR-P3). All must hold. */
export function approvalCriteria(
  f: PolicyFacts,
  p: ApprovalPolicy,
): { tier: Tier; criteria: Criterion[] } {
  const tier = tierOf(f, p);
  const gates = p.required_gates.map(
    (g: GateId) => [g, f.gates?.[g]?.result ?? 'not run'] as const,
  );
  const failing = gates.filter(([, r]) => r !== 'pass');
  const flags = f.findings.filter((x) => FLAG_SEVERITIES.has(x.severity));
  const commitAge = f.lastCommitAt ? daysBetween(f.lastCommitAt, f.now) : null;
  const fits =
    isNextjsRelevant({ relevant: f.relevant, stacks: f.stacks }) &&
    p.supported_stacks.some((s) => !f.outOfScope.includes(s));
  const ev = evalAgainstIncumbent(f);
  const criteria: Criterion[] = [
    {
      id: 'not_vetoed',
      ok: f.veto === null,
      detail: f.veto ? `vetoed by ${f.veto.by}: ${f.veto.reason}` : 'no veto',
    },
    {
      id: 'org_not_locked',
      ok: f.orgLock === null,
      detail: f.orgLock ?? 'author org has no injection or exfiltration block',
    },
    {
      id: 'gates_pass',
      ok: f.gates !== null && failing.length === 0,
      detail:
        f.gates === null
          ? 'not gated'
          : failing.length === 0
            ? `gates ${gates.map(([g]) => g.slice(4, 5)).join(', ')} pass`
            : failing.map(([g, r]) => `${g}: ${r}`).join('; '),
    },
    {
      id: 'no_security_flags',
      ok: flags.length === 0 && f.gates?.gate3_security?.result !== 'fail',
      detail:
        flags.length === 0
          ? 'no high or critical findings'
          : `${flags.length} high/critical finding(s): ${flags
              .slice(0, 3)
              .map((x) => x.description)
              .join('; ')}`,
    },
    { id: 'category_agreed', ok: f.agreement.agreed, detail: f.agreement.detail },
    {
      id: 'maintained',
      ok: commitAge !== null && commitAge <= p.max_days_since_commit,
      detail:
        commitAge === null
          ? 'last commit unknown'
          : `last commit ${Math.floor(commitAge)} day(s) ago (limit ${p.max_days_since_commit})`,
    },
    installCheck(f, p),
    {
      id: 'stack_fit',
      ok: fits,
      detail: fits
        ? `fits ${p.supported_stacks.join(', ')} (stacks: ${f.stacks.join(', ')})`
        : f.outOfScope.length > 0
          ? `out of scope for ${f.outOfScope.join(', ')}`
          : `no supported stack (relevant: ${String(f.relevant)}, stacks: ${f.stacks.join(', ') || 'none'})`,
    },
    {
      id: 'no_losing_eval',
      ok: f.evalSummary?.verdict !== 'worse',
      detail: f.evalSummary?.verdict === 'worse' ? `lost its eval: ${ev.detail}` : 'no losing eval',
    },
  ];
  if (tier === 'community')
    criteria.push({
      id: 'eval_beats_incumbent',
      ok: ev.current && ev.verdict === 'better',
      detail: ev.detail,
    });
  return { tier, criteria };
}

const failed = (criteria: Criterion[]) => criteria.filter((c) => !c.ok);
const summarise = (criteria: Criterion[]) => criteria.map((c) => `${c.id}: ${c.detail}`).join('; ');

/** Automatic demotion of an approved item (FR-P6), most serious trigger first. */
export function demotionFor(
  f: PolicyFacts,
  p: ApprovalPolicy,
): Extract<PolicyDecision, { action: 'demote' }> | null {
  if (f.status !== 'recommended' && f.status !== 'recommended_provisional') return null;
  if (f.veto)
    return {
      action: 'demote',
      to: 'candidate',
      trigger: 'owner_veto',
      reason: `owner veto by ${f.veto.by}: ${f.veto.reason}`,
    };
  const flags = newFlags(f);
  if (flags.length > 0) {
    const flagged = f.findings.filter((x) => flags.includes(x.description));
    const cause = blockCause(flagged);
    return {
      action: 'demote',
      to: 'blocked',
      trigger: 'security_finding',
      reason: `new security finding(s) (${cause.replace('_', ' ')}): ${flags.slice(0, 3).join('; ')}`,
      block: { cause, findings: flags },
    };
  }
  const g0 = f.gates?.gate0_hygiene;
  if (
    g0?.result === 'fail' ||
    (f.approvedBy && isPolicyActor(f.approvedBy) && g0 && g0.result !== 'pass')
  )
    return {
      action: 'demote',
      to: 'watchlist',
      trigger: 'install_or_start_failed',
      reason: `re-check: install or start no longer verified (gate 0 ${g0.result}${g0.notes ? `: ${g0.notes}` : ''})`,
    };
  // A policy approval relied on gate 3 passing; if a re-check no longer passes it (for example a
  // bundled MCP server that can't be verified), the approval lapses (policy-v3).
  const g3 = f.gates?.gate3_security;
  if (f.approvedBy && isPolicyActor(f.approvedBy) && g3 && g3.result !== 'pass')
    return {
      action: 'demote',
      to: 'candidate',
      trigger: 'security_scan_incomplete',
      reason: `re-check: security gate no longer passes (gate 3 ${g3.result}${g3.notes ? `: ${g3.notes}` : ''})`,
    };
  if (f.lastCommitAt && daysBetween(f.lastCommitAt, f.now) > p.demotion.abandoned_days)
    return {
      action: 'demote',
      to: 'watchlist',
      trigger: 'abandoned',
      reason: `no commit for ${Math.floor(daysBetween(f.lastCommitAt, f.now))} days (limit ${p.demotion.abandoned_days})`,
    };
  if (f.evalSummary?.verdict === 'worse')
    return {
      action: 'demote',
      to: 'candidate',
      trigger: 'eval_regression',
      reason: `eval regression: ${evalAgainstIncumbent(f).detail}`,
    };
  return null;
}

/**
 * The policy's decision for one item (PRD 9.2a): demotions first, then promotion of provisional
 * items, then approval of candidate or watchlist items. Anything uncertain is a `hold`.
 */
export function decide(f: PolicyFacts, p: ApprovalPolicy): PolicyDecision {
  if (f.status === 'blocked') return liftFor(f, p);
  const demotion = demotionFor(f, p);
  if (demotion) return demotion;
  const { tier, criteria } = approvalCriteria(f, p);
  const missing = failed(criteria);
  const onlySecondOpinion =
    missing.length === 1 && missing[0]!.id === 'category_agreed' && f.agreement.needsSecondOpinion;

  // Owner approvals get no free pass (policy-v2): they must meet the same criteria as any item.
  const approved = f.status === 'recommended' || f.status === 'recommended_provisional';
  if (approved && f.approvedBy && isHumanActor(f.approvedBy) && missing.length > 0) {
    if (onlySecondOpinion)
      return {
        action: 'hold',
        tier,
        criteria,
        needsSecondOpinion: true,
        reason: 'owner approval re-check: second opinion pending',
      };
    return {
      action: 'demote',
      to: 'candidate',
      trigger: 'owner_approval_superseded',
      reason: `owner approval superseded by policy: ${summarise(missing)}`,
    };
  }

  if (f.status === 'candidate' || f.status === 'watchlist') {
    if (missing.length === 0)
      return {
        action: 'approve',
        to: 'recommended_provisional',
        tier,
        criteria,
        reason: `${tier === 'official_vendor' ? 'official-vendor' : 'community'} tier, all criteria hold: ${summarise(criteria)}`,
      };
    return {
      action: 'hold',
      tier,
      criteria,
      needsSecondOpinion: onlySecondOpinion,
      reason: `not approved: ${summarise(missing)}`,
    };
  }

  if (f.status === 'recommended_provisional') {
    const ev = evalAgainstIncumbent(f);
    const passing =
      ev.current && (ev.verdict === 'better' || (ev.verdict === 'equal' && f.incumbentId !== null));
    const days = f.approvedAt ? daysBetween(f.approvedAt, f.now) : 0;
    const promotion: Criterion[] = [
      ...criteria,
      { id: 'eval_passing', ok: passing, detail: ev.detail },
      {
        id: 'provisional_days',
        ok: days >= p.promotion.min_days_provisional,
        detail: `${Math.floor(days)} of ${p.promotion.min_days_provisional} day(s) provisional`,
      },
    ];
    const blockers = failed(promotion);
    if (blockers.length === 0)
      return {
        action: 'promote',
        to: 'recommended',
        tier,
        criteria: promotion,
        reason: `passing eval and ${Math.floor(days)} days provisional: ${summarise(promotion)}`,
      };
    return {
      action: 'hold',
      tier,
      criteria: promotion,
      needsSecondOpinion:
        blockers.length === 1 &&
        blockers[0]!.id === 'category_agreed' &&
        f.agreement.needsSecondOpinion,
      reason: `stays provisional: ${summarise(blockers)}`,
    };
  }

  return {
    action: 'hold',
    tier,
    criteria,
    needsSecondOpinion: false,
    reason: f.status === 'recommended' ? 'recommended; no demotion trigger' : `status ${f.status}`,
  };
}

/**
 * Is an automatic eval worth its cost for this item (FR-P7)? Only when the eval is the missing
 * piece: a candidate or watchlist item that meets every other approval criterion (a pending
 * second opinion is fine; it is asked for after the eval), or a provisional item that lacks a
 * current eval for promotion. Items with a current eval against today's incumbent are skipped.
 */
export function evalNeed(f: PolicyFacts, p: ApprovalPolicy): { worth: boolean; reason: string } {
  if (
    f.status !== 'candidate' &&
    f.status !== 'watchlist' &&
    f.status !== 'recommended_provisional'
  )
    return { worth: false, reason: `status ${f.status}` };
  if (evalAgainstIncumbent(f).current) return { worth: false, reason: 'eval is current' };
  const { criteria } = approvalCriteria(f, p);
  const blockers = criteria.filter(
    (c) =>
      !c.ok &&
      c.id !== 'eval_beats_incumbent' &&
      !(c.id === 'category_agreed' && f.agreement.needsSecondOpinion),
  );
  return blockers.length === 0
    ? { worth: true, reason: 'eval is the missing evidence' }
    : { worth: false, reason: summarise(blockers) };
}

/** Owner veto (PRD FR-P9): locks an item out of auto-approval until the owner lifts it. */
export const policyVetoSchema = z.object({
  by: z.string(),
  reason: z.string(),
  at: z.iso.datetime(),
});
export type PolicyVeto = z.infer<typeof policyVetoSchema>;

/** High/critical findings an owner accepted with an override note when approving. */
export const securityOverrideSchema = z.object({
  by: z.string(),
  note: z.string(),
  findings: z.array(z.string()),
  at: z.iso.datetime(),
});
export type SecurityOverride = z.infer<typeof securityOverrideSchema>;

/** Why an item was blocked (PRD FR-P10). Only `vulnerable_dependency` and `suspected_injection` blocks are ever lifted automatically. */
export const BLOCK_CAUSES = [
  'vulnerable_dependency',
  'injection',
  /**
   * A rule matched but no independent review confirmed it (M10 safeguard a). Never locks an org,
   * never blocks the version for good, and is lifted after a clean re-check.
   */
  'suspected_injection',
  'exfiltration',
  'other',
] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

export const blockRecordSchema = z.object({
  by: z.string(),
  cause: z.enum(BLOCK_CAUSES),
  /** The version that was blocked; it stays blocked for good. */
  version: z.string().nullable(),
  findings: z.array(z.string()),
  at: z.iso.datetime(),
});
export type BlockRecord = z.infer<typeof blockRecordSchema>;

const INJECTION_RULES = new Set([
  'ignore_instructions',
  'hide_from_user',
  'override_system',
  'unicode_tag_chars',
  'invisible_unicode',
  'instruction_tag',
]);
const EXFILTRATION_RULES = new Set(['runtime_egress', 'exfiltration_language', 'sensitive_file']);

/**
 * The cause of a block from the findings behind it. Only findings that all come from vulnerable
 * dependencies make it a `vulnerable_dependency` block; findings without a recorded rule (older
 * scorecards) count as `other`, which is never lifted automatically.
 */
export function blockCause(findings: Array<Pick<SecurityFinding, 'rule' | 'review'>>): BlockCause {
  // A reviewed match the review cleared is not a cause at all (M10 safeguard a).
  const live = findings.filter((x) => !(x.review && CLEARING_VERDICTS.has(x.review.verdict)));
  const injection = live.filter((x) => x.rule && INJECTION_RULES.has(x.rule));
  // Confirmed by review, or recorded before reviews existed (kept as they were judged then).
  if (injection.some((x) => !x.review || x.review.verdict === 'instructs')) return 'injection';
  if (injection.length > 0) return 'suspected_injection';
  if (live.some((x) => x.rule && EXFILTRATION_RULES.has(x.rule))) return 'exfiltration';
  if (live.length > 0 && live.every((x) => x.rule === 'vulnerable_dependency'))
    return 'vulnerable_dependency';
  return 'other';
}

/** Causes that lock the author's org out of auto-approval for good. */
export const ORG_LOCK_CAUSES: ReadonlySet<BlockCause> = new Set(['injection', 'exfiltration']);

/**
 * May the policy lift its own block (PRD FR-P10)? Only when all hold: the policy blocked it; the
 * cause was vulnerable dependencies; a newer version is pinned (never a blocked one); gates 0–3
 * all pass on that exact version with no high/critical finding. The item goes back to candidate,
 * never straight to a recommended status, and the blocked version stays blocked.
 */
export function liftFor(f: PolicyFacts, p: ApprovalPolicy): PolicyDecision {
  const hold = (reason: string): PolicyDecision => ({
    action: 'hold',
    tier: null,
    criteria: [],
    needsSecondOpinion: false,
    reason: `stays blocked: ${reason}`,
  });
  const r = f.blockRecord;
  if (!r) return hold('no block record (blocked before M8.3 or by hand)');
  // A suspected injection (a rule match no review confirmed) is lifted after a clean re-check:
  // gate 3 checked again after the block, with no flag left (M10 safeguard a).
  if (r.cause === 'suspected_injection') {
    const checked = f.gates?.gate3_security?.checkedAt;
    if (!checked || Date.parse(checked) <= Date.parse(r.at))
      return hold('suspected injection: waiting for a gate 3 re-check');
    const flags = f.findings.filter((x) => FLAG_SEVERITIES.has(x.severity));
    if (flags.length > 0)
      return hold(`suspected injection: the re-check still has ${flags.length} flag(s)`);
    return {
      action: 'lift',
      to: 'candidate',
      reason: `block lifted: suspected injection not found again in the gate 3 re-check of ${checked.slice(0, 10)}`,
    };
  }
  if (!isPolicyActor(r.by)) return hold(`blocked by ${r.by}, not by the policy`);
  if (r.cause !== 'vulnerable_dependency') return hold(`cause ${r.cause} is never lifted`);
  if (
    !f.pinnedVersion ||
    f.pinnedVersion === r.version ||
    f.blockedVersions.includes(f.pinnedVersion)
  )
    return hold(`no newer version than the blocked ${r.version ?? 'version'}`);
  const failing = p.required_gates.filter((g) => f.gates?.[g]?.result !== 'pass');
  if (f.gates === null || failing.length > 0)
    return hold(`version ${f.pinnedVersion}: ${failing.join(', ')} not passing`);
  const flags = f.findings.filter((x) => FLAG_SEVERITIES.has(x.severity));
  if (flags.length > 0) return hold(`version ${f.pinnedVersion} still has ${flags.length} flag(s)`);
  return {
    action: 'lift',
    to: 'candidate',
    reason: `block lifted: version ${f.pinnedVersion} fixes the vulnerable dependencies of ${r.version ?? 'the blocked version'} (gates 0–3 pass); ${r.version ?? 'the blocked version'} stays blocked`,
  };
}
