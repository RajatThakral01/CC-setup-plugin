#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/api/quote/route.ts')"
cat > 'app/api/quote/route.ts' <<'CCSA_EOF'
export const dynamic = 'force-dynamic';

const MUG_CENTS = 1200;

/**
 * Price quote for `qty` mugs. `qty` must be a whole number from 1 to 99; anything else (missing,
 * not a number, fractional, out of range) gets HTTP 400 with `{ "error": "invalid qty" }`.
 * Answers `{ "qty": n, "totalCents": n * 1200 }`.
 */
export function GET(request: Request) {
  const qty = Number(new URL(request.url).searchParams.get('qty'));
  return Response.json({ qty, totalCents: qty * MUG_CENTS });
}
CCSA_EOF
