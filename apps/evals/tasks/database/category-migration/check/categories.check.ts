import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const app = join(__dirname, '..');

test('every product has its category, from a fresh database', async ({ request }) => {
  const body = (await (await request.get('/api/products')).json()) as {
    products: Array<{ name: string; category: string }>;
  };
  expect(Object.fromEntries(body.products.map((p) => [p.name, p.category]))).toEqual({
    'Desk Lamp': 'lighting',
    'Oak Chair': 'furniture',
    'Linen Throw': 'textiles',
    'Ceramic Mug': 'kitchen',
    'Wool Rug': 'textiles',
  });
});

test('the change is a new migration; 001_init.sql is untouched', () => {
  const files = readdirSync(join(app, 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
  expect(files.length).toBeGreaterThanOrEqual(2);
  const init = readFileSync(join(app, 'db', 'migrations', '001_init.sql'), 'utf8');
  expect(createHash('sha256').update(init).digest('hex')).toBe(
    createHash('sha256')
      .update(readFileSync(join(__dirname, 'init.sql.expected'), 'utf8'))
      .digest('hex'),
  );
});
