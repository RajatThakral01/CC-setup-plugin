import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanText, scanTree } from './forbidden-models.js';

describe('forbidden model scan', () => {
  it.each([
    'model: claude-opus-5-5',
    'MODEL=CLAUDE-OPUS-4-8',
    'id anthropic.claude-opus-4-1@2025',
    'use opus-4 here',
  ])('flags %s', (line) => {
    expect(scanText('f.ts', line)).toHaveLength(1);
  });

  it.each(['claude-haiku-5-5', 'Never use Opus in product code', 'opusculum'])(
    'ignores %s',
    (line) => {
      expect(scanText('f.ts', line)).toHaveLength(0);
    },
  );

  it('finds nothing in this repository', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(scanTree(root)).toEqual([]);
  });
});
