import {
  SNAPSHOT_STATUSES,
  snapshotSchema,
  type Snapshot,
  type SnapshotItem,
} from '@cc-setup-agent/shared';
import type { catalogItems, scorecards } from '@cc-setup-agent/db';

type ItemRow = typeof catalogItems.$inferSelect;
type ScorecardRow = typeof scorecards.$inferSelect;

export interface SnapshotSource {
  item: ItemRow;
  scorecard: ScorecardRow | null;
  pinnedVersion: string | null;
}

export interface BuildResult {
  snapshot: Snapshot;
  /** Items in a publishable status that could not be included, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

const PUBLISHABLE: ReadonlySet<string> = new Set(SNAPSHOT_STATUSES);

/** Next snapshot version for a UTC day: `YYYY.MM.DD-N`, N = 1 + snapshots already made that day. */
export function nextSnapshotVersion(now: Date, existingVersions: string[]): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '.');
  const taken = existingVersions
    .filter((v) => v.startsWith(`${day}-`))
    .map((v) => Number(v.slice(day.length + 1)))
    .filter(Number.isFinite);
  return `${day}-${(taken.length ? Math.max(...taken) : 0) + 1}`;
}

/**
 * Builds the snapshot (plan M6) from items in a publishable status. Candidate and rejected items
 * never appear; items that fail the schema (e.g. a recommended item with no install details) are
 * skipped and reported instead of breaking the snapshot. Output is sorted by id.
 */
export function buildSnapshot(sources: SnapshotSource[], version: string, now: Date): BuildResult {
  const skipped: BuildResult['skipped'] = [];
  const items: SnapshotItem[] = [];
  for (const { item, scorecard, pinnedVersion } of [...sources].sort((a, b) =>
    a.item.id.localeCompare(b.item.id),
  )) {
    if (!PUBLISHABLE.has(item.status)) continue;
    if (!item.kind || !item.provenance) {
      skipped.push({ id: item.id, reason: 'missing kind or provenance (not classified or gated)' });
      continue;
    }
    if (!scorecard) {
      skipped.push({ id: item.id, reason: 'no scorecard (run gates first)' });
      continue;
    }
    const candidate = {
      id: item.id,
      name: item.name,
      kind: item.kind,
      category: item.category,
      stacks: item.stacks,
      sourceUrl: item.sourceUrl,
      publisher: item.publisher,
      provenance: item.provenance,
      status: item.status,
      version: pinnedVersion ?? scorecard.version,
      install: item.install,
      capabilities: item.capabilities,
      contextOverheadTokens: item.contextOverheadTokens,
      supersedes: item.supersedes,
      supersededBy: item.supersededBy,
      scorecard: {
        confidence: scorecard.confidence,
        gates: scorecard.gateResults,
        securityFlags: scorecard.securityFindings.filter(
          (f) => f.severity === 'high' || f.severity === 'critical',
        ).length,
        reviewedAt: scorecard.reviewedAt?.toISOString() ?? null,
      },
      evalSummary: scorecard.evalSummary,
      lastChecked: (item.lastChecked ?? scorecard.updatedAt).toISOString(),
    };
    const parsed = snapshotSchema.shape.items.element.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    else
      skipped.push({
        id: item.id,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
  }
  const snapshot = snapshotSchema.parse({
    schemaVersion: 1,
    version,
    generatedAt: now.toISOString(),
    items,
  });
  return { snapshot, skipped };
}

/** Canonical bytes of a snapshot: the signature covers exactly these. */
export function serializeSnapshot(snapshot: Snapshot): Buffer {
  return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}
