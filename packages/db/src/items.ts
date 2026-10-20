import { and, desc, eq } from 'drizzle-orm';
import {
  actorSchema,
  APPROVAL_TARGETS,
  checkTransition,
  FLAG_SEVERITIES,
  isHumanActor,
  isPolicyActor,
  type Actor,
  type Category,
  type Kind,
  type BlockCause,
  type SecurityFinding,
  type Status,
} from '@cc-setup-agent/shared';
import type { Db, DbOrTx } from './client.js';
import { InvalidTransitionError, ItemNotFoundError } from './errors.js';
import { catalogItems, itemVersions, scorecards, statusEvents } from './schema.js';

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
 * the item and writes the audit event in one transaction. Recommended statuses need a human or
 * the approval policy (`policy:<version>`, PRD 9.2a). The policy can never use an override note,
 * approve a security-flagged item or approve a vetoed one.
 */
export async function transitionStatus(
  db: Db,
  itemId: string,
  to: Status,
  actor: Actor,
  reason: string,
  options: TransitionOptions = {},
): Promise<{ from: Status; to: Status }> {
  return db.transaction((tx) => transitionInTx(tx, itemId, to, actor, reason, options));
}

export interface TransitionOptions {
  /** Required to approve an item whose latest scorecard failed the security gate (plan M4/M5). */
  overrideNote?: string;
  /** For `blocked`: why (PRD FR-P10). Without it the cause is `other`, which is never lifted. */
  block?: { cause: BlockCause; findings: string[] };
}

