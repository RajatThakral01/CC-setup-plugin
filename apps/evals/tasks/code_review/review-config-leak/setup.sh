#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname '.env')"
cat > '.env' <<'CCSA_EOF'
NEXT_PUBLIC_SITE_NAME=Example Shop
SECRET_API_TOKEN=example-secret-token-123
CCSA_EOF
mkdir -p "$(dirname 'app/api/config/route.ts')"
cat > 'app/api/config/route.ts' <<'CCSA_EOF'
export const dynamic = 'force-dynamic';

/** Client configuration for the browser. Returns everything so the client has what it needs. */
export function GET() {
  return Response.json({ siteName: process.env.NEXT_PUBLIC_SITE_NAME, env: process.env });
}
CCSA_EOF
