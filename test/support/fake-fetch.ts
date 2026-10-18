/** Minimal fetch double: routes exact URLs to canned responses and records calls. */
export type Route = (init?: RequestInit) => Response;

export function createFakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = routes[url];
    return route
      ? route(init)
      : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

export const json =
  (body: unknown, status = 200): Route =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const text =
  (body: string, status = 200): Route =>
  () =>
    new Response(body, { status });

/**
 * Fake GitHub GraphQL endpoint for the batch repo lookup: answers each aliased `repository`
 * from `repos` (keyed lowercase owner/name) and reports NOT_FOUND for the rest.
 */
export function graphqlRoute(
  repos: Record<string, unknown>,
  onQuery?: (count: number) => void,
): Route {
  return (init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { variables: Record<string, string> };
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    const count = Object.keys(body.variables).length / 2;
    onQuery?.(count);
    for (let j = 0; j < count; j++) {
      const key = `${body.variables[`o${j}`]}/${body.variables[`n${j}`]}`.toLowerCase();
      data[`r${j}`] = repos[key] ?? null;
      if (!repos[key])
        errors.push({ type: 'NOT_FOUND', path: [`r${j}`], message: `Could not resolve ${key}` });
    }
    return new Response(JSON.stringify({ data, ...(errors.length ? { errors } : {}) }), {
      status: 200,
    });
  };
}
