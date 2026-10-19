#!/usr/bin/env bash
set -euo pipefail
sed -i 's#href="/abuot"#href="/about"#' app/layout.tsx
