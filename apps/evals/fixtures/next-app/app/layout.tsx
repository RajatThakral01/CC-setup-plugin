import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = { title: 'Example Shop' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav aria-label="Main">
            <Link href="/">Home</Link> | <Link href="/products">Products</Link> |{' '}
            <Link href="/about">About</Link> | <Link href="/contact">Contact</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
