import { createHttpClient } from '@cc-setup-agent/core';
import { createFakeFetch, type Route } from './fake-fetch.js';

/** HTTP client over a fake fetch with no real waiting. */
export function fakeHttp(routes: Record<string, Route>) {
  const fake = createFakeFetch(routes);
  const http = createHttpClient({
    maxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
    timeoutMs: 1000,
    hostRateLimits: {},
    fetch: fake.fetch,
    sleep: async () => undefined,
  });
  return { http, calls: fake.calls };
}
