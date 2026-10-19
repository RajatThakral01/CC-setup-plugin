/** Minimal unified diff (LCS over lines) for showing config changes. Inputs are small files. */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  if (before === after) return '';
  const a = before === null ? [] : before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ t: ' ' | '-' | '+'; line: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: ' ', line: a[i]!, ai: i++, bi: j++ });
    else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!))
      ops.push({ t: '+', line: b[j]!, ai: i, bi: j++ });
    else ops.push({ t: '-', line: a[i]!, ai: i++, bi: j });
  }
  const context = 3;
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.t !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.t === ' ') run++;
      if (end + run >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk[0]!.ai + 1;
    const bStart = hunk[0]!.bi + 1;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(
      `@@ -${aLen === 0 ? aStart - 1 : aStart},${aLen} +${bLen === 0 ? bStart - 1 : bStart},${bLen} @@`,
    );
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = end;
  }
  return `${out.join('\n')}\n`;
}
