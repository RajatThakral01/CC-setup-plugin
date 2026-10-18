import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  backoffDelayMs,
  createHttpClient,
  HttpError,
  HttpNetworkError,
  redactUrl,
  ResponseValidationError,
  serverRequestedDelayMs,
  type HttpClientOptions,
} from './http.js';

function setup(responses: Array<Response | Error>, overrides: Partial<HttpClientOptions> = {}) {
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const client = createHttpClient({
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    timeoutMs: 1000,
    hostRateLimits: {},
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
    ...overrides,
  });
  return { client, fetchMock, sleeps };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('http client', () => {
  it('returns a successful response without retrying', async () => {
    const { client, fetchMock, sleeps } = setup([json({ ok: true })]);
    await expect(
      client.getJson('https://api.example.test/x', z.object({ ok: z.boolean() })),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('retries 5xx with exponential backoff, then succeeds', async () => {
    const { client, fetchMock, sleeps } = setup([
      new Response('', { status: 503 }),
      new Response('', { status: 502 }),
      json({ ok: true }),
    ]);
    await client.request('https://api.example.test/x');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // random=0.5 → half of base*2^attempt
    expect(sleeps).toEqual([50, 100]);
  });

  it('retries network errors and gives up with HttpNetworkError', async () => {
    const { client, fetchMock } = setup([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    await expect(client.request('https://api.example.test/x')).rejects.toBeInstanceOf(
      HttpNetworkError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('honours Retry-After on 429', async () => {
    const { client, sleeps } = setup([
      new Response('', { status: 429, headers: { 'retry-after': '3' } }),
      json({}),
    ]);
    await client.request('https://api.example.test/x');
    expect(sleeps).toEqual([3000]);
  });

  it('treats GitHub 403 with exhausted rate limit as retryable and waits for reset', async () => {
    const reset = Math.floor(1_000_000 / 1000) + 2;
    const { client, sleeps } = setup([
      new Response('', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      }),
      json({}),
    ]);
    await client.request('https://api.github.com/repos/a/b');
    expect(sleeps).toEqual([reset * 1000 - 1_000_000]);
  });

  it('does not retry 404 and throws HttpError with redacted url', async () => {
    const { client, fetchMock } = setup([new Response('nope', { status: 404 })]);
    const err = await client
      .request('https://api.example.test/x?token=abc')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).not.toContain('token=abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops after maxRetries on persistent 5xx', async () => {
    const { client, fetchMock } = setup(
      Array.from({ length: 4 }, () => new Response('', { status: 500 })),
    );
    await expect(client.request('https://api.example.test/x')).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('validates JSON bodies with zod', async () => {
    const { client } = setup([json({ ok: 'yes' })]);
    await expect(
      client.getJson('https://api.example.test/x', z.object({ ok: z.boolean() })),
    ).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it('spaces requests to a rate-limited host', async () => {
    const { client, sleeps } = setup([json({}), json({}), json({})], {
      hostRateLimits: { 'api.example.test': { minIntervalMs: 200 } },
    });
    await Promise.all([
      client.request('https://api.example.test/a'),
      client.request('https://api.example.test/b'),
      client.request('https://api.example.test/c'),
    ]);
    // The fake sleep advances the clock immediately, so each queued request waits one interval
    // past the previous slot: requests land at t, t+200, t+400.
    expect(sleeps).toEqual([200, 200]);
  });
});

describe('helpers', () => {
  it('caps backoff at maxDelay', () => {
    expect(backoffDelayMs(20, 100, 5000, () => 0.999)).toBeLessThanOrEqual(5000);
  });
  it('parses Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const headers = new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' });
    expect(serverRequestedDelayMs(headers, now)).toBe(5000);
  });
  it('strips query strings from urls', () => {
    expect(redactUrl('https://h.test/p?a=1')).toBe('https://h.test/p');
  });
});
