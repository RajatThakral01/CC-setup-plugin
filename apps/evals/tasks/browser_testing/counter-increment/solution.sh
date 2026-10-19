#!/usr/bin/env bash
set -euo pipefail
sed -i 's/setCount((c) => c)/setCount((c) => c + 1)/' components/counter.tsx
