import {
  and,
  catalogItems,
  claudeCodeChanges,
  desc,
  eq,
  inArray,
  policyDecisions,
  rawSourceRecords,
  scorecards,
  evalRuns,
  signalSnapshots,
  sql,
  statusEvents,
  type Db,
} from '@cc-setup-agent/db';
import type { Status } from '@cc-setup-agent/shared';
import { priorityScore } from './priority.js';

export type Scope = 'in' | 'out' | 'all';
export const MVP_STACK = 'nextjs';

export interface QueueFilter {
  status: Status | 'all';
  scope: Scope;
  category?: string;
  q?: string;
  /** Only items whose kind or category a reclassification changed (optional view). */
  review?: boolean;
}

export type ItemRow = typeof catalogItems.$inferSelect;
export type ScorecardRow = typeof scorecards.$inferSelect;

export interface QueueEntry {
  item: ItemRow;
  scorecard: ScorecardRow | null;
  stars: number | null;
  priority: number;
  securityFlagged: boolean;
}

async function latestScorecards(db: Db, ids: string[]): Promise<Map<string, ScorecardRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(scorecards)
    .where(inArray(scorecards.itemId, ids))
    .orderBy(desc(scorecards.updatedAt));
  const map = new Map<string, ScorecardRow>();
  for (const r of rows) if (!map.has(r.itemId)) map.set(r.itemId, r);
  return map;
}

async function latestStars(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([signalSnapshots.itemId], {
      itemId: signalSnapshots.itemId,
      stars: signalSnapshots.stars,
    })
    .from(signalSnapshots)
    .where(inArray(signalSnapshots.itemId, ids))
    .orderBy(signalSnapshots.itemId, desc(signalSnapshots.capturedAt));
  return new Map(rows.flatMap((r) => (r.stars === null ? [] : [[r.itemId, r.stars] as const])));
}

/** Recommended or provisional items per category, for the coverage-gap part of the priority. */
async function categoryCoverage(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ category: catalogItems.category, n: sql<number>`count(*)::int` })
    .from(catalogItems)
    .where(inArray(catalogItems.status, ['recommended', 'recommended_provisional']))
    .groupBy(catalogItems.category);
  return new Map(rows.flatMap((r) => (r.category ? [[r.category, r.n] as const] : [])));
}

export function securityFlagged(card: ScorecardRow | null): boolean {
  return card?.gateResults.gate3_security?.result === 'fail';
}

