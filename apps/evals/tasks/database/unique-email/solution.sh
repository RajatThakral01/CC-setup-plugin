#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'db/migrations/002_unique_email.sql')"
cat > 'db/migrations/002_unique_email.sql' <<'CCSA_EOF'
CREATE UNIQUE INDEX subscribers_email_nocase ON subscribers (email COLLATE NOCASE);
CCSA_EOF
mkdir -p "$(dirname 'app/api/subscribe/route.ts')"
cat > 'app/api/subscribe/route.ts' <<'CCSA_EOF'
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const { email } = (await request.json()) as { email?: string };
  if (!email || !email.includes('@')) return Response.json({ error: 'invalid email' }, { status: 400 });
  try {
    db().prepare('INSERT INTO subscribers (email) VALUES (?)').run(email);
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE'))
      return Response.json({ error: 'already subscribed' }, { status: 409 });
    throw error;
  }
  return Response.json({ ok: true }, { status: 201 });
}
CCSA_EOF
