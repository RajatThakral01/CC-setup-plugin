'use client';

import { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <section aria-label="Counter">
      <p>Count: {count}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Add one
      </button>
    </section>
  );
}
