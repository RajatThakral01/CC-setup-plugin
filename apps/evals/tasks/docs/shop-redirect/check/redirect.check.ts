import { expect, test, type APIRequestContext } from '@playwright/test';

/** Follows redirects by hand: every hop must be permanent (308). Returns the final path. */
async function permanentTarget(request: APIRequestContext, path: string): Promise<string> {
  let current = path;
  for (let hop = 0; hop < 3; hop++) {
    const res = await request.get(current, { maxRedirects: 0 });
    if (res.status() !== 308) {
      expect(hop, `${path}: first answer was ${res.status()}, not a 308 redirect`).toBeGreaterThan(
        0,
      );
      return current;
    }
    current = new URL(res.headers()['location']!, 'http://127.0.0.1').pathname;
  }
  return current;
}

// `/shop/` first gets Next.js's own trailing-slash 308 to `/shop`; the chain must still end at /products.
for (const path of ['/shop', '/shop/', '/shop/sale/2024']) {
  test(`${path} redirects permanently to /products`, async ({ request }) => {
    expect(await permanentTarget(request, path)).toBe('/products');
  });
}

test('other paths are untouched', async ({ request }) => {
  for (const path of ['/', '/products', '/about', '/shopping']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).not.toBe(308);
  }
});
