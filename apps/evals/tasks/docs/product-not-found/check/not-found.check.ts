import { expect, test } from '@playwright/test';

test('an unknown product answers 404 with a helpful page', async ({ page }) => {
  const res = await page.goto('/products/no-such-thing');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Product not found');
  const back = page.locator('a[href="/products"]').filter({ hasNotText: /^Products$/ });
  await expect(back.first()).toBeVisible();
});

test('existing products still work', async ({ page }) => {
  const res = await page.goto('/products/oak-chair');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Oak Chair');
});
