#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/api/products/route.ts')"
cat > 'app/api/products/route.ts' <<'CCSA_EOF'
const PRODUCTS = ['Desk Lamp', 'Oak Chair', 'Linen Throw', 'Ceramic Mug', 'Wool Rug'];

export function GET() {
  return Response.json({ products: PRODUCTS });
}
CCSA_EOF
