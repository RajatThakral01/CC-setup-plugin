import { expect, test } from '@playwright/test';

for (const [term, expected] of [
  ['lamp', 'Desk Lamp'],
  ['MUG', 'Ceramic Mug'],
  ['Oak', 'Oak Chair'],
] as const) {
  test(`searching "${term}" finds ${expected}`, async ({ page }) => {
    await page.goto('/products');
    await page.getByLabel('Search').fill(term);
    const items = page.getByRole('list', { name: 'Products' }).getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveText(expected);
  });
}

test('an empty search shows every product', async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByRole('list', { name: 'Products' }).getByRole('listitem')).toHaveCount(5);
});