/** The triage queue, highest priority first. Out-of-scope items are hidden unless asked for. */
export async function listQueue(db: Db, filter: QueueFilter): Promise<QueueEntry[]> {
  const conditions = [
    filter.status === 'all' ? undefined : eq(catalogItems.status, filter.status),
    filter.scope === 'in' ? sql`not (${MVP_STACK} = any(${catalogItems.outOfScope}))` : undefined,
    filter.scope === 'out' ? sql`${MVP_STACK} = any(${catalogItems.outOfScope})` : undefined,
    filter.category ? sql`${catalogItems.category}::text = ${filter.category}` : undefined,
    filter.review ? sql`${catalogItems.classificationReview} is not null` : undefined,
    filter.q
      ? sql`(${catalogItems.id} ilike ${`%${filter.q}%`} or ${catalogItems.name} ilike ${`%${filter.q}%`})`
      : undefined,
  ].filter((c) => c !== undefined);
  const items = await db
    .select()
    .from(catalogItems)
    .where(conditions.length ? and(...conditions) : undefined);
  const ids = items.map((i) => i.id);
  const [cards, stars, coverage] = await Promise.all([
    latestScorecards(db, ids),
    latestStars(db, ids),
    categoryCoverage(db),
  ]);
  return items
    .map((item) => {
      const scorecard = cards.get(item.id) ?? null;
      return {
        item,
        scorecard,
        stars: stars.get(item.id) ?? null,
        securityFlagged: securityFlagged(scorecard),
        priority: priorityScore({
          provenance: item.provenance,
          confidence: scorecard?.confidence ?? null,
          gates: scorecard?.gateResults ?? null,
          category: item.category,
          categoryCoverage: item.category ? (coverage.get(item.category) ?? 0) : 0,
        }),
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.stars ?? 0) - (a.stars ?? 0) ||
        a.item.id.localeCompare(b.item.id),
    );
}

export async function countByScope(
  db: Db,
  status: Status | 'all',
): Promise<{ in: number; out: number }> {
  const [row] = await db
    .select({
      out: sql<number>`count(*) filter (where ${MVP_STACK} = any(${catalogItems.outOfScope}))::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(catalogItems)
    .where(status === 'all' ? undefined : eq(catalogItems.status, status));
  return { in: (row?.all ?? 0) - (row?.out ?? 0), out: row?.out ?? 0 };
}

export interface ItemDetail {
  item: ItemRow;
  scorecards: ScorecardRow[];
  events: Array<typeof statusEvents.$inferSelect>;
  records: Array<
    Pick<
      typeof rawSourceRecords.$inferSelect,
      'source' | 'externalId' | 'fetchedAt' | 'intakeState' | 'stars'
    >
  >;
  snapshot: typeof signalSnapshots.$inferSelect | null;
  /** Eval runs with this item as the tool under test, newest first (plan M9). */
  evalRuns: Array<typeof evalRuns.$inferSelect>;
  /** The approval policy's latest decision for this item (PRD 9.2a). */
  decision: typeof policyDecisions.$inferSelect | null;
}

export async function getItemDetail(db: Db, id: string): Promise<ItemDetail | null> {
  const [item] = await db.select().from(catalogItems).where(eq(catalogItems.id, id));
  if (!item) return null;
  const [cards, events, records, snaps, runs, decisions] = await Promise.all([
    db
      .select()
      .from(scorecards)
      .where(eq(scorecards.itemId, id))
      .orderBy(desc(scorecards.updatedAt)),
    db
      .select()
      .from(statusEvents)
      .where(eq(statusEvents.itemId, id))
      .orderBy(desc(statusEvents.id)),
    db
      .select({
        source: rawSourceRecords.source,
        externalId: rawSourceRecords.externalId,
        fetchedAt: rawSourceRecords.fetchedAt,
        intakeState: rawSourceRecords.intakeState,
        stars: rawSourceRecords.stars,
      })
      .from(rawSourceRecords)
      .where(eq(rawSourceRecords.itemId, id)),
    db
      .select()
      .from(signalSnapshots)
      .where(eq(signalSnapshots.itemId, id))
      .orderBy(desc(signalSnapshots.capturedAt))
      .limit(1),
    db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.itemId, id))
      .orderBy(desc(evalRuns.createdAt))
      .limit(50),
    db.select().from(policyDecisions).where(eq(policyDecisions.itemId, id)),
  ]);
  return {
    item,
    scorecards: cards,
    events,
    records,
    snapshot: snaps[0] ?? null,
    evalRuns: runs,
    decision: decisions[0] ?? null,
  };
}

/** Marks an item in or out of scope for the MVP stack (not a status change, so not audited). */
export async function setOutOfScope(db: Db, id: string, outOfScope: boolean): Promise<void> {
  const [item] = await db
    .select({ outOfScope: catalogItems.outOfScope })
    .from(catalogItems)
    .where(eq(catalogItems.id, id));
  if (!item) return;
  const rest = item.outOfScope.filter((s) => s !== MVP_STACK);
  await db
    .update(catalogItems)
    .set({ outOfScope: outOfScope ? [...rest, MVP_STACK] : rest })
    .where(eq(catalogItems.id, id));
}

export async function listChanges(db: Db, flag?: string) {
  return db
    .select()
    .from(claudeCodeChanges)
    .where(flag ? sql`${flag} = any(${claudeCodeChanges.flags})` : undefined)
    .orderBy(
      desc(sql`coalesce(${claudeCodeChanges.publishedAt}, ${claudeCodeChanges.fetchedAt})`),
      desc(claudeCodeChanges.version),
    )
    .limit(200);
}

/** Items whose kind or category a reclassification changed (an optional view, never required). */
export async function countNeedingReview(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(catalogItems)
    .where(sql`${catalogItems.classificationReview} is not null`);
  return row?.n ?? 0;
}
