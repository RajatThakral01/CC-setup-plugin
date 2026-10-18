/** Minimal fetch double: routes exact URLs to canned responses and records calls. */
export type Route = () => Response;

export function createFakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes[url];
    return route
      ? route()
      : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

export const json =
  (body: unknown, status = 200): Route =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
