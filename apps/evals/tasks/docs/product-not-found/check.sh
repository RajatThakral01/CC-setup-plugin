#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
bash .eval-check/stop-servers.sh
npx playwright test -c .eval-check/playwright.config.ts --reporter=line
