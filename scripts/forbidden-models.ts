import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/** Matches Opus model IDs such as claude-opus-5-5 or anthropic.claude-opus-4-8. */
export const OPUS_MODEL_ID = /\bclaude-opus-[0-9][0-9a-z.@-]*|\bopus-[0-9]+(?:-[0-9]+)?\b/i;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'docs', '.artifacts']);
const SCAN_EXT = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.sh',
  '.env',
  '.example',
  '.toml',
]);

/** Test files may name Opus IDs to prove they are refused; nothing else may. */
function isExempt(rel: string): boolean {
  return rel.endsWith('.test.ts') || rel === 'scripts/forbidden-models.ts';
}

export interface Finding {
  file: string;
  line: number;
  text: string;
}

export function scanText(file: string, text: string): Finding[] {
  return text
    .split('\n')
    .flatMap((line, i) =>
      OPUS_MODEL_ID.test(line) ? [{ file, line: i + 1, text: line.trim().slice(0, 160) }] : [],
    );
}

export function scanTree(root: string): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const rel = relative(root, full).split('\\').join('/');
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if ((SCAN_EXT.has(extname(entry)) || entry.startsWith('.env')) && !isExempt(rel)) {
        findings.push(...scanText(rel, readFileSync(full, 'utf8')));
      }
    }
  };
  walk(root);
  return findings;
}
