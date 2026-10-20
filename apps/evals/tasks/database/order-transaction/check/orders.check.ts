import { expect, test } from '@playwright/test';

const stockOf = async (request: import('@playwright/test').APIRequestContext, name: string) => {
  const body = (await (await request.get('/api/products')).json()) as {
    products: Array<{ name: string; stock: number }>;
  };
  return body.products.find((p) => p.name === name)!.stock;
};

test('an order over the stock changes nothing', async ({ request }) => {
  const res = await request.post('/api/orders', { data: { productId: 2, quantity: 5 } });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'insufficient stock' });
  expect(await stockOf(request, 'Oak Chair')).toBe(3);
  expect(await (await request.get('/api/orders')).json()).toEqual({ count: 0 });
});

test('a valid order is recorded and the stock goes down', async ({ request }) => {
  expect(
    (await request.post('/api/orders', { data: { productId: 2, quantity: 2 } })).status(),
  ).toBe(201);
  expect(await stockOf(request, 'Oak Chair')).toBe(1);
  expect(await (await request.get('/api/orders')).json()).toEqual({ count: 1 });
  expect(
    (await request.post('/api/orders', { data: { productId: 2, quantity: 2 } })).status(),
  ).toBe(409);
  expect(await stockOf(request, 'Oak Chair')).toBe(1);
});
