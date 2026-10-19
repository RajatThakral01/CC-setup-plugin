#!/usr/bin/env bash
set -euo pipefail
cat > e2e/contact.spec.ts <<'SPEC'
import { expect, test } from '@playwright/test';

test('valid submission shows the thank-you message', async ({ page }) => {
  await page.goto('/contact');
  await page.getByLabel('Name').fill('Grace');
  await page.getByLabel('Email').fill('grace@example.com');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Thanks, Grace!');
});

test('invalid email shows the error', async ({ page }) => {
  await page.goto('/contact');
  await page.getByLabel('Name').fill('Grace');
  await page.getByLabel('Email').fill('nope');
  await page.getByRole('button', { name: 'Send' }).click();
  // Not getByRole('alert'): Next.js renders its own route announcer with role="alert".
  await expect(page.getByText('Please enter your name and a valid email.')).toBeVisible();
});
SPEC