async function transitionInTx(
  tx: DbOrTx,
  itemId: string,
  to: Status,
  actor: Actor,
  reason: string,
  options: TransitionOptions,
): Promise<{ from: Status; to: Status }> {
  if (reason.trim() === '') {
    throw new InvalidTransitionError(itemId, '?', to, 'a reason is required');
  }
  const [row] = await tx
    .select({
      status: catalogItems.status,
      policyVeto: catalogItems.policyVeto,
      blockRecord: catalogItems.blockRecord,
      blockedVersions: catalogItems.blockedVersions,
    })
    .from(catalogItems)
    .where(eq(catalogItems.id, itemId))
    .for('update');
  if (!row) throw new ItemNotFoundError(itemId);
  const check = checkTransition(row.status, to, actor);
  if (!check.ok) throw new InvalidTransitionError(itemId, row.status, to, check.reason);
  const override = options.overrideNote?.trim();
  const byPolicy = isPolicyActor(actor);
  if (byPolicy && override)
    throw new InvalidTransitionError(
      itemId,
      row.status,
      to,
      'the policy cannot use override notes',
    );
  const [pin] = await tx
    .select({ version: itemVersions.version })
    .from(itemVersions)
    .where(and(eq(itemVersions.itemId, itemId), eq(itemVersions.pinned, true)));
  const pinned = pin?.version ?? null;
  // The policy may lift only its own vulnerable-dependency block, on a newer, unblocked version,
  // or a suspected injection (no review confirmed it; M10), whoever recorded the suspicion.
  if (byPolicy && row.status === 'blocked' && row.blockRecord?.cause !== 'suspected_injection') {
    const r = row.blockRecord;
    const why =
      !r || !isPolicyActor(r.by)
        ? 'the policy lifts only its own blocks'
        : r.cause !== 'vulnerable_dependency'
          ? `a ${r.cause} block is never lifted`
          : !pinned || pinned === r.version || row.blockedVersions.includes(pinned)
            ? 'no newer, unblocked version is pinned'
            : null;
    if (why) throw new InvalidTransitionError(itemId, row.status, to, why);
  }
  if (APPROVAL_TARGETS.has(to) && pinned && row.blockedVersions.includes(pinned))
    throw new InvalidTransitionError(itemId, row.status, to, `version ${pinned} is blocked`);
  let latest: { id: number; findings: SecurityFinding[] } | null = null;
  if (APPROVAL_TARGETS.has(to)) {
    const [card] = await tx
      .select({
        id: scorecards.id,
        gateResults: scorecards.gateResults,
        findings: scorecards.securityFindings,
      })
      .from(scorecards)
      .where(eq(scorecards.itemId, itemId))
      .orderBy(desc(scorecards.updatedAt))
      .limit(1);
    const flagged =
      card?.gateResults.gate3_security?.result === 'fail' ||
      (card?.findings ?? []).some((f) => FLAG_SEVERITIES.has(f.severity));
    if (byPolicy && flagged)
      throw new InvalidTransitionError(
        itemId,
        row.status,
        to,
        'the policy never approves flagged items',
      );
    if (byPolicy && row.policyVeto)
      throw new InvalidTransitionError(itemId, row.status, to, 'item is vetoed by the owner');
    if (card?.gateResults.gate3_security?.result === 'fail' && !override) {
      throw new InvalidTransitionError(
        itemId,
        row.status,
        to,
        'security flags need a written override note',
      );
    }
    latest = card ? { id: card.id, findings: card.findings } : null;
  }
  const now = new Date();
  const blocking =
    to === 'blocked'
      ? {
          blockRecord: {
            by: actor,
            cause: options.block?.cause ?? ('other' as const),
            version: pinned,
            findings: options.block?.findings ?? [],
            at: now.toISOString(),
          },
          // A suspicion doesn't block the version for good; only a confirmed or proven cause does.
          blockedVersions:
            pinned &&
            options.block?.cause !== 'suspected_injection' &&
            !row.blockedVersions.includes(pinned)
              ? [...row.blockedVersions, pinned]
              : row.blockedVersions,
        }
      : row.status === 'blocked'
        ? {
            blockRecord: null,
            // A human unblock overrules the block, so its version is no longer blocked; a policy
            // lift keeps it blocked for good (PRD FR-P10).
            ...(isHumanActor(actor) && row.blockRecord?.version
              ? {
                  blockedVersions: row.blockedVersions.filter(
                    (v) => v !== row.blockRecord!.version,
                  ),
                }
              : {}),
          }
        : {};
  await tx
    .update(catalogItems)
    .set({
      status: to,
      lastChecked: now,
      ...blocking,
      ...(override && latest
        ? {
            securityOverride: {
              by: actor,
              note: override,
              findings: latest.findings
                .filter((f) => FLAG_SEVERITIES.has(f.severity))
                .map((f) => f.description),
              at: now.toISOString(),
            },
          }
        : {}),
    })
    .where(eq(catalogItems.id, itemId));
  // The approval record on the scorecard (PRD 11.3): who approved, human or policy.
  if (latest)
    await tx
      .update(scorecards)
      .set({ reviewer: actor, reviewedAt: now })
      .where(eq(scorecards.id, latest.id));
  await tx.insert(statusEvents).values({
    itemId,
    fromStatus: row.status,
    toStatus: to,
    actor,
    reason: override ? `${reason} | override: ${override}` : reason,
  });
  return { from: row.status, to };
}

export class VetoError extends InvalidTransitionError {}

/**
 * Owner veto (PRD FR-P9): locks the item out of auto-approval and, if it is recommended or
 * provisional, demotes it to candidate, in one transaction. Otherwise the veto is audited as an
 * event with the same status on both sides. Human actors only.
 */
