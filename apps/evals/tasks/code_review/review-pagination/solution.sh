#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$(dirname 'lib/paginate.ts')"
cat > 'lib/paginate.ts' <<'CCSA_EOF'
export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
}

/**
 * One page of a list. Pages are numbered from 1. `totalPages` is at least 1, even for an empty
 * list. A page number below 1 or above `totalPages` gives an empty `items` array.
 */
export function paginate<T>(all: T[], page: number, pageSize: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const items =
    page < 1 || page > totalPages ? [] : all.slice((page - 1) * pageSize, page * pageSize);
  return { items, page, totalPages };
}
CCSA_EOF
