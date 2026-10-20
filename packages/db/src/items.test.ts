import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError, ItemNotFoundError } from './errors.js';
import {
  insertCandidate,
  liftVeto,
  setClassificationFields,
  transitionStatus,
  vetoItem,
} from './items.js';
import { catalogItems, itemVersions, scorecards, statusEvents } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.cleanup();
});

let n = 0;
async function newItem(): Promise<string> {
  const id = `example-mcp-${++n}`;
  await insertCandidate(
    t.db,
    { id, name: `Example MCP ${n}`, sourceUrl: `https://example.test/org/${id}` },
    'system',
    'fixture',
  );
  return id;
}

const events = (itemId: string) =>
  t.db.select().from(statusEvents).where(eq(statusEvents.itemId, itemId)).orderBy(statusEvents.id);
const statusOf = async (itemId: string) =>
  (await t.db.select().from(catalogItems).where(eq(catalogItems.id, itemId)))[0]?.status;

describe('insertCandidate', () => {
  it('creates a candidate and logs the creation', async () => {
    const id = await newItem();
    expect(await statusOf(id)).toBe('candidate');
    const log = await events(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'candidate',
      actor: 'system',
      reason: 'fixture',
    });
  });

  it('ignores any status smuggled in by the caller', async () => {
    const id = 'example-mcp-smuggled';
    const smuggled = { id, name: 'x', sourceUrl: 'https://example.test/s', status: 'recommended' };
    await insertCandidate(
      t.db,
      smuggled as Parameters<typeof insertCandidate>[1],
      'system',
      'fixture',
    );
    expect(await statusOf(id)).toBe('candidate');
  });
});

