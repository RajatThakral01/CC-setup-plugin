#!/usr/bin/env bash
set -euo pipefail
sed -i 's/includes(query.trim()))/includes(query.trim().toLowerCase()))/' components/product-list.tsx
