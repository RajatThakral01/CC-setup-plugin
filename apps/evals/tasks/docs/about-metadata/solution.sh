#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/about/page.tsx')"
cat > 'app/about/page.tsx' <<'CCSA_EOF'
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About · Example Shop',
  description: 'Who we are and how the shop works.',
};

export default function AboutPage() {
  return (
    <>
      <h1>About us</h1>
      <p>Example Shop is a small demo store used for automated tests.</p>
    </>
  );
}
CCSA_EOF
