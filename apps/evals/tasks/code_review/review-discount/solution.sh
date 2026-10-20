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
  if (!Number.isInteger(priceCents) || priceCents < 0)
    throw new RangeError('priceCents must be a non-negative integer');
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new RangeError('percent must be between 0 and 100');
  return Math.floor((priceCents * (100 - percent)) / 100 + 0.5);
}
CCSA_EOF
