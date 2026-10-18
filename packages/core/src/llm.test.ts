import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseConfig } from './config.js';
import {
  createLlmClient,
  jsonSchemaFor,
  usageFromResponse,
  type BudgetGuard,
  type MessagesApi,
} from './llm.js';

const config = parseConfig({});
const usage = {
  input_tokens: 1000,
  output_tokens: 100,
  cache_creation_input_tokens: 600,
  cache_read_input_tokens: 0,
};

function setup(text: string, stop_reason = 'end_turn') {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text }], stop_reason, usage }));
  const guard: BudgetGuard = {
    preflight: vi.fn(async () => undefined),
    record: vi.fn(async () => 0.0002),
  };
  const llm = createLlmClient({ config, guard, messages: { create } as unknown as MessagesApi });
  return { llm, create, guard };
}
const req = {
  purpose: 'classify' as const,
  model: 'claude-haiku-5-5',
  system: 'sys',
  user: 'u',
  schema: z.object({ a: z.string() }),
  maxTokens: 100,
};

describe('createLlmClient', () => {
  it('checks the budget, calls with a cached system prompt and JSON schema, and records usage', async () => {
    const { llm, create, guard } = setup('{"a":"x"}');
    await expect(llm.json({ ...req, ref: 'r1' })).resolves.toEqual({
      parsed: { a: 'x' },
      stopReason: 'end_turn',
      costUsd: 0.0002,
    });
    expect(guard.preflight).toHaveBeenCalledWith('classify', expect.any(Number));
    const body = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(guard.record).toHaveBeenCalledWith(
      'classify',
      'claude-haiku-5-5',
      {
        inputTokens: 1000,
        outputTokens: 100,
        cacheWrite5mTokens: 600,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
      'r1',
    );
  });

  it('records spend even when the output is invalid or refused', async () => {
    for (const [text, stop] of [
      ['not json', 'end_turn'],
      ['{"b":1}', 'end_turn'],
      ['', 'refusal'],
      ['{"a":', 'max_tokens'],
    ]) {
      const { llm, guard } = setup(text!, stop);
      const result = await llm.json(req);
      expect(result.parsed).toBeNull();
      expect(result.error).toBeDefined();
      expect(guard.record).toHaveBeenCalledOnce();
    }
  });

  it('never calls the API when the pre-flight check fails', async () => {
    const { llm, create, guard } = setup('{"a":"x"}');
    vi.mocked(guard.preflight).mockRejectedValueOnce(new Error('budget'));
    await expect(llm.json(req)).rejects.toThrow('budget');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses Opus and models outside the allow-list before anything else', async () => {
    const { llm, create, guard } = setup('{"a":"x"}');
    await expect(llm.json({ ...req, model: 'claude-opus-5-5' })).rejects.toThrow(/forbidden/);
    await expect(llm.json({ ...req, model: 'claude-haiku-4-5' })).rejects.toThrow(/ALLOWED_MODELS/);
    expect(guard.preflight).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('strips constraints structured outputs reject, at any depth', () => {
    const s = jsonSchemaFor(
      z.object({
        tags: z.array(z.string().max(5)).max(3),
        n: z.number().min(1),
        when: z.iso.datetime(),
      }),
    );
    expect(JSON.stringify(s)).not.toMatch(/maxItems|maxLength|minimum|pattern|\$schema/);
    expect(s).toMatchObject({
      properties: { when: { format: 'date-time' } },
      additionalProperties: false,
    });
  });
  it('builds a strict JSON schema without $schema', () => {
    const s = jsonSchemaFor(z.object({ a: z.string() }));
    expect(s).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
  });
  it('splits 1h cache writes from 5m ones', () => {
    expect(
      usageFromResponse({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 3,
        cache_creation: { ephemeral_1h_input_tokens: 4, ephemeral_5m_input_tokens: 6 },
      } as never),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheWrite5mTokens: 6,
      cacheWrite1hTokens: 4,
      cacheReadTokens: 3,
    });
  });
});
