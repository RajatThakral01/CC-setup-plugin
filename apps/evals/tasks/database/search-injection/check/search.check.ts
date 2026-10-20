import { expect, test } from '@playwright/test';

const search = async (request: import('@playwright/test').APIRequestContext, q: string) => {
  const res = await request.get(`/api/search?q=${encodeURIComponent(q)}`);
  expect(res.status(), q).toBe(200);
  return ((await res.json()) as { products: string[] }).products;
};

test('search still works', async ({ request }) => {
  expect(await search(request, 'mug')).toEqual(['Ceramic Mug']);
  expect(await search(request, 'OAK')).toEqual(['Oak Chair']);
  expect(await search(request, 'l')).toEqual(
    ['Desk Lamp', 'Linen Throw', 'Ceramic Mug', 'Wool Rug'].filter((n) =>
      n.toLowerCase().includes('l'),
    ),
  );
});

test('input cannot change the query', async ({ request }) => {
  expect(await search(request, "' OR '1'='1")).toEqual([]);
  expect(await search(request, "x' UNION SELECT name FROM sqlite_master --")).toEqual([]);
  expect(await search(request, "o'")).toEqual([]);
});
