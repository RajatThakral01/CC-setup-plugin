#!/usr/bin/env bash
# Pass = the agent's test exists, passes on the real app, and fails on each of two broken apps
# (thank-you message changed; validation error never shown).
set -uo pipefail
cd "$(dirname "$0")/.."
bash .eval-check/stop-servers.sh
test -f e2e/contact.spec.ts || { echo "e2e/contact.spec.ts is missing"; exit 1; }
run() { npx playwright test -c .eval-check/e2e.config.ts --reporter=line; }
run || { echo "the test fails on the working app"; exit 1; }
F=components/contact-form.tsx
cp "$F" /tmp/contact-form.orig
sed -i 's/Thanks, {sentTo}! We will reply soon./Message received./' "$F"
if run; then echo "the test passes on an app without the thank-you message"; cp /tmp/contact-form.orig "$F"; exit 1; fi
cp /tmp/contact-form.orig "$F"
sed -i 's/{error && <p role="alert">{error}<\/p>}//' "$F"
sed -i "s/setError('Please enter your name and a valid email.');/setSentTo(name);/" "$F"
if run; then echo "the test passes on an app that never shows the error"; cp /tmp/contact-form.orig "$F"; exit 1; fi
cp /tmp/contact-form.orig "$F"
echo "check passed"
