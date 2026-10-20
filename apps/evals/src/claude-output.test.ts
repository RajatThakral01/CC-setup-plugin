import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lastToolCalls, parseClaudeOutput } from './claude-output.js';
import { cannedClaudeJson } from './testing.js';

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

describe('stream-json transcripts (M8.3)', () => {
  const line = (o: unknown) => JSON.stringify(o);
  const transcript = [
    line({ type: 'system', subtype: 'init' }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'app/page.tsx' } },
        ],
      },
    }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }),
    line({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'b',
            name: 'Bash',
            input: { command: 'npm run dev', timeout: 600000 },
          },
        ],
      },
    }),
  ];

  it('finds the result line of a finished stream', () => {
    const done = [
      ...transcript,
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } }),
      cannedClaudeJson('claude-haiku-5-5', 0.02),
    ];
    expect(parseClaudeOutput(done.join('\n'), 'claude-haiku-5-5')).toMatchObject({
      completed: true,
      totalCostUsd: 0.02,
    });
    expect(lastToolCalls(done.join('\n')).every((c) => !c.pending)).toBe(true);
  });

  it('has no result for a killed run, and shows the call that never returned', () => {
    expect(parseClaudeOutput(transcript.join('\n'), 'claude-haiku-5-5')).toBeNull();
    expect(lastToolCalls(transcript.join('\n'))).toEqual([
      { name: 'Read', input: '{"file_path":"app/page.tsx"}', pending: false },
      { name: 'Bash', input: '{"command":"npm run dev","timeout":600000}', pending: true },
    ]);
  });
});
