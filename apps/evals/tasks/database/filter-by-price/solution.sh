#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/api/products/route.ts')"
cat > 'app/api/products/route.ts' <<'CCSA_EOF'
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('maxPrice');
  const max = raw === null ? null : Number(raw);
  if (raw !== null && (raw.trim() === '' || !Number.isFinite(max) || max! < 0))
    return Response.json({ error: 'invalid maxPrice' }, { status: 400 });
  const rows = (
    max === null
      ? db().prepare('SELECT id, name, price_cents, stock FROM products ORDER BY id').all()
      : db()
          .prepare('SELECT id, name, price_cents, stock FROM products WHERE price_cents <= ? ORDER BY id')
          .all(Math.round(max * 100))
  ) as Array<{ id: number; name: string; price_cents: number; stock: number }>;
  return Response.json({
    products: rows.map((r) => ({ id: r.id, name: r.name, price: r.price_cents / 100, stock: r.stock })),
  });
}
CCSA_EOF
