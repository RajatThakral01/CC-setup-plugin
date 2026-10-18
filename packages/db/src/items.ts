import { desc, eq } from 'drizzle-orm';
import {
  actorSchema,
  checkTransition,
  HUMAN_ONLY_TARGETS,
  type Actor,
  type Status,
} from '@cc-setup-agent/shared';
import type { Db, DbOrTx } from './client.js';
import { InvalidTransitionError, ItemNotFoundError } from './errors.js';
import { catalogItems, scorecards, statusEvents } from './schema.js';

export type NewCatalogItem = Omit<
  typeof catalogItems.$inferInsert,
  'status' | 'firstSeen' | 'lastChecked'
>;

/**
 * Inserts a new item as `candidate` and logs the creation event. This is the only insert path;
 * status is never taken from the caller (FR-D10).
 */
export async function insertCandidate(
  tx: DbOrTx,
  item: NewCatalogItem,
  actor: Actor,
  reason: string,
  /** Event time; defaults to the database clock. Jobs pass their run time for consistent day counts. */
  at?: Date,
): Promise<void> {
  actorSchema.parse(actor);
  await tx
    .insert(catalogItems)
    .values({ ...item, status: 'candidate', ...(at ? { firstSeen: at } : {}) });
  await tx.insert(statusEvents).values({
    itemId: item.id,
    fromStatus: null,
    toStatus: 'candidate',
    actor,
    reason,
    ...(at ? { createdAt: at } : {}),
  });
}

/**
 * The only way to change an item's status (plan 6.1). Validates the transition, then updates
 * the item and writes the audit event in one transaction. Recommended statuses need a human actor.
 */
export async function transitionStatus(
  db: Db,
  itemId: string,
  to: Status,
  actor: Actor,
  reason: string,
  /** Required to approve an item whose latest scorecard failed the security gate (plan M4/M5). */
  options: { overrideNote?: string } = {},
): Promise<{ from: Status; to: Status }> {
  if (reason.trim() === '') {
    throw new InvalidTransitionError(itemId, '?', to, 'a reason is required');
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: catalogItems.status })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .for('update');
    if (!row) throw new ItemNotFoundError(itemId);
    const check = checkTransition(row.status, to, actor);
    if (!check.ok) throw new InvalidTransitionError(itemId, row.status, to, check.reason);
    const override = options.overrideNote?.trim();
    if (HUMAN_ONLY_TARGETS.has(to)) {
      const [latest] = await tx
        .select({ gateResults: scorecards.gateResults })
        .from(scorecards)
        .where(eq(scorecards.itemId, itemId))
        .orderBy(desc(scorecards.updatedAt))
        .limit(1);
      if (latest?.gateResults.gate3_security?.result === 'fail' && !override) {
        throw new InvalidTransitionError(
          itemId,
          row.status,
          to,
          'security flags need a written override note',
        );
      }
    }
    await tx
      .update(catalogItems)
      .set({ status: to, lastChecked: new Date() })
      .where(eq(catalogItems.id, itemId));
    await tx.insert(statusEvents).values({
      itemId,
      fromStatus: row.status,
      toStatus: to,
      actor,
      reason: override ? `${reason} | override: ${override}` : reason,
    });
    return { from: row.status, to };
  });
}
