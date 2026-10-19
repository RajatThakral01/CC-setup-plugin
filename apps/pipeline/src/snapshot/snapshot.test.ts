import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  generateSigningKeyPair,
  parseConfig,
  sha256Hex,
  signBytes,
  verifyBytes,
} from '@cc-setup-agent/core';
import {
  catalogItems,
  insertCandidate,
  itemVersions,
  scorecards,
  snapshots,
  statusEvents,
  transitionStatus,
} from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { snapshotSchema } from '@cc-setup-agent/shared';
import { buildSnapshot, nextSnapshotVersion, serializeSnapshot } from './build.js';
import { publishSnapshot, SigningKeyMismatchError } from './run.js';
import { GithubReleaseSnapshotStore, LocalSnapshotStore } from './store.js';

const now = new Date('2026-10-19T05:00:00Z');
const keys = generateSigningKeyPair();
let t: TestDatabase;
let keyPath: string;
beforeAll(async () => {
  t = await createTestDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'ccsa-keytest-'));
  keyPath = join(dir, 'key.pem');
  await writeFile(keyPath, keys.privateKeyPem, { mode: 0o600 });
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  for (const table of [snapshots, itemVersions, scorecards, statusEvents]) await t.db.delete(table);
  await t.db.delete(catalogItems);
});

const checkedAt = '2026-10-18T00:00:00.000Z';
async function seedItem(
  id: string,
  status: 'candidate' | 'recommended_provisional' | 'blocked' | 'rejected' | 'watchlist',
  extra: Partial<typeof catalogItems.$inferInsert> = {},
) {
  await insertCandidate(
    t.db,
    {
      id,
      name: id,
      sourceUrl: `https://github.com/example-org/${id}`,
      kind: 'mcp_server',
      category: 'browser_testing',
      stacks: ['nextjs'],
      provenance: 'official_vendor',
      install: { method: 'npx', package: `@example/${id}`, version: '1.0.0', envVars: [] },
      ...extra,
    },
    'system',
    'fixture',
  );
  await t.db
    .insert(scorecards)
    .values({
      itemId: id,
      version: '1.0.0',
      confidence: 'high',
      gateResults: { gate0_hygiene: { result: 'pass', evidence: [], checkedAt } },
    });
  await t.db.insert(itemVersions).values({ itemId: id, version: '1.0.0', pinned: true });
  if (status === 'recommended_provisional')
    await transitionStatus(t.db, id, status, 'human:owner', 'ok');
  else if (status !== 'candidate') await transitionStatus(t.db, id, status, 'system', 'fixture');
}

describe('signing', () => {
  it('verifies a signature and rejects a single tampered byte', () => {
    const data = Buffer.from('{"items":[]}\n');
    const sig = signBytes(keys.privateKeyPem, data);
    expect(verifyBytes(keys.publicKeyPem, data, sig)).toBe(true);
    const tampered = Buffer.from(data);
    tampered[3] = tampered[3]! ^ 0x01;
    expect(verifyBytes(keys.publicKeyPem, tampered, sig)).toBe(false);
    expect(verifyBytes(generateSigningKeyPair().publicKeyPem, data, sig)).toBe(false);
    expect(verifyBytes(keys.publicKeyPem, data, 'not-base64!')).toBe(false);
  });
});

describe('nextSnapshotVersion', () => {
  it('numbers snapshots per UTC day', () => {
    expect(nextSnapshotVersion(now, [])).toBe('2026.10.19-1');
    expect(nextSnapshotVersion(now, ['2026.10.19-1', '2026.10.19-2', '2026.10.18-5'])).toBe(
      '2026.10.19-3',
    );
  });
});

