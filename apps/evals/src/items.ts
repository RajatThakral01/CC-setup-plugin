import { and, asc, catalogItems, eq, inArray, itemVersions, type DbOrTx } from '@cc-setup-agent/db';
import type { Category } from '@cc-setup-agent/shared';
import { EvalError } from './errors.js';
import type { EvalItem } from './tools.js';

/** Loads a catalog item with its pinned version (FR-E5: evals use exactly what was scored). */
export async function loadEvalItem(
  db: DbOrTx,
  id: string,
): Promise<EvalItem & { category: Category | null; status: string }> {
  const [row] = await db.select().from(catalogItems).where(eq(catalogItems.id, id));
  if (!row) throw new EvalError(`no catalog item ${id}`);
  const [pinned] = await db
    .select({ version: itemVersions.version })
    .from(itemVersions)
    .where(and(eq(itemVersions.itemId, id), eq(itemVersions.pinned, true)));
  const version = pinned?.version ?? row.install?.version;
  if (!version) throw new EvalError(`${id} has no pinned version; run the gates first`);
  return {
    id: row.id,
    kind: row.kind,
    install: row.install,
    version,
    sourceUrl: row.sourceUrl,
    contextOverheadTokens: row.contextOverheadTokens,
    category: row.category,
    status: row.status,
  };
}

/** The category's incumbent (FR-E4): a recommended item, else a provisional one; null if none. */
export async function findIncumbent(
  db: DbOrTx,
  category: Category,
  excludeId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: catalogItems.id, status: catalogItems.status })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.category, category),
        inArray(catalogItems.status, ['recommended', 'recommended_provisional']),
      ),
    )
    .orderBy(asc(catalogItems.id));
  const pick = (s: string) => rows.find((r) => r.status === s && r.id !== excludeId)?.id;
  return pick('recommended') ?? pick('recommended_provisional') ?? null;
}
