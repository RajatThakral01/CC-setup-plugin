/** CI guard: fails if any source or config file names an Opus model ID (plan 11.2). */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree } from './forbidden-models.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const findings = scanTree(root);
if (findings.length > 0) {
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.text}`);
  console.error(
    `Found ${findings.length} Opus model reference(s). Opus is forbidden in product code.`,
  );
  process.exit(1);
}
console.log('No Opus model IDs found.');
