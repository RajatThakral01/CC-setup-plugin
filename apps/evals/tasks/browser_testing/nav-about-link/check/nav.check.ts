import { expect, test } from '@playwright/test';

test('header About link opens the About page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'About' }).click();
  await expect(page.getByRole('heading', { name: 'About us' })).toBeVisible();
});

test('other header links still work', async ({ page }) => {
  await page.goto('/about');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Products' })
    .click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
});
