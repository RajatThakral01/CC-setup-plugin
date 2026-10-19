#!/usr/bin/env bash
set -euo pipefail
sed -i 's#<Link href="/about">About</Link>#<Link href="/abuot">About</Link>#' app/layout.tsx
grep -q 'href="/abuot"' app/layout.tsx
