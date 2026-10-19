#!/usr/bin/env bash
set -euo pipefail
sed -i 's#<button type="button">Send</button>#<button type="submit">Send</button>#' components/contact-form.tsx
