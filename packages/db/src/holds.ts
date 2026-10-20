import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  actorSchema,
  isHumanActor,
  type Actor,
  type BlockCause,
  type Status,
} from '@cc-setup-agent/shared';
import type { Db, DbOrTx } from './client.js';
import { HeldChangeError, InvalidTransitionError } from './errors.js';
import { transitionStatus } from './items.js';
import { acceptedVersions, catalogItems, heldChanges } from './schema.js';

/** Components whose changes must be dry-run before they act (M10 safeguard c). */
export type VersionedComponent = 'scanner' | 'policy' | 'category_rules';
export type HoldTrigger = 'scanner_change' | 'policy_change' | 'rules_change' | 'mass_demotion';

export interface HeldChangeInput {
  itemId: string;
  from: Status;
  to: Status;
  actor: Actor;
  reason: string;
  block?: { cause: BlockCause; findings: string[] };
  source: 'gates' | 'policy';
  trigger: HoldTrigger;
  versions: Record<string, string>;
}

export async function acceptedVersion(
  db: DbOrTx,
  component: VersionedComponent,
): Promise<string | null> {
  const [row] = await db
    .select({ version: acceptedVersions.version })
    .from(acceptedVersions)
    .where(eq(acceptedVersions.component, component));
  return row?.version ?? null;
}

/** Records `version` as accepted (by the owner, or by a clean full dry run). */
export async function acceptVersion(
  db: DbOrTx,
  component: VersionedComponent,
  version: string,
  by: string,
): Promise<void> {
  const row = { version, acceptedBy: by, acceptedAt: new Date() };
  await db
    .insert(acceptedVersions)
    .values({ component, ...row })
    .onConflictDoUpdate({ target: acceptedVersions.component, set: row });
}

/**
 * Holds a status change for the owner instead of applying it. One open hold per item and target:
 * a later run refreshes its reason and versions rather than adding a duplicate.
 */
export async function holdChange(db: DbOrTx, change: HeldChangeInput): Promise<void> {
  const values = {
    fromStatus: change.from,
    actor: change.actor,
    reason: change.reason,
    block: change.block ?? null,
    source: change.source,
    trigger: change.trigger,
    versions: change.versions,
  };
  const [open] = await db
    .select({ id: heldChanges.id })
    .from(heldChanges)
    .where(
      and(
        eq(heldChanges.itemId, change.itemId),
        eq(heldChanges.toStatus, change.to),
        isNull(heldChanges.resolvedAt),
      ),
    );
  if (open) await db.update(heldChanges).set(values).where(eq(heldChanges.id, open.id));
  else
    await db.insert(heldChanges).values({ itemId: change.itemId, toStatus: change.to, ...values });
}

export type HeldChange = typeof heldChanges.$inferSelect;

export async function openHeldChanges(db: DbOrTx): Promise<HeldChange[]> {
  return db
    .select()
    .from(heldChanges)
    .where(isNull(heldChanges.resolvedAt))
    .orderBy(asc(heldChanges.id));
}

/**
 * The owner applies or dismisses a held change. Applying goes through `transitionStatus` with the
 * actor that would have made it, and the audit reason names the hold and the owner. A change whose
 * item has moved on since it was held is refused: the owner sees the current state first.
 */
export async function resolveHeldChange(
  db: Db,
  id: number,
  resolution: 'apply' | 'dismiss',
  owner: Actor,
): Promise<HeldChange> {
  actorSchema.parse(owner);
  if (!isHumanActor(owner))
    throw new HeldChangeError('only the owner (human:<name>) resolves held changes');
  const [held] = await db.select().from(heldChanges).where(eq(heldChanges.id, id));
  if (!held) throw new HeldChangeError(`held change ${id} not found`);
  if (held.resolvedAt)
    throw new HeldChangeError(`held change ${id} was already ${held.resolution}`);
  if (resolution === 'apply') {
    const [item] = await db
      .select({ status: catalogItems.status })
      .from(catalogItems)
      .where(eq(catalogItems.id, held.itemId));
    if (item?.status !== held.fromStatus)
      throw new InvalidTransitionError(
        held.itemId,
        item?.status ?? '?',
        held.toStatus,
        `held from ${held.fromStatus}, but the item is now ${item?.status ?? 'missing'}`,
      );
    await transitionStatus(
      db,
      held.itemId,
      held.toStatus,
      actorSchema.parse(held.actor),
      `${held.reason} (held: ${held.trigger}; applied by ${owner})`,
      held.block ? { block: held.block } : {},
    );
  }
  const [done] = await db
    .update(heldChanges)
    .set({
      resolvedAt: new Date(),
      resolution: resolution === 'apply' ? 'applied' : 'dismissed',
      resolvedBy: owner,
    })
    .where(eq(heldChanges.id, id))
    .returning();
  return done!;
}
