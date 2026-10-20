import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

test('duplicates are refused, in any letter case', async ({ request }) => {
  expect(
    (await request.post('/api/subscribe', { data: { email: 'ada@example.com' } })).status(),
  ).toBe(201);
  const dup = await request.post('/api/subscribe', { data: { email: 'ADA@Example.com' } });
  expect(dup.status()).toBe(409);
  expect(await dup.json()).toEqual({ error: 'already subscribed' });
  expect(
    (await request.post('/api/subscribe', { data: { email: 'grace@example.com' } })).status(),
  ).toBe(201);
  expect(await (await request.get('/api/subscribers')).json()).toEqual({ count: 2 });
});

test('the database itself refuses a duplicate', async ({ request }) => {
  await request.get('/api/subscribers'); // make sure the database exists and is migrated
  const d = new DatabaseSync(join(__dirname, '..', 'data', 'shop.db'));
  try {
    expect(() =>
      d
        .prepare('INSERT INTO subscribers (email) VALUES (?), (?)')
        .run('x@example.com', 'X@EXAMPLE.COM'),
    ).toThrow();
  } finally {
    d.close();
  }
});
