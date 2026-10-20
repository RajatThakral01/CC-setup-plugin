#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'lib/catalog.ts')"
cat > 'lib/catalog.ts' <<'CCSA_EOF'
export interface Product {
  slug: string;
  name: string;
}

export const PRODUCTS: Product[] = [
  { slug: 'desk-lamp', name: 'Desk Lamp' },
  { slug: 'oak-chair', name: 'Oak Chair' },
  { slug: 'linen-throw', name: 'Linen Throw' },
  { slug: 'ceramic-mug', name: 'Ceramic Mug' },
  { slug: 'wool-rug', name: 'Wool Rug' },
];

export const findProduct = (slug: string) => PRODUCTS.find((p) => p.slug === slug);
CCSA_EOF
mkdir -p "$(dirname 'app/products/[slug]/page.tsx')"
cat > 'app/products/[slug]/page.tsx' <<'CCSA_EOF'
import { findProduct } from '@/lib/catalog';

export default function ProductPage({ params }: { params: { slug: string } }) {
  const product = findProduct(params.slug);
  return <h1>{product?.name ?? 'Unknown product'}</h1>;
}
CCSA_EOF
