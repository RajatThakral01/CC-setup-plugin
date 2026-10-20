#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
bash .eval-check/stop-servers.sh
# Every check starts from a fresh database: fixes must live in code and migrations.
rm -rf data
npx playwright test -c .eval-check/playwright.config.ts --reporter=line
