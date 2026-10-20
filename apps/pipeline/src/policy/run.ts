import type { LlmClient, Logger } from '@cc-setup-agent/core';
import { createHash } from 'node:crypto';
import {
  acceptedVersion,
  acceptVersion,
  BudgetExceededError,
  catalogItems,
  eq,
  InvalidTransitionError,
  holdChange,
  policyDecisions,
  transitionStatus,
  type Db,
  type HeldChange,
  type HoldTrigger,
  type VersionedComponent,
} from '@cc-setup-agent/db';
import {
  categoryAgreement,
  decide,
  policyActor,
  type AppConfig,
  type ApprovalPolicy,
  type CategoryRules,
  type PolicyDecision,
  type Status,
} from '@cc-setup-agent/shared';
import { requestSecondOpinion } from '../classify/run.js';
import { SCANNER_VERSION } from '../gates/review.js';
import type { GithubClient } from '../sources/github.js';
import type { NpmClient } from '../sources/npm.js';
import { loadPolicyFacts, type ItemFacts } from './facts.js';

export interface PolicyDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  github: GithubClient;
  npm: NpmClient;
  policy: ApprovalPolicy;
  rules: CategoryRules;
  /** Needed only for second opinions. */
  llm?: LlmClient;
  /** Vendor GitHub orgs, never locked automatically (M10 safeguard b); default: vendors.yaml. */
  vendorOrgs?: ReadonlySet<string>;
}

export interface PolicyOptions {
  /** Apply status changes (false = dry run: decisions are stored as not applied). */
  apply: boolean;
  /** Ask the strong model for second opinions where that is the only missing piece. */
  secondOpinions: boolean;
  maxSecondOpinions?: number;
  itemIds?: string[];
  now?: Date;
}

export interface PolicyOutcome {
  id: string;
  from: Status;
  decision: PolicyDecision;
  applied: boolean;
  /** Held for the owner instead of applied (M10 safeguards c and d). */
  held?: HoldTrigger;
  /** The decision differs from the item's previous stored decision. */
  changed: boolean;
  error?: string;
}

export interface PolicyReport {
  policyVersion: string;
  evaluated: number;
  outcomes: PolicyOutcome[];
  secondOpinions: { asked: number; agreed: number; costUsd: number; skipped: string[] };
  /** Versions the decisions came from, and whether each was accepted when the run started. */
  versions: Record<VersionedComponent, { current: string; accepted: string | null }>;
  /** Components whose new version this run accepted (a clean dry run over the whole catalog). */
  acceptedNow: VersionedComponent[];
  stoppedBy?: string;
}

/** `<label>#<8 hex of the content>`: an edit without a version bump is still a change. */
export function contentVersion(label: string, content: unknown): string {
  return `${label}#${createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 8)}`;
}

/**
 * Runs the approval policy (PRD 9.2a) over the catalog: demotions, promotions and approvals,
 * applied through `transitionStatus` with actor `policy:<version>`. The latest decision for each
 * item, with every criterion, is stored in `policy_decisions`. Nothing here ever needs a human.
 */
