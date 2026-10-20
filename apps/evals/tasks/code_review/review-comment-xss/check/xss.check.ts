import { expect, test } from '@playwright/test';

test('review text is shown as text, never run as HTML', async ({ page }) => {
  await page.goto('/about');
  await page.waitForTimeout(500);
  await expect(page).not.toHaveTitle('pwned');
  const reviews = page.getByRole('list', { name: 'Reviews' }).getByRole('listitem');
  await expect(reviews).toHaveCount(3);
  await expect(reviews.nth(2)).toContainText('<img src="x"');
  await expect(page.locator('ul[aria-label="Reviews"] img')).toHaveCount(0);
});
