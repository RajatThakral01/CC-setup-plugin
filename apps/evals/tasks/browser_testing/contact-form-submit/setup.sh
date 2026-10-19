#!/usr/bin/env bash
set -euo pipefail
sed -i 's#<button type="submit">Send</button>#<button type="button">Send</button>#' components/contact-form.tsx
grep -q '<button type="button">Send</button>' components/contact-form.tsx
