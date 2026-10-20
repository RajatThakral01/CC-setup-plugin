#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'db/migrations/002_categories.sql')"
cat > 'db/migrations/002_categories.sql' <<'CCSA_EOF'
ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized';
UPDATE products SET category = 'lighting' WHERE name = 'Desk Lamp';
UPDATE products SET category = 'furniture' WHERE name = 'Oak Chair';
UPDATE products SET category = 'textiles' WHERE name IN ('Linen Throw', 'Wool Rug');
UPDATE products SET category = 'kitchen' WHERE name = 'Ceramic Mug';
CCSA_EOF
mkdir -p "$(dirname 'app/api/products/route.ts')"
cat > 'app/api/products/route.ts' <<'CCSA_EOF'
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export function GET() {
  const rows = db()
    .prepare('SELECT id, name, price_cents, stock, category FROM products ORDER BY id')
    .all() as Array<{ id: number; name: string; price_cents: number; stock: number; category: string }>;
  return Response.json({
    products: rows.map((r) => ({
      id: r.id,
      name: r.name,
      price: r.price_cents / 100,
      stock: r.stock,
      category: r.category,
    })),
  });
}
CCSA_EOF
