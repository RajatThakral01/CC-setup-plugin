import { and, desc, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { EvalSummary, Status } from '@cc-setup-agent/shared';
import type { Db } from './client.js';
import { openHeldChanges, type HeldChange } from './holds.js';
import {
  budgetLedger,
  catalogItems,
  evalRuns,
  policyDecisions,
  scorecards,
  statusEvents,
} from './schema.js';

export interface DigestEntry {
  itemId: string;
  name: string;
  from: Status | null;
  to: Status;
  actor: string;
  reason: string;
  at: Date;
  sourceUrl: string;
  /** Evidence links from the latest scorecard (gate evidence with https URLs). */
  evidence: Array<{ label: string; url: string }>;
  evalSummary: EvalSummary | null;
}

export interface Digest {
  weekStart: string;
  weekEnd: string;
  approved: DigestEntry[];
  promoted: DigestEntry[];
  demoted: DigestEntry[];
  vetoes: DigestEntry[];
  /** Blocks the policy lifted (vulnerable dependency fixed in a newer version, PRD FR-P10). */
  lifted: DigestEntry[];
  /** Items held by the latest policy run, counted per failing criterion. */
  heldByCriterion: Array<{ criterion: string; items: number }>;
  latestPolicyRun: { version: string; at: Date; evaluated: number } | null;
  /** Status changes held for the owner (M10 safeguards c and d): new versions, mass demotions. */
  heldChanges: HeldChange[];
  /**
   * Org locks not applied because the org is a listed vendor (M10 safeguard b). Filled by the
   * pipeline, which knows the vendor list; empty here.
   */
  orgLockFlags: Array<{ org: string; itemId: string; cause: string }>;
  evals: { runs: number; costUsd: number };
  spend: { weekUsd: number };
}

const APPROVED: Status[] = ['recommended', 'recommended_provisional'];

/**
 * What the approval policy did in one ISO week (PRD FR-P8): approvals, promotions and demotions
 * (by the policy or by the gates' automatic checks), owner vetoes, with reasons and evidence.
 */
export async function buildDigest(db: Db, weekStart: string): Promise<Digest> {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const events = await db
    .select({
      itemId: statusEvents.itemId,
      from: statusEvents.fromStatus,
      to: statusEvents.toStatus,
      actor: statusEvents.actor,
      reason: statusEvents.reason,
      at: statusEvents.createdAt,
      name: catalogItems.name,
      sourceUrl: catalogItems.sourceUrl,
    })
    .from(statusEvents)
    .innerJoin(catalogItems, sql`${catalogItems.id} = ${statusEvents.itemId}`)
    .where(
      and(
        gte(statusEvents.createdAt, start),
        lt(statusEvents.createdAt, end),
        or(
          sql`${statusEvents.actor} like 'policy:%'`,
          sql`${statusEvents.reason} like 'owner veto%'`,
          and(sql`${statusEvents.actor} = 'system'`, inArray(statusEvents.fromStatus, APPROVED)),
        ),
      ),
    )
    .orderBy(statusEvents.createdAt, statusEvents.id);

  const ids = [...new Set(events.map((e) => e.itemId))];
  const cards =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(scorecards)
          .where(inArray(scorecards.itemId, ids))
          .orderBy(desc(scorecards.updatedAt));
  const entry = (e: (typeof events)[number]): DigestEntry => {
    const card = cards.find((c) => c.itemId === e.itemId);
    const evidence = Object.values(card?.gateResults ?? {})
      .flatMap((g) => g?.evidence ?? [])
      .filter(
        (x): x is { label: string; url: string } =>
          Boolean(x.url?.startsWith('https://')) && x.url !== e.sourceUrl,
      )
      .filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i)
      .slice(0, 4)
      .map((x) => ({ label: x.label, url: x.url }));
    return {
      itemId: e.itemId,
      name: e.name,
      from: e.from,
      to: e.to,
      actor: e.actor,
      reason: e.reason,
      at: e.at,
      sourceUrl: e.sourceUrl,
      evidence,
      evalSummary: card?.evalSummary ?? null,
    };
  };
  const isVeto = (e: (typeof events)[number]) => e.reason.startsWith('owner veto');
  const policy = events.filter((e) => !isVeto(e));

  const decisions = await db
    .select({
      action: policyDecisions.action,
      fromStatus: policyDecisions.fromStatus,
      criteria: policyDecisions.criteria,
      version: policyDecisions.policyVersion,
      at: policyDecisions.evaluatedAt,
    })
    .from(policyDecisions);
  const counts = new Map<string, number>();
  for (const d of decisions)
    // Only items the policy could have approved (candidates and watchlist), not provisional ones.
    if (d.action === 'hold' && (d.fromStatus === 'candidate' || d.fromStatus === 'watchlist'))
      for (const c of d.criteria) if (!c.ok) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  const latest = decisions.reduce<(typeof decisions)[number] | null>(
    (a, d) => (!a || d.at > a.at ? d : a),
    null,
  );

  const [evalRow] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      cost: sql<number>`coalesce(sum(${evalRuns.costUsd}), 0)::float`,
    })
    .from(evalRuns)
    .where(and(gte(evalRuns.createdAt, start), lt(evalRuns.createdAt, end)));
  const [spendRow] = await db
    .select({ usd: sql<number>`coalesce(sum(${budgetLedger.costUsd}), 0)::float` })
    .from(budgetLedger)
    .where(sql`${budgetLedger.weekStart} = ${weekStart}`);

  return {
    weekStart,
    weekEnd: end.toISOString().slice(0, 10),
    approved: policy.filter((e) => e.to === 'recommended_provisional').map(entry),
    promoted: policy.filter((e) => e.to === 'recommended').map(entry),
    demoted: policy
      .filter((e) => e.from !== null && APPROVED.includes(e.from) && !APPROVED.includes(e.to))
      .map(entry),
    vetoes: events.filter(isVeto).map(entry),
    lifted: policy.filter((e) => e.from === 'blocked').map(entry),
    heldByCriterion: [...counts]
      .map(([criterion, items]) => ({ criterion, items }))
      .sort((a, b) => b.items - a.items || a.criterion.localeCompare(b.criterion)),
    latestPolicyRun: latest
      ? { version: latest.version, at: latest.at, evaluated: decisions.length }
      : null,
    heldChanges: await openHeldChanges(db),
    orgLockFlags: [],
    evals: { runs: evalRow?.runs ?? 0, costUsd: evalRow?.cost ?? 0 },
    spend: { weekUsd: spendRow?.usd ?? 0 },
  };
}
