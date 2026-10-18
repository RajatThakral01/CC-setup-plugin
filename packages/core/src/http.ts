import type { z } from 'zod';
import type { HostRateLimit } from '@cc-setup-agent/shared';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';

/** Non-2xx response that was not retried, or still failed after all retries. */
export class HttpError extends AppError {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** Network failure or timeout after all retries. */
export class HttpNetworkError extends AppError {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`Network error for ${url}`, { cause });
  }
}

/** Response body did not match the expected schema. */
export class ResponseValidationError extends AppError {
  constructor(
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(`Unexpected response shape from ${url}: ${issues.slice(0, 5).join('; ')}`);
  }
}

export interface HttpClientOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  hostRateLimits: Record<string, HostRateLimit>;
  logger?: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface HttpClient {
  request(url: string, init?: RequestInit): Promise<Response>;
  getJson<T extends z.ZodType>(url: string, schema: T, init?: RequestInit): Promise<z.output<T>>;
  getText(url: string, init?: RequestInit): Promise<string>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** URL without query string, safe for logs and error messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export function isRetryableStatus(status: number, headers: Headers): boolean {
  if (status === 408 || status === 429 || status >= 500) return true;
  // GitHub signals primary rate-limit exhaustion with 403 + remaining=0.
  return status === 403 && headers.get('x-ratelimit-remaining') === '0';
}

/** Server-requested wait in ms from Retry-After or x-ratelimit-reset, if any. */
export function serverRequestedDelayMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  }
  return undefined;
}

/** Exponential backoff with full jitter, capped. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const nextSlotByHost = new Map<string, number>();

  async function waitForHostSlot(host: string): Promise<void> {
    const limit = options.hostRateLimits[host];
    if (!limit || limit.minIntervalMs === 0) return;
    const t = now();
    const slot = Math.max(t, nextSlotByHost.get(host) ?? 0);
    nextSlotByHost.set(host, slot + limit.minIntervalMs);
    if (slot > t) await sleep(slot - t);
  }

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const safeUrl = redactUrl(url);
    for (let attempt = 0; ; attempt++) {
      await waitForHostSlot(host);
      let response: Response;
      try {
        response = await doFetch(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        if (attempt >= options.maxRetries) throw new HttpNetworkError(safeUrl, error);
        const delay = backoffDelayMs(attempt, options.baseDelayMs, options.maxDelayMs, random);
        options.logger?.warn({ url: safeUrl, attempt, delay }, 'http network error, retrying');
        await sleep(delay);
        continue;
      }
      if (response.ok) return response;
      if (!isRetryableStatus(response.status, response.headers) || attempt >= options.maxRetries) {
        const body = await response.text().catch(() => '');
        throw new HttpError(response.status, safeUrl, body.slice(0, 2000));
      }
      const requested = serverRequestedDelayMs(response.headers, now());
      const delay = Math.min(
        options.maxDelayMs,
        requested ?? backoffDelayMs(attempt, options.baseDelayMs, options.maxDelayMs, random),
      );
      options.logger?.warn(
        { url: safeUrl, status: response.status, attempt, delay },
        'http retryable status, retrying',
      );
      await response.body?.cancel().catch(() => undefined);
      await sleep(delay);
    }
  }

  return {
    request,
    async getText(url, init) {
      const response = await request(url, init);
      return response.text();
    },
    async getJson(url, schema, init) {
      const headers = new Headers(init?.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      const response = await request(url, { ...init, headers });
      const data: unknown = await response.json();
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new ResponseValidationError(
          redactUrl(url),
          parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        );
      }
      return parsed.data;
    },
  };
}

/** HTTP client wired to the validated config. */
export function createHttpClientFromConfig(
  config: {
    HTTP_MAX_RETRIES: number;
    HTTP_BASE_DELAY_MS: number;
    HTTP_MAX_DELAY_MS: number;
    HTTP_TIMEOUT_MS: number;
    HTTP_HOST_RATE_LIMITS_JSON: Record<string, HostRateLimit>;
  },
  logger?: Logger,
): HttpClient {
  return createHttpClient({
    maxRetries: config.HTTP_MAX_RETRIES,
    baseDelayMs: config.HTTP_BASE_DELAY_MS,
    maxDelayMs: config.HTTP_MAX_DELAY_MS,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    hostRateLimits: config.HTTP_HOST_RATE_LIMITS_JSON,
    ...(logger ? { logger } : {}),
  });
}
