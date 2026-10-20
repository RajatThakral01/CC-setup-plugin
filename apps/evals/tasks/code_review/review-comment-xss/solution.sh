#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'components/review-list.tsx')"
cat > 'components/review-list.tsx' <<'CCSA_EOF'
import { REVIEWS } from '@/lib/reviews';

export function ReviewList() {
  return (
    <ul aria-label="Reviews">
      {REVIEWS.map((r) => (
        <li key={r.author}>
          <strong>{r.author}</strong>: <span>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
CCSA_EOF
