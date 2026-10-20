import { expect, test } from '@playwright/test';

const names = async (res: { json(): Promise<unknown> }) =>
  ((await res.json()) as { products: Array<{ name: string }> }).products.map((p) => p.name);

test('maxPrice filters by price', async ({ request }) => {
  expect(await names(await request.get('/api/products?maxPrice=40'))).toEqual([
    'Desk Lamp',
    'Ceramic Mug',
  ]);
  expect(await names(await request.get('/api/products?maxPrice=45'))).toEqual([
    'Desk Lamp',
    'Linen Throw',
    'Ceramic Mug',
  ]);
  expect(await names(await request.get('/api/products?maxPrice=0'))).toEqual([]);
});

test('without maxPrice every product is returned', async ({ request }) => {
  expect(await names(await request.get('/api/products'))).toHaveLength(5);
});

test('an invalid maxPrice is refused', async ({ request }) => {
  for (const bad of ['abc', '-5', '']) {
    const res = await request.get(`/api/products?maxPrice=${bad}`);
    expect(res.status(), bad).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid maxPrice' });
  }
});
