import { eq, or, sql } from 'drizzle-orm';
import type { IntakeState, Source } from '@cc-setup-agent/shared';
import type { DbOrTx } from './client.js';
import { catalogItems, rawSourceRecords } from './schema.js';

export interface RawRecordInput {
  source: Source;
  externalId: string;
  payload: unknown;
  /** Links the record to an item; an existing link is kept when omitted. */
  itemId?: string;
  fetchedAt?: Date;
  /**
   * Intake state to set. Applied on insert; on update it replaces the state only while the
   * record is not linked to an item (linking is decided by intake, not by refetches).
   */
  intakeState?: IntakeState;
  stars?: { count: number; checkedAt: Date; velocity7d?: number | undefined };
}

/** Inserts or refreshes a raw record keyed by (source, external_id). Idempotent. */
export async function upsertRawRecord(tx: DbOrTx, input: RawRecordInput): Promise<number> {
  const fetchedAt = input.fetchedAt ?? new Date();
  const [row] = await tx
    .insert(rawSourceRecords)
    .values({
      source: input.source,
      externalId: input.externalId,
      payload: input.payload,
      fetchedAt,
      itemId: input.itemId ?? null,
      ...(input.intakeState ? { intakeState: input.intakeState } : {}),
      ...(input.stars
        ? {
            stars: input.stars.count,
            starsCheckedAt: input.stars.checkedAt,
            starVelocity7d: input.stars.velocity7d ?? null,
          }
        : {}),
    })
    .onConflictDoUpdate({
      target: [rawSourceRecords.source, rawSourceRecords.externalId],
      set: {
        payload: input.payload,
        fetchedAt,
        itemId: input.itemId ?? sql`${rawSourceRecords.itemId}`,
        ...(input.intakeState
          ? {
              intakeState: input.itemId
                ? input.intakeState
                : sql`CASE WHEN ${rawSourceRecords.itemId} IS NULL THEN ${input.intakeState}::intake_state ELSE ${rawSourceRecords.intakeState} END`,
            }
          : {}),
        ...(input.stars
          ? {
              stars: input.stars.count,
              starsCheckedAt: input.stars.checkedAt,
              ...(input.stars.velocity7d !== undefined
                ? { starVelocity7d: input.stars.velocity7d }
                : {}),
            }
          : {}),
      },
    })
    .returning({ id: rawSourceRecords.id });
  if (!row) throw new Error('upsertRawRecord returned no row');
  return row.id;
}

/** Finds an existing item by canonical source URL (case-insensitive) or package name (FR-D8). */
export async function findItemByKeys(
  tx: DbOrTx,
  keys: { sourceUrl?: string; packageName?: string },
): Promise<{ id: string; sourceUrl: string } | undefined> {
  const conditions = [
    keys.sourceUrl ? sql`lower(${catalogItems.sourceUrl}) = lower(${keys.sourceUrl})` : undefined,
    keys.packageName ? eq(catalogItems.packageName, keys.packageName) : undefined,
  ].filter((c) => c !== undefined);
  if (conditions.length === 0) return undefined;
  const [row] = await tx
    .select({ id: catalogItems.id, sourceUrl: catalogItems.sourceUrl })
    .from(catalogItems)
    .where(or(...conditions))
    .limit(1);
  return row;
}

/** Returns `base`, or `base-2`, `base-3`… whichever id is free. */
export async function uniqueItemId(tx: DbOrTx, base: string): Promise<string> {
  const rows = await tx
    .select({ id: catalogItems.id })
    .from(catalogItems)
    .where(or(eq(catalogItems.id, base), sql`${catalogItems.id} ~ ${`^${base}-[0-9]+$`}`));
  const taken = new Set(rows.map((r) => r.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