export async function runPolicy(deps: PolicyDeps, options: PolicyOptions): Promise<PolicyReport> {
  const now = options.now ?? new Date();
  const actor = policyActor(deps.policy.version);
  const versions = await currentVersions(deps, options.apply);
  const report: PolicyReport = {
    policyVersion: deps.policy.version,
    evaluated: 0,
    outcomes: [],
    secondOpinions: { asked: 0, agreed: 0, costUsd: 0, skipped: [] },
    versions,
    acceptedNow: [],
  };
  const previous = new Map(
    (
      await deps.db
        .select({
          itemId: policyDecisions.itemId,
          action: policyDecisions.action,
          toStatus: policyDecisions.toStatus,
        })
        .from(policyDecisions)
    ).map((p) => [p.itemId, p]),
  );
  const all = await loadPolicyFacts(deps.db, deps.rules, now, options.itemIds, deps.vendorOrgs);
  const max = options.maxSecondOpinions ?? 100;
  let budgetStop = false;
  const decided: Array<{ entry: ItemFacts; outcome: PolicyOutcome }> = [];

  // 1. Decide every item (second opinions included); nothing is applied yet.
  for (const entry of all) {
    let current: ItemFacts = entry;
    let decision = decide(current.facts, deps.policy);

    if (
      decision.action === 'hold' &&
      decision.needsSecondOpinion &&
      options.secondOpinions &&
      deps.llm &&
      !budgetStop &&
      report.secondOpinions.asked < max
    ) {
      try {
        const result = await requestSecondOpinion({ ...deps, llm: deps.llm }, current.item);
        report.secondOpinions.costUsd += result.costUsd;
        if (result.ok) {
          report.secondOpinions.asked++;
          if (result.agreesOnCategory) report.secondOpinions.agreed++;
          const [fresh] = await deps.db
            .select()
            .from(catalogItems)
            .where(eq(catalogItems.id, current.item.id));
          if (fresh) {
            current = {
              ...current,
              item: fresh,
              facts: {
                ...current.facts,
                agreement: categoryAgreement({
                  category: fresh.category,
                  categorySetBy: fresh.categorySetBy,
                  primary: fresh.classification,
                  primaryInputHash: fresh.classificationInputHash,
                  second: fresh.secondOpinion,
                  rules: current.rules,
                }),
              },
            };
            decision = decide(current.facts, deps.policy);
          }
        } else report.secondOpinions.skipped.push(`${current.item.id}: ${result.reason}`);
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          budgetStop = true;
          report.stoppedBy = `second opinions stopped: ${error.message}`;
          deps.logger.warn({ limitedBy: error.limitedBy }, 'classification budget reached');
        } else {
          report.secondOpinions.skipped.push(
            `${current.item.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          deps.logger.error({ id: current.item.id, err: error }, 'second opinion failed');
        }
      }
    }
    const prev = previous.get(current.item.id);
    const to = decision.action === 'hold' ? null : decision.to;
    decided.push({
      entry: current,
      outcome: {
        id: current.item.id,
        from: current.facts.status,
        decision,
        applied: false,
        changed: !prev || prev.action !== decision.action || prev.toStatus !== to,
      },
    });
  }

  // 2. Safeguards (M10): demotions from a version nobody accepted yet (c), or too many demotions
  // of approved items at once (d), are held for the owner instead of applied.
  const held = holdsFor(
    decided.map((d) => ({
      outcome: d.outcome,
      scannerVersion: d.entry.scorecard?.scannerVersion ?? LEGACY_SCANNER,
    })),
    versions,
    deps.policy.demotion.max_auto_demotions,
  );

  // 3. Apply what isn't held.
  for (const { entry, outcome } of decided) {
    const { decision } = outcome;
    const trigger = held.get(outcome.id);
    if (trigger) {
      outcome.held = trigger;
      if (options.apply && decision.action === 'demote')
        await holdChange(deps.db, {
          itemId: outcome.id,
          from: outcome.from,
          to: decision.to,
          actor,
          reason: decision.reason,
          ...(decision.block ? { block: decision.block } : {}),
          source: 'policy',
          trigger,
          versions: {
            policy: versions.policy.current,
            category_rules: versions.category_rules.current,
            scanner: entry.scorecard?.scannerVersion ?? LEGACY_SCANNER,
          },
        });
    } else if (decision.action !== 'hold' && options.apply) {
      try {
        await transitionStatus(
          deps.db,
          outcome.id,
          decision.to,
          actor,
          decision.reason,
          decision.action === 'demote' && decision.block ? { block: decision.block } : {},
        );
        outcome.applied = true;
      } catch (error) {
        if (!(error instanceof InvalidTransitionError)) throw error;
        outcome.error = error.message;
        deps.logger.warn({ id: outcome.id, err: error.message }, 'policy transition refused');
      }
    }
    await storeDecision(deps.db, deps.policy.version, outcome, now);
    report.outcomes.push(outcome);
    report.evaluated++;
  }

  // 4. A changed policy or category-rules version takes effect on its own only after a clean run
  // over the whole catalog: nothing it would newly demote or block (safeguard c).
  if (options.apply && !options.itemIds) {
    for (const component of ['policy', 'category_rules'] as const) {
      const v = versions[component];
      const trigger: HoldTrigger = component === 'policy' ? 'policy_change' : 'rules_change';
      if (v.accepted !== v.current && ![...held.values()].includes(trigger)) {
        await acceptVersion(deps.db, component, v.current, 'system: clean full dry run');
        report.acceptedNow.push(component);
      }
    }
  }
  return report;
}

/** Scorecards written before M10 carry no scanner version: they came from the accepted v1 scanner. */
const LEGACY_SCANNER = 'scanner-v1';

async function currentVersions(
  deps: PolicyDeps,
  apply: boolean,
): Promise<PolicyReport['versions']> {
  const current = {
    policy: contentVersion(deps.policy.version, deps.policy),
    category_rules: contentVersion(deps.rules.version, deps.rules),
    scanner: SCANNER_VERSION,
  };
  const out = {} as PolicyReport['versions'];
  for (const component of ['policy', 'category_rules', 'scanner'] as const) {
    let accepted = await acceptedVersion(deps.db, component);
    // First run with safeguard c: today's policy and rules are the baseline (nothing to compare).
    if (accepted === null && component !== 'scanner') {
      accepted = current[component];
      if (apply) await acceptVersion(deps.db, component, accepted, 'system: baseline (first run)');
    }
    out[component] = { current: current[component], accepted };
  }
  return out;
}

/**
 * Which demotions to hold, and why (pure; M10 safeguards c and d). Every demotion is held while
 * the policy or category rules changed and aren't accepted yet, or when it rests on a scorecard
 * from a scanner version nobody accepted. Of the rest, if more than `maxDemotions` approved items
 * would be demoted at once, all of those are held.
 */
export function holdsFor(
  decided: Array<{
    outcome: Pick<PolicyOutcome, 'id' | 'from' | 'decision'>;
    scannerVersion: string;
  }>,
  versions: PolicyReport['versions'],
  maxDemotions: number,
): Map<string, HoldTrigger> {
  const held = new Map<string, HoldTrigger>();
  // An owner veto is the owner's own decision: it is never held.
  const demotions = decided.filter(
    (d) => d.outcome.decision.action === 'demote' && d.outcome.decision.trigger !== 'owner_veto',
  );
  const policyChanged = versions.policy.accepted !== versions.policy.current;
  const rulesChanged = versions.category_rules.accepted !== versions.category_rules.current;
  for (const d of demotions) {
    if (policyChanged) held.set(d.outcome.id, 'policy_change');
    else if (rulesChanged) held.set(d.outcome.id, 'rules_change');
    else if (d.scannerVersion !== versions.scanner.accepted)
      held.set(d.outcome.id, 'scanner_change');
  }
  const approvedDemotions = demotions.filter(
    (d) => !held.has(d.outcome.id) && APPROVED.has(d.outcome.from),
  );
  if (approvedDemotions.length > maxDemotions)
    for (const d of approvedDemotions) held.set(d.outcome.id, 'mass_demotion');
  return held;
}

const APPROVED: ReadonlySet<Status> = new Set(['recommended', 'recommended_provisional']);

async function storeDecision(db: Db, version: string, o: PolicyOutcome, now: Date) {
  const d = o.decision;
  const row = {
    policyVersion: version,
    action: d.action,
    fromStatus: o.from,
    toStatus: d.action === 'hold' ? null : d.to,
    tier: d.action === 'demote' || d.action === 'lift' ? null : d.tier,
    reason: o.held
      ? `held for the owner (${o.held}): ${d.reason}`
      : o.error
        ? `${d.reason} | refused: ${o.error}`
        : d.reason,
    criteria: d.action === 'demote' || d.action === 'lift' ? [] : d.criteria,
    applied: o.applied,
    evaluatedAt: now,
  };
  await db
    .insert(policyDecisions)
    .values({ itemId: o.id, ...row })
    .onConflictDoUpdate({ target: policyDecisions.itemId, set: row });
}

/** Plain-text report for the CLI: what changed, what was held and why. */
export function formatPolicyReport(r: PolicyReport, applied: boolean): string {
  const lines: string[] = [];
  const by = (a: PolicyDecision['action']) => r.outcomes.filter((o) => o.decision.action === a);
  const verb = applied ? '' : ' (dry run: not applied)';
  for (const [action, label] of [
    ['approve', 'Approved → recommended_provisional'],
    ['promote', 'Promoted → recommended'],
    ['demote', 'Demoted'],
    ['lift', 'Block lifted → candidate'],
  ] as const) {
    const list = by(action).filter((o) => !o.held);
    lines.push(`${label}${verb}: ${list.length}`);
    for (const o of list)
      lines.push(
        `  ${o.id} (${o.from}${o.decision.action === 'demote' ? ` → ${o.decision.to}` : ''})${o.error ? ` REFUSED: ${o.error}` : ''}\n    ${o.decision.reason}`,
      );
  }
  const forOwner = r.outcomes.filter((o) => o.held);
  if (forOwner.length > 0) {
    lines.push(
      `HELD FOR THE OWNER${applied ? '' : ' (dry run: would be held)'}: ${forOwner.length} (see \`pnpm run pipeline held\`)`,
    );
    for (const o of forOwner)
      lines.push(
        `  ${o.id} (${o.from}${o.decision.action === 'demote' ? ` → ${o.decision.to}` : ''}) [${o.held}]\n    ${o.decision.reason}`,
      );
  }
  const changed = r.outcomes.filter((o) => o.changed).length;
  lines.push(`Changed since the previous run: ${changed} of ${r.outcomes.length} decision(s)`);
  for (const [component, v] of Object.entries(r.versions))
    if (v.accepted !== v.current)
      lines.push(
        `  ${component} ${v.current} is not accepted yet (accepted: ${v.accepted ?? 'none'})`,
      );
  for (const c of r.acceptedNow) lines.push(`  ${c} ${r.versions[c].current} accepted: clean run`);
  const held = by('hold');
  lines.push(`Held: ${held.length}`);
  const counts = new Map<string, number>();
  for (const o of held)
    if (o.decision.action === 'hold')
      for (const c of o.decision.criteria.filter((c) => !c.ok))
        counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1]))
    lines.push(`  ${id} fails for ${n} item(s)`);
  const s = r.secondOpinions;
  lines.push(
    `Second opinions: ${s.asked} asked, ${s.agreed} agreed on category, USD ${s.costUsd.toFixed(4)}${s.skipped.length ? `; skipped ${s.skipped.length}` : ''}`,
  );
  if (r.stoppedBy) lines.push(r.stoppedBy);
  return lines.join('\n');
}

/** The open held changes, for the CLI (`pnpm run pipeline held`). */
export function formatHeldChanges(list: HeldChange[]): string {
  return [
    `${list.length} change(s) held for the owner. Apply: held --apply <id>... --by <name>; dismiss: held --dismiss <id>... --by <name>.`,
    ...list.map(
      (h) =>
        `#${h.id} ${h.itemId}: ${h.fromStatus} → ${h.toStatus} [${h.trigger}, by ${h.actor}, ${h.createdAt.toISOString().slice(0, 16)}]\n    ${h.reason}`,
    ),
  ].join('\n');
}
