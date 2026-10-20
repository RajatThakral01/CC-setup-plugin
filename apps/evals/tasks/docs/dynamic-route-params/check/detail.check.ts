import { expect, test } from '@playwright/test';

for (const [slug, name] of [
  ['oak-chair', 'Oak Chair'],
  ['wool-rug', 'Wool Rug'],
  ['desk-lamp', 'Desk Lamp'],
] as const) {
  test(`/products/${slug} shows ${name}`, async ({ page }) => {
    const res = await page.goto(`/products/${slug}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  });
}
