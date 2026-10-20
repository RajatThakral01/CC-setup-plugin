#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'lib/reviews.ts')"
cat > 'lib/reviews.ts' <<'CCSA_EOF'
export interface Review {
  author: string;
  text: string;
}

/** Reviews as customers typed them (untrusted text). */
export const REVIEWS: Review[] = [
  { author: 'Ada', text: 'Lovely lamp, <b>great</b> service.' },
  { author: 'Grace', text: 'The oak chair is sturdy.' },
  { author: 'Mallory', text: '<img src="x" onerror="document.title=\'pwned\'"> nice mug' },
];
CCSA_EOF
mkdir -p "$(dirname 'components/review-list.tsx')"
cat > 'components/review-list.tsx' <<'CCSA_EOF'
import { REVIEWS } from '@/lib/reviews';

export function ReviewList() {
  return (
    <ul aria-label="Reviews">
      {REVIEWS.map((r) => (
        <li key={r.author}>
          <strong>{r.author}</strong>: <span dangerouslySetInnerHTML={{ __html: r.text }} />
        </li>
      ))}
    </ul>
  );
}
CCSA_EOF
mkdir -p "$(dirname 'app/about/page.tsx')"
cat > 'app/about/page.tsx' <<'CCSA_EOF'
import { ReviewList } from '@/components/review-list';

export default function AboutPage() {
  return (
    <>
      <h1>About us</h1>
      <p>Example Shop is a small demo store used for automated tests.</p>
      <h2>What customers say</h2>
      <ReviewList />
    </>
  );
}
CCSA_EOF
