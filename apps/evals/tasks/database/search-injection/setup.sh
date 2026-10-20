#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'lib/db.ts')"
cat > 'lib/db.ts' <<'CCSA_EOF'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let instance: DatabaseSync | null = null;

/** The shop database (data/shop.db), migrated on first use from db/migrations/*.sql in name order. */
export function db(): DatabaseSync {
  if (instance) return instance;
  const dir = join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const d = new DatabaseSync(join(dir, 'shop.db'));
  d.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const done = new Set(
    (d.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const migrations = join(process.cwd(), 'db', 'migrations');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    d.exec('BEGIN');
    try {
      d.exec(readFileSync(join(migrations, file), 'utf8'));
      d.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      d.exec('COMMIT');
    } catch (error) {
      d.exec('ROLLBACK');
      throw error;
    }
  }
  instance = d;
  return d;
}
CCSA_EOF
mkdir -p "$(dirname 'db/migrations/001_init.sql')"
cat > 'db/migrations/001_init.sql' <<'CCSA_EOF'
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL
);
INSERT INTO products (name, price_cents, stock) VALUES
  ('Desk Lamp', 3500, 10),
  ('Oak Chair', 12000, 3),
  ('Linen Throw', 4500, 8),
  ('Ceramic Mug', 1200, 25),
  ('Wool Rug', 8900, 2);
CREATE TABLE subscribers (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity INTEGER NOT NULL
);
CCSA_EOF
grep -qx 'data/' .gitignore || echo 'data/' >> .gitignore
mkdir -p "$(dirname 'app/api/search/route.ts')"
cat > 'app/api/search/route.ts' <<'CCSA_EOF'
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  const rows = db()
    .prepare(`SELECT name FROM products WHERE lower(name) LIKE '%${q.toLowerCase()}%' ORDER BY id`)
    .all() as Array<{ name: string }>;
  return Response.json({ products: rows.map((r) => r.name) });
}
CCSA_EOF
