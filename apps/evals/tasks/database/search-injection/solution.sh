#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/api/search/route.ts')"
cat > 'app/api/search/route.ts' <<'CCSA_EOF'
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  const rows = db()
    .prepare("SELECT name FROM products WHERE instr(lower(name), lower(?)) > 0 ORDER BY id")
    .all(q) as Array<{ name: string }>;
  return Response.json({ products: rows.map((r) => r.name) });
}
CCSA_EOF
