#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/products/[slug]/page.tsx')"
cat > 'app/products/[slug]/page.tsx' <<'CCSA_EOF'
import { findProduct } from '@/lib/catalog';

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = findProduct(slug);
  return <h1>{product?.name ?? 'Unknown product'}</h1>;
}
CCSA_EOF
