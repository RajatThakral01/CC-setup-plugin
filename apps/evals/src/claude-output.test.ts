import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaudeOutput } from './claude-output.js';

const success = readFileSync(
  new URL('../../../test/fixtures/evals/claude-result-success.json', import.meta.url),
  'utf8',
);

describe('parseClaudeOutput', () => {
  it('reads cost and per-model usage from the JSON result', () => {
    const r = parseClaudeOutput(`some log line\n${success}`, 'claude-haiku-5-5')!;
    expect(r).toMatchObject({
      completed: true,
      subtype: 'success',
      numTurns: 7,
      totalCostUsd: 0.0123,
      inputTokens: 120 + 9000 + 40000,
      outputTokens: 1500,
    });
    expect(r.spend).toEqual([
      {
        model: 'claude-haiku-5-5',
        usage: {
          inputTokens: 120,
          outputTokens: 1500,
          cacheWrite5mTokens: 9000,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 40000,
        },
        costUsd: 0.0123,
      },
    ]);
  });

  it('reports a max-turns stop as not completed, keeping its cost', () => {
    const j = { ...JSON.parse(success), subtype: 'error_max_turns', is_error: true };
    const r = parseClaudeOutput(JSON.stringify(j), 'claude-haiku-5-5')!;
    expect(r.completed).toBe(false);
    expect(r.subtype).toBe('error_max_turns');
    expect(r.spend[0]?.costUsd).toBe(0.0123);
  });

  it('falls back to top-level usage when modelUsage is missing', () => {
    const j = JSON.parse(success) as Record<string, unknown>;
    delete j['modelUsage'];
    const r = parseClaudeOutput(JSON.stringify(j), 'claude-sonnet-5-5')!;
    expect(r.spend).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-5-5', costUsd: 0.0123 }),
    ]);
  });

  it('returns null for missing or invalid output', () => {
    expect(parseClaudeOutput('', 'm')).toBeNull();
    expect(parseClaudeOutput('{ not json', 'm')).toBeNull();
    expect(parseClaudeOutput('{"type":"other"}', 'm')).toBeNull();
  });
});
