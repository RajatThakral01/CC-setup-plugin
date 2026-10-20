import { expect, test } from '@playwright/test';

test('GET /api/products returns the product names as JSON', async ({ request }) => {
  const res = await request.get('/api/products');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(await res.json()).toEqual({
    products: ['Desk Lamp', 'Oak Chair', 'Linen Throw', 'Ceramic Mug', 'Wool Rug'],
  });
});
