import { expect, test } from '@playwright/test';

test('each click adds one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Count: 0')).toBeVisible();
  const button = page.getByRole('button', { name: 'Add one' });
  for (let i = 0; i < 3; i++) await button.click();
  await expect(page.getByText('Count: 3')).toBeVisible();
});
