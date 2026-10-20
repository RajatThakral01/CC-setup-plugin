#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'proxy.ts')"
cat > 'proxy.ts' <<'CCSA_EOF'
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  return NextResponse.redirect(new URL('/products', request.url), 308);
}

export const config = { matcher: ['/shop', '/shop/:path*'] };
CCSA_EOF
