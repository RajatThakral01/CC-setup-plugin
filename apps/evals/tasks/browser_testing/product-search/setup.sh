#!/usr/bin/env bash
set -euo pipefail
sed -i 's/includes(query.trim().toLowerCase())/includes(query.trim())/' components/product-list.tsx
grep -q 'includes(query.trim()))' components/product-list.tsx
