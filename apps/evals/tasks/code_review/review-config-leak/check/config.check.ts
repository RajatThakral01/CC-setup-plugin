import { expect, test } from '@playwright/test';

test('the config endpoint returns the site name and nothing secret', async ({ request }) => {
  const res = await request.get('/api/config');
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toMatchObject({ siteName: 'Example Shop' });
  expect(text).not.toContain('example-secret-token-123');
  expect(text).not.toContain('SECRET_API_TOKEN');
  expect(text).not.toContain('PATH');
});
