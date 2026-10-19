import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  computeCostUsd,
  type AppConfig,
  type BudgetPurpose,
  type TokenUsage,
} from '@cc-setup-agent/shared';
import { assertModelAllowed, requireSecret } from './config.js';

/**
 * Budget enforcement every Anthropic call must pass through. Implemented over the ledger in
 * packages/db; injected here so core does not depend on the database.
 */
export interface BudgetGuard {
  /** Throws if a call costing up to `estimatedUsd` would break a cap. */
  preflight(purpose: BudgetPurpose, estimatedUsd: number): Promise<void>;
  /** Records the actual usage of a completed call; returns its cost. */
  record(purpose: BudgetPurpose, model: string, usage: TokenUsage, ref?: string): Promise<number>;
}

/** The slice of the Anthropic SDK we use, so tests can pass a fake. */
export interface MessagesApi {
  create(
    body: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>>;
}

export interface JsonRequest<T extends z.ZodType> {
  purpose: BudgetPurpose;
  model: string;
  /** Fixed instructions; cached across calls (prompt caching, plan section 3). */
  system: string;
  user: string;
  schema: T;
  maxTokens: number;
  ref?: string;
}

export interface JsonResult<T> {
  /** Validated output, or null when the model refused, was cut off, or returned invalid data. */
  parsed: T | null;
  stopReason: string | null;
  costUsd: number;
  error?: string;
}

export interface LlmClient {
  json<T extends z.ZodType>(request: JsonRequest<T>): Promise<JsonResult<z.output<T>>>;
}

/** Conservative token estimate (≈3 characters per token) used only for the budget pre-flight. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Keywords structured outputs reject; zod still enforces them on the parsed result. */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
]);
const SUPPORTED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'format' && typeof value === 'string' && !SUPPORTED_FORMATS.has(value)) continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

/** JSON schema for `output_config.format`, limited to what structured outputs accept. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return stripUnsupported(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export function usageFromResponse(usage: Anthropic.Usage): TokenUsage {
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const writeTotal = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWrite5mTokens: Math.max(0, writeTotal - write1h),
    cacheWrite1hTokens: write1h,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Thinking off for a short structured call. Sonnet 5.5 rejects `disabled` and takes
 * `between_tools` instead (no other field, effort high or below); Haiku 5.5 accepts `disabled`
 * at effort high or below. Verified against the Claude API reference and a live 400, 2026-10-20.
 */
export function thinkingOff(model: string): { type: 'disabled' } | { type: 'between_tools' } {
  return /sonnet-5-5/.test(model) ? { type: 'between_tools' } : { type: 'disabled' };
}

export function createLlmClient(options: {
  config: AppConfig;
  guard: BudgetGuard;
  messages?: MessagesApi;
}): LlmClient {
  const { config, guard } = options;
  const messages =
    options.messages ??
    new Anthropic({ apiKey: requireSecret(config, 'ANTHROPIC_API_KEY') }).messages;

  return {
    async json(request) {
      assertModelAllowed(config, request.model);
      const pricing = config.MODEL_PRICING_JSON[request.model];
      if (!pricing) throw new Error(`No pricing configured for ${request.model}`);
      const estimate = computeCostUsd(pricing, {
        inputTokens: estimateTokens(request.system + request.user) + 50,
        outputTokens: request.maxTokens,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      });
      await guard.preflight(request.purpose, estimate);

      const response = await messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: request.user }],
        thinking: thinkingOff(request.model),
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: jsonSchemaFor(request.schema) },
        },
      });
      const costUsd = await guard.record(
        request.purpose,
        request.model,
        usageFromResponse(response.usage),
        request.ref,
      );

      const base = { stopReason: response.stop_reason, costUsd };
      if (response.stop_reason !== 'end_turn') {
        return { ...base, parsed: null, error: `stop reason ${String(response.stop_reason)}` };
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return { ...base, parsed: null, error: 'response was not valid JSON' };
      }
      const parsed = request.schema.safeParse(data);
      return parsed.success
        ? { ...base, parsed: parsed.data }
        : { ...base, parsed: null, error: parsed.error.issues.map((i) => i.message).join('; ') };
    },
  };
}
