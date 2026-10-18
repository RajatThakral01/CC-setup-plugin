import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError, ItemNotFoundError } from './errors.js';
import { insertCandidate, transitionStatus } from './items.js';
import { catalogItems, statusEvents } from './schema.js';
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
    ).rejects.toThrow(/only a human/);
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
