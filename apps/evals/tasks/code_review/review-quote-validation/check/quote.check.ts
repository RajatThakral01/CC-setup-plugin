import { expect, test } from '@playwright/test';

test('valid quantities are priced', async ({ request }) => {
  for (const [qty, total] of [
    [1, 1200],
    [3, 3600],
    [99, 118800],
  ]) {
    const res = await request.get(`/api/quote?qty=${qty}`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ qty, totalCents: total });
  }
});

test('invalid quantities get 400', async ({ request }) => {
  for (const q of ['', '?qty=', '?qty=0', '?qty=-1', '?qty=2.5', '?qty=abc', '?qty=100']) {
    const res = await request.get(`/api/quote${q}`);
    expect(res.status(), q || '(missing)').toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid qty' });
  }
});
