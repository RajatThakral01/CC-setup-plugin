import { expect, test } from '@playwright/test';

test('the About page has its own title and description', async ({ page }) => {
  await page.goto('/about');
  await expect(page).toHaveTitle('About · Example Shop');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Who we are and how the shop works.',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('About us');
});

test('other pages keep the site title', async ({ page }) => {
  for (const path of ['/', '/products', '/contact']) {
    await page.goto(path);
    await expect(page).toHaveTitle('Example Shop');
  }
});