export async function vetoItem(
  db: Db,
  itemId: string,
  actor: Actor,
  reason: string,
): Promise<Status> {
  actorSchema.parse(actor);
  if (!isHumanActor(actor)) throw new VetoError(itemId, '?', 'veto', 'only the owner can veto');
  if (reason.trim() === '') throw new VetoError(itemId, '?', 'veto', 'a reason is required');
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ status: catalogItems.status })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .for('update');
    if (!item) throw new ItemNotFoundError(itemId);
    await tx
      .update(catalogItems)
      .set({ policyVeto: { by: actor, reason: reason.trim(), at: new Date().toISOString() } })
      .where(eq(catalogItems.id, itemId));
    if (APPROVAL_TARGETS.has(item.status)) {
      await transitionInTx(tx, itemId, 'candidate', actor, `owner veto: ${reason.trim()}`, {});
      return 'candidate';
    }
    await tx.insert(statusEvents).values({
      itemId,
      fromStatus: item.status,
      toStatus: item.status,
      actor,
      reason: `owner veto (locked out of auto-approval): ${reason.trim()}`,
    });
    return item.status;
  });
}

/** Lifts an owner veto; the item becomes eligible for the policy again. Audited. Human only. */
export async function liftVeto(
  db: Db,
  itemId: string,
  actor: Actor,
  reason: string,
): Promise<void> {
  actorSchema.parse(actor);
  if (!isHumanActor(actor))
    throw new VetoError(itemId, '?', 'veto', 'only the owner can lift a veto');
  if (reason.trim() === '') throw new VetoError(itemId, '?', 'veto', 'a reason is required');
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ status: catalogItems.status })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .for('update');
    if (!item) throw new ItemNotFoundError(itemId);
    await tx.update(catalogItems).set({ policyVeto: null }).where(eq(catalogItems.id, itemId));
    await tx.insert(statusEvents).values({
      itemId,
      fromStatus: item.status,
      toStatus: item.status,
      actor,
      reason: `owner veto lifted: ${reason.trim()}`,
    });
  });
}

export class InvalidClassificationEditError extends InvalidTransitionError {}

/**
 * Owner edit of kind and/or category (triage). Marks the fields as owner-set, so reclassification
 * never overwrites them, clears any pending reclassification review, and writes an audit event
 * (same status on both sides; the reason records the change). Human actors only.
 */
export async function setClassificationFields(
  db: Db,
  itemId: string,
  fields: { kind?: Kind; category?: Category | null; technologies?: string[] },
  actor: Actor,
  reason: string,
): Promise<void> {
  actorSchema.parse(actor);
  if (!actor.startsWith('human:'))
    throw new InvalidClassificationEditError(
      itemId,
      'kind/category',
      'owner-set',
      'human actor required',
    );
  if (reason.trim() === '')
    throw new InvalidClassificationEditError(
      itemId,
      'kind/category',
      'owner-set',
      'a reason is required',
    );
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        status: catalogItems.status,
        kind: catalogItems.kind,
        category: catalogItems.category,
      })
      .from(catalogItems)
      .where(eq(catalogItems.id, itemId))
      .for('update');
    if (!item) throw new ItemNotFoundError(itemId);
    const changes: string[] = [];
    const set: Partial<typeof catalogItems.$inferInsert> = { classificationReview: null };
    if (fields.kind !== undefined) {
      set.kind = fields.kind;
      set.kindSetBy = actor;
      changes.push(`kind ${item.kind ?? 'none'} → ${fields.kind}`);
    }
    if (fields.category !== undefined) {
      set.category = fields.category;
      set.categorySetBy = actor;
      changes.push(`category ${item.category ?? 'none'} → ${fields.category ?? 'none'}`);
    }
    if (fields.technologies !== undefined) {
      const techs = [...new Set(fields.technologies.map((t) => t.trim().toLowerCase()))]
        .filter(Boolean)
        .sort();
      set.technologies = techs;
      set.technologiesSetBy = actor;
      changes.push(`technologies → ${techs.join(', ') || 'none'}`);
    }
    await tx.update(catalogItems).set(set).where(eq(catalogItems.id, itemId));
    await tx.insert(statusEvents).values({
      itemId,
      fromStatus: item.status,
      toStatus: item.status,
      actor,
      reason: `classification set by owner (${changes.join(', ') || 'confirmed as is'}): ${reason.trim()}`,
    });
  });
}
