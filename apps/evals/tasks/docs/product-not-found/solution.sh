#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'app/products/[slug]/page.tsx')"
cat > 'app/products/[slug]/page.tsx' <<'CCSA_EOF'
import { notFound } from 'next/navigation';
import { findProduct } from '@/lib/catalog';

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = findProduct(slug);
  if (!product) notFound();
  return <h1>{product.name}</h1>;
}
CCSA_EOF
mkdir -p "$(dirname 'app/products/[slug]/not-found.tsx')"
cat > 'app/products/[slug]/not-found.tsx' <<'CCSA_EOF'
import Link from 'next/link';

export default function ProductNotFound() {
  return (
    <>
      <h1>Product not found</h1>
      <Link href="/products">Back to all products</Link>
    </>
  );
}
CCSA_EOF
