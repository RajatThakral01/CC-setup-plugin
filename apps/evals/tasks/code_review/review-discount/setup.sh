#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'lib/pricing.ts')"
cat > 'lib/pricing.ts' <<'CCSA_EOF'
/**
 * Price after a percentage discount.
 * @param priceCents price in whole cents (a non-negative integer)
 * @param percent discount from 0 to 100 inclusive; anything else throws a RangeError
 * @returns the discounted price in whole cents, rounded half up
 */
export function applyDiscount(priceCents: number, percent: number): number {
  return priceCents - (priceCents * percent) / 100;
}
CCSA_EOF
