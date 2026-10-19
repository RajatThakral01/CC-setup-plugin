import {
  and,
  catalogItems,
  desc,
  eq,
  inArray,
  itemVersions,
  ne,
  rawSourceRecords,
  scorecards,
  signalSnapshots,
  statusEvents,
  type Db,
} from '@cc-setup-agent/db';
import {
  categoryAgreement,
  ruleOpinion,
  type CategoryRules,
  type PolicyFacts,
  type RuleInputs,
  type RuleOpinion,
  type Status,
} from '@cc-setup-agent/shared';

export type ItemRow = typeof catalogItems.$inferSelect;
type ScorecardRow = typeof scorecards.$inferSelect;

export interface ItemFacts {
  item: ItemRow;
  facts: PolicyFacts;
  rules: RuleOpinion;
  scorecard: ScorecardRow | null;
  stars: number | null;
  starVelocity7d: number | null;
}

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

/** Keywords and topics from an item's stored raw records (no network). */
export function ruleInputsFrom(
  item: Pick<ItemRow, 'id' | 'name' | 'publisher' | 'sourceUrl' | 'components'>,
  records: Array<{ source: string; payload: unknown }>,
): RuleInputs {
  const keywords: string[] = [];
  const topics: string[] = [];
  for (const r of records) {
    const p = obj(r.payload);
    if (r.source === 'github_repo') topics.push(...strings(p['topics']));
    if (r.source === 'npm_package') keywords.push(...strings(obj(p['latest'])['keywords']));
    if (r.source === 'marketplace') {
      const plugin = obj(p['plugin']);
      keywords.push(...strings(plugin['keywords']), ...strings(plugin['tags']));
    }
  }
  const c = item.components;
  const owner = /^https:\/\/github\.com\/([^/]+)\//i.exec(item.sourceUrl)?.[1] ?? null;
  return {
    names: [item.name, item.id],
    componentNames: c
      ? [...c.tools, ...c.skills, ...c.commands, ...c.agents].map((x) => x.name)
      : [],
    keywords,
    topics,
    publisher: owner ?? item.publisher,
  };
}

/** The category's incumbent (FR-E4), excluding the item itself: recommended first, then provisional. */
export function incumbentFor(
  all: Array<Pick<ItemRow, 'id' | 'status' | 'category'>>,
  item: Pick<ItemRow, 'id' | 'category'>,
): string | null {
  if (!item.category) return null;
  const inCategory = all
    .filter((i) => i.category === item.category && i.id !== item.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  return (
    inCategory.find((i) => i.status === 'recommended')?.id ??
    inCategory.find((i) => i.status === 'recommended_provisional')?.id ??
    null
  );
}

/** Gathers the policy facts for every non-rejected item (or the given ones). Database only. */
export async function loadPolicyFacts(
  db: Db,
  rulesConfig: CategoryRules,
  now: Date,
  itemIds?: string[],
): Promise<ItemFacts[]> {
  const everyone = await db
    .select({ id: catalogItems.id, status: catalogItems.status, category: catalogItems.category })
    .from(catalogItems);
  const items = await db
    .select()
    .from(catalogItems)
    .where(
      and(
        ne(catalogItems.status, 'rejected'),
        itemIds ? inArray(catalogItems.id, itemIds) : undefined,
      ),
    )
    .orderBy(catalogItems.id);
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const [pins, cards, snaps, records, events] = await Promise.all([
    db
      .select()
      .from(itemVersions)
      .where(and(inArray(itemVersions.itemId, ids), eq(itemVersions.pinned, true))),
    db
      .select()
      .from(scorecards)
      .where(inArray(scorecards.itemId, ids))
      .orderBy(desc(scorecards.updatedAt)),
    db
      .selectDistinctOn([signalSnapshots.itemId])
      .from(signalSnapshots)
      .where(inArray(signalSnapshots.itemId, ids))
      .orderBy(signalSnapshots.itemId, desc(signalSnapshots.capturedAt)),
    db
      .select({
        itemId: rawSourceRecords.itemId,
        source: rawSourceRecords.source,
        payload: rawSourceRecords.payload,
        starVelocity7d: rawSourceRecords.starVelocity7d,
      })
      .from(rawSourceRecords)
      .where(inArray(rawSourceRecords.itemId, ids)),
    db
      .select()
      .from(statusEvents)
      .where(inArray(statusEvents.itemId, ids))
      .orderBy(desc(statusEvents.id)),
  ]);
  const pinned = new Map(pins.map((p) => [p.itemId, p.version]));
  const snapshot = new Map(snaps.map((s) => [s.itemId, s]));
  return items.map((item) => {
    const version = pinned.get(item.id) ?? null;
    const mine = cards.filter((c) => c.itemId === item.id);
    const card = (version ? mine.find((c) => c.version === version) : undefined) ?? mine[0] ?? null;
    const recs = records.filter((r) => r.itemId === item.id);
    const rules = ruleOpinion(ruleInputsFrom(item, recs), rulesConfig);
    // The event that put the item into its current status (for approval age and approver).
    const entered = events.find(
      (e) => e.itemId === item.id && e.toStatus === item.status && e.fromStatus !== e.toStatus,
    );
    const approved = item.status === 'recommended' || item.status === 'recommended_provisional';
    const snap = snapshot.get(item.id);
    const facts: PolicyFacts = {
      id: item.id,
      status: item.status as Status,
      kind: item.kind,
      category: item.category,
      provenance: item.provenance,
      install: item.install,
      pinnedVersion: version,
      gates: card?.gateResults ?? null,
      findings: card?.securityFindings ?? [],
      lastCommitAt: snap?.lastCommitAt?.toISOString() ?? null,
      relevant: item.classification?.relevant ?? false,
      stacks: item.stacks,
      outOfScope: item.outOfScope,
      agreement: categoryAgreement({
        category: item.category,
        categorySetBy: item.categorySetBy,
        primary: item.classification,
        primaryInputHash: item.classificationInputHash,
        second: item.secondOpinion,
        rules,
      }),
      evalSummary: card?.evalSummary ?? null,
      incumbentId: incumbentFor(everyone, item),
      approvedAt: approved && entered ? entered.createdAt.toISOString() : null,
      approvedBy: approved && entered ? entered.actor : null,
      veto: item.policyVeto,
      acknowledgedFindings: item.securityOverride?.findings ?? [],
      now: now.toISOString(),
    };
    const velocity = recs.map((r) => r.starVelocity7d).find((v) => v !== null) ?? null;
    return {
      item,
      facts,
      rules,
      scorecard: card,
      stars: snap?.stars ?? null,
      starVelocity7d: snap?.starVelocity7d ?? velocity,
    };
  });
}