describe('publishSnapshot', () => {
  it('publishes only publishable statuses, signed, with a latest pointer', async () => {
    await seedItem('example-recommended', 'recommended_provisional');
    await seedItem('example-blocked', 'blocked', { install: null, category: null });
    await seedItem('example-watch', 'watchlist');
    await seedItem('example-candidate', 'candidate');
    await seedItem('example-rejected', 'rejected');
    const dir = await mkdtemp(join(tmpdir(), 'ccsa-snapshots-'));
    const config = parseConfig({ SNAPSHOT_SIGNING_KEY_PATH: keyPath });
    const report = await publishSnapshot(
      {
        db: t.db,
        config,
        store: new LocalSnapshotStore(dir),
        logger: createLogger({ level: 'silent' }),
      },
      { now, publicKeyPem: keys.publicKeyPem },
    );
    expect(report).toMatchObject({
      version: '2026.10.19-1',
      itemCount: 3,
      byStatus: { recommended_provisional: 1, blocked: 1, watchlist: 1 },
    });

    const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')) as {
      catalog: string;
      signature: string;
      sha256: string;
    };
    const bytes = await readFile(join(dir, latest.catalog));
    const sig = (await readFile(join(dir, latest.signature), 'utf8')).trim();
    expect(verifyBytes(keys.publicKeyPem, bytes, sig)).toBe(true);
    expect(sha256Hex(bytes)).toBe(latest.sha256);
    const snap = snapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
    expect(snap.items.map((i) => i.id)).toEqual([
      'example-blocked',
      'example-recommended',
      'example-watch',
    ]);
    expect(
      snap.items.some(
        (i) => (i.status as string) === 'candidate' || (i.status as string) === 'rejected',
      ),
    ).toBe(false);
    expect(report.location).toBe(
      `file://${fileURLToPath(new URL(`file://${join(dir, latest.catalog)}`))}`,
    );

    const second = await publishSnapshot(
      {
        db: t.db,
        config,
        store: new LocalSnapshotStore(dir),
        logger: createLogger({ level: 'silent' }),
      },
      { now, publicKeyPem: keys.publicKeyPem },
    );
    expect(second.version).toBe('2026.10.19-2');
    expect(await t.db.select().from(snapshots)).toHaveLength(2);
  });

  it('skips recommended items that lack install details instead of publishing them', async () => {
    await seedItem('example-incomplete', 'recommended_provisional', { install: null });
    const dir = await mkdtemp(join(tmpdir(), 'ccsa-snapshots-'));
    const report = await publishSnapshot(
      {
        db: t.db,
        config: parseConfig({ SNAPSHOT_SIGNING_KEY_PATH: keyPath }),
        store: new LocalSnapshotStore(dir),
        logger: createLogger({ level: 'silent' }),
      },
      { now, publicKeyPem: keys.publicKeyPem },
    );
    expect(report.itemCount).toBe(0);
    expect(report.skipped).toEqual([
      expect.objectContaining({
        id: 'example-incomplete',
        reason: expect.stringContaining('install'),
      }),
    ]);
  });

  it('refuses to publish when the key does not match the embedded public key', async () => {
    await expect(
      publishSnapshot(
        {
          db: t.db,
          config: parseConfig({ SNAPSHOT_SIGNING_KEY_PATH: keyPath }),
          store: new LocalSnapshotStore(tmpdir()),
          logger: createLogger({ level: 'silent' }),
        },
        { now, publicKeyPem: generateSigningKeyPair().publicKeyPem },
      ),
    ).rejects.toBeInstanceOf(SigningKeyMismatchError);
  });

  it('needs the signing key path', async () => {
    await expect(
      publishSnapshot(
        {
          db: t.db,
          config: parseConfig({}),
          store: new LocalSnapshotStore(tmpdir()),
          logger: createLogger({ level: 'silent' }),
        },
        { now },
      ),
    ).rejects.toThrow(/SNAPSHOT_SIGNING_KEY_PATH is not set/);
  });
});

describe('signing key errors', () => {
  it('explains a missing key file', async () => {
    await expect(
      publishSnapshot(
        {
          db: t.db,
          config: parseConfig({
            SNAPSHOT_SIGNING_KEY_PATH: join(tmpdir(), 'ccsa-no-such-key.pem'),
          }),
          store: new LocalSnapshotStore(tmpdir()),
          logger: createLogger({ level: 'silent' }),
        },
        { now },
      ),
    ).rejects.toThrow(/points to a file that does not exist/);
  });
});

describe('stores', () => {
  it('keeps the GitHub release store behind the interface but refuses to publish', async () => {
    await expect(new GithubReleaseSnapshotStore().publish()).rejects.toThrow(/not available yet/);
  });
  it('serializes deterministically', () => {
    const { snapshot } = buildSnapshot([], '2026.10.19-1', now);
    expect(serializeSnapshot(snapshot).equals(serializeSnapshot(snapshot))).toBe(true);
  });
});
