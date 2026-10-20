#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/api/orders/route.ts')"
cat > 'app/api/orders/route.ts' <<'CCSA_EOF'
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export function GET() {
  const row = db().prepare('SELECT count(*) AS n FROM orders').get() as { n: number };
  return Response.json({ count: row.n });
}

export async function POST(request: Request) {
  const { productId, quantity } = (await request.json()) as { productId: number; quantity: number };
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const updated = d
      .prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
      .run(quantity, productId, quantity);
    if (updated.changes === 0) {
      d.exec('ROLLBACK');
      return Response.json({ error: 'insufficient stock' }, { status: 409 });
    }
    d.prepare('INSERT INTO orders (product_id, quantity) VALUES (?, ?)').run(productId, quantity);
    d.exec('COMMIT');
  } catch (error) {
    d.exec('ROLLBACK');
    throw error;
  }
  return Response.json({ ok: true }, { status: 201 });
}
CCSA_EOF
