#!/usr/bin/env bash
set -euo pipefail
sed -i 's/setCount((c) => c + 1)/setCount((c) => c)/' components/counter.tsx
grep -q 'setCount((c) => c)' components/counter.tsx