describe('transitionStatus', () => {
  it('applies a valid transition and writes the audit event', async () => {
    const id = await newItem();
    await expect(transitionStatus(t.db, id, 'watchlist', 'system', 'no commits')).resolves.toEqual({
      from: 'candidate',
      to: 'watchlist',
    });
    expect(await statusOf(id)).toBe('watchlist');
    expect((await events(id)).at(-1)).toMatchObject({
      fromStatus: 'candidate',
      toStatus: 'watchlist',
      actor: 'system',
      reason: 'no commits',
    });
  });

  it('refuses recommended by system and leaves no trace', async () => {
    const id = await newItem();
    await expect(
      transitionStatus(t.db, id, 'recommended', 'system', 'auto'),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(
      transitionStatus(t.db, id, 'recommended_provisional', 'system', 'auto'),
    ).rejects.toThrow(/only a human or the approval policy/);
    expect(await statusOf(id)).toBe('candidate');
    expect(await events(id)).toHaveLength(1);
  });

  it('lets a human approve to recommended_provisional', async () => {
    const id = await newItem();
    await transitionStatus(t.db, id, 'recommended_provisional', 'human:owner', 'gates pass');
    expect(await statusOf(id)).toBe('recommended_provisional');
    expect((await events(id)).at(-1)?.actor).toBe('human:owner');
  });

  it('throws on transitions outside the table', async () => {
    const id = await newItem();
    await transitionStatus(t.db, id, 'blocked', 'system', 'poisoned description');
    await expect(transitionStatus(t.db, id, 'recommended', 'human:owner', 'oops')).rejects.toThrow(
      /blocked to recommended/,
    );
    await expect(transitionStatus(t.db, id, 'candidate', 'system', 'retry')).rejects.toThrow(
      /only a human/,
    );
  });

  it('requires a reason', async () => {
    const id = await newItem();
    await expect(transitionStatus(t.db, id, 'watchlist', 'system', '  ')).rejects.toThrow(/reason/);
  });

  it('throws for unknown items', async () => {
    await expect(
      transitionStatus(t.db, 'example-missing', 'watchlist', 'system', 'x'),
    ).rejects.toBeInstanceOf(ItemNotFoundError);
  });
});

describe('setClassificationFields', () => {
  it('sets kind and category as owner-set, clears the review flag and audits it', async () => {
    const id = await newItem();
    await t.db
      .update(catalogItems)
      .set({
        kind: 'plugin',
        category: 'git_github',
        classificationReview: {
          previousKind: 'plugin',
          previousCategory: 'code_review',
          promptVersion: 'classify-v3',
          changedAt: '2026-10-19T00:00:00.000Z',
        },
      })
      .where(eq(catalogItems.id, id));
    await setClassificationFields(
      t.db,
      id,
      { category: null },
      'human:owner',
      'chat bridge, no category fits',
    );
    const [row] = await t.db.select().from(catalogItems).where(eq(catalogItems.id, id));
    expect(row).toMatchObject({
      kind: 'plugin',
      category: null,
      categorySetBy: 'human:owner',
      kindSetBy: null,
      classificationReview: null,
    });
    expect((await events(id)).at(-1)).toMatchObject({
      fromStatus: 'candidate',
      toStatus: 'candidate',
      actor: 'human:owner',
      reason:
        'classification set by owner (category git_github → none): chat bridge, no category fits',
    });
  });

  it('refuses system actors, empty reasons and unknown items', async () => {
    const id = await newItem();
    await expect(
      setClassificationFields(t.db, id, { kind: 'skill' }, 'system', 'x'),
    ).rejects.toThrow(/human actor required/);
    await expect(
      setClassificationFields(t.db, id, { kind: 'skill' }, 'human:owner', ' '),
    ).rejects.toThrow(/reason is required/);
    await expect(
      setClassificationFields(t.db, 'example-missing', { kind: 'skill' }, 'human:owner', 'x'),
    ).rejects.toBeInstanceOf(ItemNotFoundError);
  });
});

async function scored(
  id: string,
  gate3: 'pass' | 'fail',
  findings: Array<{ severity: 'high' | 'low'; description: string }> = [],
) {
  const g = (result: 'pass' | 'fail') => ({
    result,
    evidence: [],
    checkedAt: new Date().toISOString(),
  });
  await t.db.insert(scorecards).values({
    itemId: id,
    version: '1.0.0',
    gateResults: { gate0_hygiene: g('pass'), gate3_security: g(gate3) },
    securityFindings: findings,
    confidence: 'high',
  });
}

describe('approval by the policy (PRD 9.2a)', () => {
  it('lets the policy approve, audits the policy actor and records the reviewer', async () => {
    const id = await newItem();
    await scored(id, 'pass');
    await transitionStatus(
      t.db,
      id,
      'recommended_provisional',
      'policy:policy-v1',
      'all criteria hold',
    );
    expect(await statusOf(id)).toBe('recommended_provisional');
    expect((await events(id)).at(-1)).toMatchObject({
      actor: 'policy:policy-v1',
      reason: 'all criteria hold',
    });
    const [card] = await t.db.select().from(scorecards).where(eq(scorecards.itemId, id));
    expect(card?.reviewer).toBe('policy:policy-v1');
    expect(card?.reviewedAt).toBeInstanceOf(Date);
  });

  it('never lets the policy approve a flagged item, with or without a note', async () => {
    const id = await newItem();
    await scored(id, 'fail', [{ severity: 'high', description: 'vulnerable dependency' }]);
    await expect(
      transitionStatus(t.db, id, 'recommended_provisional', 'policy:policy-v1', 'auto'),
    ).rejects.toThrow(/never approves flagged/);
    await expect(
      transitionStatus(t.db, id, 'recommended_provisional', 'policy:policy-v1', 'auto', {
        overrideNote: 'fine',
      }),
    ).rejects.toThrow(/cannot use override notes/);
    // A high finding alone (gate 3 not failed) is a flag too.
    const other = await newItem();
    await scored(other, 'pass', [{ severity: 'high', description: 'x' }]);
    await expect(
      transitionStatus(t.db, other, 'recommended_provisional', 'policy:policy-v1', 'auto'),
    ).rejects.toThrow(/flagged/);
    expect(await statusOf(id)).toBe('candidate');
  });

  it('records the findings an owner accepted with an override', async () => {
    const id = await newItem();
    await scored(id, 'fail', [
      { severity: 'high', description: 'vulnerable dependency' },
      { severity: 'low', description: 'long description' },
    ]);
    await transitionStatus(t.db, id, 'recommended_provisional', 'human:owner', 'reviewed', {
      overrideNote: 'dev-only dependency',
    });
    const [row] = await t.db.select().from(catalogItems).where(eq(catalogItems.id, id));
    expect(row?.securityOverride).toMatchObject({
      by: 'human:owner',
      note: 'dev-only dependency',
      findings: ['vulnerable dependency'],
    });
  });
});

describe('owner veto (PRD FR-P9)', () => {
  it('demotes an approved item to candidate and locks it out of policy approval', async () => {
    const id = await newItem();
    await scored(id, 'pass');
    await transitionStatus(t.db, id, 'recommended_provisional', 'policy:policy-v1', 'auto');
    expect(await vetoItem(t.db, id, 'human:owner', 'misleading README')).toBe('candidate');
    expect(await statusOf(id)).toBe('candidate');
    expect((await events(id)).at(-1)).toMatchObject({
      fromStatus: 'recommended_provisional',
      toStatus: 'candidate',
      actor: 'human:owner',
      reason: 'owner veto: misleading README',
    });
    await expect(
      transitionStatus(t.db, id, 'recommended_provisional', 'policy:policy-v1', 'auto'),
    ).rejects.toThrow(/vetoed/);
    // The owner can still approve it by hand, and can lift the veto.
    await liftVeto(t.db, id, 'human:owner', 'fixed upstream');
    expect((await events(id)).at(-1)?.reason).toBe('owner veto lifted: fixed upstream');
    await transitionStatus(t.db, id, 'recommended_provisional', 'policy:policy-v1', 'auto');
    expect(await statusOf(id)).toBe('recommended_provisional');
  });

  it('audits a veto on a candidate without changing its status', async () => {
    const id = await newItem();
    expect(await vetoItem(t.db, id, 'human:owner', 'not useful')).toBe('candidate');
    expect((await events(id)).at(-1)).toMatchObject({
      fromStatus: 'candidate',
      toStatus: 'candidate',
      reason: 'owner veto (locked out of auto-approval): not useful',
    });
  });

  it('refuses non-human actors and empty reasons', async () => {
    const id = await newItem();
    await expect(vetoItem(t.db, id, 'policy:policy-v1', 'x')).rejects.toThrow(/only the owner/);
    await expect(vetoItem(t.db, id, 'human:owner', ' ')).rejects.toThrow(/reason/);
    await expect(liftVeto(t.db, id, 'system', 'x')).rejects.toThrow(/only the owner/);
    await expect(vetoItem(t.db, 'example-missing', 'human:owner', 'x')).rejects.toBeInstanceOf(
      ItemNotFoundError,
    );
  });
});

describe('blocks and lifts (PRD FR-P10)', () => {
  async function pinned(id: string, version: string) {
    await t.db.update(itemVersions).set({ pinned: false }).where(eq(itemVersions.itemId, id));
    await t.db
      .insert(itemVersions)
      .values({ itemId: id, version, pinned: true })
      .onConflictDoUpdate({
        target: [itemVersions.itemId, itemVersions.version],
        set: { pinned: true },
      });
  }
  const row = async (id: string) =>
    (await t.db.select().from(catalogItems).where(eq(catalogItems.id, id)))[0]!;

  it('records the cause and blocks the pinned version for good', async () => {
    const id = await newItem();
    await pinned(id, '1.0.0');
    await transitionStatus(t.db, id, 'blocked', 'policy:policy-v2', 'new CVE', {
      block: { cause: 'vulnerable_dependency', findings: ['CVE in dep'] },
    });
    expect(await row(id)).toMatchObject({
      blockedVersions: ['1.0.0'],
      blockRecord: { by: 'policy:policy-v2', cause: 'vulnerable_dependency', version: '1.0.0' },
    });
  });

  it('lets the policy lift only its own vulnerable-dependency block, on a newer version', async () => {
    const id = await newItem();
    await pinned(id, '1.0.0');
    await transitionStatus(t.db, id, 'blocked', 'policy:policy-v2', 'new CVE', {
      block: { cause: 'vulnerable_dependency', findings: ['CVE'] },
    });
    await expect(
      transitionStatus(t.db, id, 'candidate', 'policy:policy-v2', 'lift'),
    ).rejects.toThrow(/no newer, unblocked version/);
    await pinned(id, '1.0.1');
    await transitionStatus(t.db, id, 'candidate', 'policy:policy-v2', 'lift: 1.0.1 fixes it');
    const after = await row(id);
    expect(after).toMatchObject({
      status: 'candidate',
      blockRecord: null,
      blockedVersions: ['1.0.0'],
    });
    // The blocked version can never be approved again.
    await pinned(id, '1.0.0');
    await expect(
      transitionStatus(t.db, id, 'recommended_provisional', 'human:owner', 'x'),
    ).rejects.toThrow(/version 1.0.0 is blocked/);
  });

  it('never lifts injection blocks, blocks by others, or blocks without a cause', async () => {
    for (const [actor, cause] of [
      ['policy:policy-v2', 'injection'],
      ['system', 'vulnerable_dependency'],
      ['human:owner', 'vulnerable_dependency'],
    ] as const) {
      const id = await newItem();
      await pinned(id, '1.0.0');
      await transitionStatus(t.db, id, 'blocked', actor, 'x', { block: { cause, findings: [] } });
      await pinned(id, '2.0.0');
      await expect(
        transitionStatus(t.db, id, 'candidate', 'policy:policy-v2', 'lift'),
      ).rejects.toThrow(InvalidTransitionError);
    }
    const id = await newItem();
    await transitionStatus(t.db, id, 'blocked', 'policy:policy-v2', 'x');
    expect((await row(id)).blockRecord?.cause).toBe('other');
    // A human can always unblock, and that overrules the block: its version is no longer blocked.
    const h = await newItem();
    await pinned(h, '3.0.0');
    await transitionStatus(t.db, h, 'blocked', 'system', 'x', {
      block: { cause: 'injection', findings: [] },
    });
    expect((await row(h)).blockedVersions).toEqual(['3.0.0']);
    await transitionStatus(t.db, h, 'candidate', 'human:owner', 'false positive');
    expect((await row(h)).blockedVersions).toEqual([]);
  });
});
