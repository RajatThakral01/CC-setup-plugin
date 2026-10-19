'use client';

import { useState } from 'react';

const PRODUCTS = ['Desk Lamp', 'Oak Chair', 'Linen Throw', 'Ceramic Mug', 'Wool Rug'];

export function ProductList() {
  const [query, setQuery] = useState('');
  const shown = PRODUCTS.filter((p) => p.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <label>
        Search <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ul aria-label="Products">
        {shown.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p>{shown.length} result(s)</p>
    </>
  );
}
