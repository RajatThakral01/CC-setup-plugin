import { expect, test } from '@playwright/test';

test('a valid submission shows the thank-you message', async ({ page }) => {
  await page.goto('/contact');
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText(/Thanks, Ada!/);
});

test('an invalid email shows the error', async ({ page }) => {
  await page.goto('/contact');
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Send' }).click();
  // Not getByRole('alert'): Next.js renders its own route announcer with role="alert".
  await expect(page.getByText('Please enter your name and a valid email.')).toBeVisible();
});
