import { readFile } from 'node:fs/promises';
import {
  ConfigError,
  requireSecret,
  sha256Hex,
  signBytes,
  verifyBytes,
  AppError,
  type Logger,
} from '@cc-setup-agent/core';
import {
  and,
  catalogItems,
  desc,
  eq,
  inArray,
  itemVersions,
  ne,
  scorecards,
  setupEvals,
  snapshots,
  sql,
  type Db,
} from '@cc-setup-agent/db';
import {
  SNAPSHOT_PUBLIC_KEY_PEM,
  SNAPSHOT_STATUSES,
  type AppConfig,
  type Snapshot,
} from '@cc-setup-agent/shared';
import {
  buildSnapshot,
  nextSnapshotVersion,
  serializeSnapshot,
  type SnapshotSource,
} from './build.js';
import type { SnapshotStore } from './store.js';

export class SigningKeyMismatchError extends AppError {}

export interface SnapshotReport {
  version: string;
  itemCount: number;
  sha256: string;
  location: string;
  skipped: Array<{ id: string; reason: string }>;
  byStatus: Record<string, number>;
}

async function loadSources(db: Db): Promise<SnapshotSource[]> {
  const items = await db
    .select()
    .from(catalogItems)
    .where(inArray(catalogItems.status, [...SNAPSHOT_STATUSES]));
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return [];
  const cards = await db
    .select()
    .from(scorecards)
    .where(inArray(scorecards.itemId, ids))
    .orderBy(desc(scorecards.updatedAt));
  const pinned = await db
    .select()
    .from(itemVersions)
    .where(and(inArray(itemVersions.itemId, ids), eq(itemVersions.pinned, true)));
  return items.map((item) => {
    const version = pinned.find((p) => p.itemId === item.id)?.version ?? null;
    const scorecard =
      cards.find((c) => c.itemId === item.id && (version === null || c.version === version)) ??
      cards.find((c) => c.itemId === item.id) ??
      null;
    return { item, scorecard, pinnedVersion: version };
  });
}

/** Blocked versions of items that are no longer blocked themselves (PRD FR-P10). */
async function latestSetupEval(db: Db): Promise<Snapshot['setupEval']> {
  const [row] = await db
    .select({ summary: setupEvals.summary })
    .from(setupEvals)
    .orderBy(desc(setupEvals.createdAt))
    .limit(1);
  return row?.summary ?? null;
}

async function loadBlockedVersions(db: Db): Promise<Snapshot['blockedVersions']> {
  const rows = await db
    .select()
    .from(catalogItems)
    .where(
      and(
        ne(catalogItems.status, 'blocked'),
        sql`cardinality(${catalogItems.blockedVersions}) > 0`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    package: r.install?.package ?? r.packageName,
    sourceUrl: r.sourceUrl,
    versions: r.blockedVersions,
    reason: 'blocked for security; a newer version fixed it',
  }));
}

/**
 * Builds, signs and publishes a catalog snapshot (plan M6, NFR-5). Refuses to publish if the
 * private key does not match the public key embedded in the plugin.
 */
export async function publishSnapshot(
  deps: { db: Db; config: AppConfig; store: SnapshotStore; logger: Logger },
  options: { now?: Date; publicKeyPem?: string } = {},
): Promise<SnapshotReport> {
  const now = options.now ?? new Date();
  const privateKeyPem = await readFile(
    requireSecret(deps.config, 'SNAPSHOT_SIGNING_KEY_PATH'),
    'utf8',
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        'SNAPSHOT_SIGNING_KEY_PATH points to a file that does not exist. Set it to the path printed by `pnpm keys:generate`.',
        ['SNAPSHOT_SIGNING_KEY_PATH'],
      );
    }
    throw error;
  });
  const existing = (await deps.db.select({ version: snapshots.version }).from(snapshots)).map(
    (s) => s.version,
  );
  const version = nextSnapshotVersion(now, existing);
  const { snapshot, skipped } = buildSnapshot(
    await loadSources(deps.db),
    version,
    now,
    await loadBlockedVersions(deps.db),
    await latestSetupEval(deps.db),
  );
  const bytes = serializeSnapshot(snapshot);
  const signature = signBytes(privateKeyPem, bytes);
  if (!verifyBytes(options.publicKeyPem ?? SNAPSHOT_PUBLIC_KEY_PEM, bytes, signature)) {
    throw new SigningKeyMismatchError(
      'The signing key does not match the public key embedded in packages/shared. Re-run pnpm keys:generate or fix SNAPSHOT_SIGNING_KEY_PATH.',
    );
  }
  const sha256 = sha256Hex(bytes);
  const location = await deps.store.publish({ version, catalog: bytes, signature, sha256 });
  await deps.db.insert(snapshots).values({
    version,
    createdAt: now,
    itemCount: snapshot.items.length,
    sha256,
    publishedUrl: location,
  });
  const byStatus: Record<string, number> = {};
  for (const item of snapshot.items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  for (const s of skipped) deps.logger.warn(s, 'item left out of snapshot');
  return { version, itemCount: snapshot.items.length, sha256, location, skipped, byStatus };
}
