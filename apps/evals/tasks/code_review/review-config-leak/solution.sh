#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/api/config/route.ts')"
cat > 'app/api/config/route.ts' <<'CCSA_EOF'
export const dynamic = 'force-dynamic';

/** Client configuration for the browser: public values only. */
export function GET() {
  return Response.json({ siteName: process.env.NEXT_PUBLIC_SITE_NAME });
}
CCSA_EOF
