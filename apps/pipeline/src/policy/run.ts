import type { LlmClient, Logger } from '@cc-setup-agent/core';
import {
  BudgetExceededError,
  catalogItems,
  eq,
  InvalidTransitionError,
  policyDecisions,
  transitionStatus,
  type Db,
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
  error?: string;
}

export interface PolicyReport {
  policyVersion: string;
  evaluated: number;
  outcomes: PolicyOutcome[];
  secondOpinions: { asked: number; agreed: number; costUsd: number; skipped: string[] };
  stoppedBy?: string;
}

/**
 * Runs the approval policy (PRD 9.2a) over the catalog: demotions, promotions and approvals,
 * applied through `transitionStatus` with actor `policy:<version>`. The latest decision for each
 * item, with every criterion, is stored in `policy_decisions`. Nothing here ever needs a human.
 */
export async function runPolicy(deps: PolicyDeps, options: PolicyOptions): Promise<PolicyReport> {
  const now = options.now ?? new Date();
  const actor = policyActor(deps.policy.version);
  const report: PolicyReport = {
    policyVersion: deps.policy.version,
    evaluated: 0,
    outcomes: [],
    secondOpinions: { asked: 0, agreed: 0, costUsd: 0, skipped: [] },
  };
  const all = await loadPolicyFacts(deps.db, deps.rules, now, options.itemIds);
  const max = options.maxSecondOpinions ?? 100;
  let budgetStop = false;

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

    const outcome: PolicyOutcome = {
      id: current.item.id,
      from: current.facts.status,
      decision,
      applied: false,
    };
    if (decision.action !== 'hold' && options.apply) {
      try {
        await transitionStatus(
          deps.db,
          current.item.id,
          decision.to,
          actor,
          decision.reason,
          decision.action === 'demote' && decision.block ? { block: decision.block } : {},
        );
        outcome.applied = true;
      } catch (error) {
        if (!(error instanceof InvalidTransitionError)) throw error;
        outcome.error = error.message;
        deps.logger.warn({ id: current.item.id, err: error.message }, 'policy transition refused');
      }
    }
    await storeDecision(deps.db, deps.policy.version, outcome, now);
    report.outcomes.push(outcome);
    report.evaluated++;
  }
  return report;
}

async function storeDecision(db: Db, version: string, o: PolicyOutcome, now: Date) {
  const d = o.decision;
  const row = {
    policyVersion: version,
    action: d.action,
    fromStatus: o.from,
    toStatus: d.action === 'hold' ? null : d.to,
    tier: d.action === 'demote' || d.action === 'lift' ? null : d.tier,
    reason: o.error ? `${d.reason} | refused: ${o.error}` : d.reason,
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
    const list = by(action);
    lines.push(`${label}${verb}: ${list.length}`);
    for (const o of list)
      lines.push(
        `  ${o.id} (${o.from}${o.decision.action === 'demote' ? ` → ${o.decision.to}` : ''})${o.error ? ` REFUSED: ${o.error}` : ''}\n    ${o.decision.reason}`,
      );
  }
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
