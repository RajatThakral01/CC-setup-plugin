/**
 * The eval run's only way out, run with `node -e` in the pinned official node image (our code, not
 * third-party code). Two listeners, one JSON log line per request:
 *
 * - API relay (RELAY_PORT): plain HTTP inside the run network. Claude Code in the eval container
 *   uses `ANTHROPIC_BASE_URL=http://<relay>:RELAY_PORT` with a placeholder key; the relay replaces
 *   the key with the real one (held only by this container) and forwards to the upstream API. It
 *   refuses any request naming a model that isn't in ALLOWED_MODELS, so no Opus call is possible.
 * - Egress proxy (PROXY_PORT): HTTP and CONNECT, only to hosts in ALLOW_HOSTS; everything else is
 *   refused and logged.
 */
export const RELAY_PORT = 8080;
export const PROXY_PORT = 3128;

export const RELAY_SCRIPT = `
const http = require('http'), https = require('https'), net = require('net');
const KEY = process.env.ANTHROPIC_API_KEY || '';
const RELAY_PORT = Number(process.env.RELAY_PORT || ${RELAY_PORT}), PROXY_PORT = Number(process.env.PROXY_PORT || ${PROXY_PORT});
const UP = new URL(process.env.RELAY_UPSTREAM);
const MODELS = new Set((process.env.ALLOWED_MODELS || '').split(',').filter(Boolean));
const HOSTS = (process.env.ALLOW_HOSTS || '').split(',').filter(Boolean);
delete process.env.ANTHROPIC_API_KEY;
const log = (o) => process.stdout.write(JSON.stringify({ ts: Date.now(), ...o }) + '\\n');
const allowed = (h) => HOSTS.some((a) => h === a || h.endsWith('.' + a));
const deny = (res, status, msg) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: msg } })); };
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let model = null;
    if (body.length > 0) { try { const j = JSON.parse(body.toString('utf8')); if (j && typeof j.model === 'string') model = j.model; } catch {} }
    const path = (req.url || '/').split('?')[0];
    if (!path.startsWith('/v1/')) { log({ kind: 'api', path, status: 404, refused: 'path' }); return deny(res, 404, 'only /v1/ is relayed'); }
    if (model !== null && (!MODELS.has(model) || /opus/i.test(model))) { log({ kind: 'api', path, model, status: 403, refused: 'model' }); return deny(res, 403, 'model ' + model + ' is not allowed in evals'); }
    const headers = { ...req.headers };
    for (const h of ['host', 'x-api-key', 'authorization', 'content-length', 'connection', 'proxy-connection']) delete headers[h];
    headers['x-api-key'] = KEY; headers['content-length'] = String(body.length); headers.host = UP.host;
    const up = (UP.protocol === 'http:' ? http : https).request({ protocol: UP.protocol, hostname: UP.hostname, port: UP.port || (UP.protocol === 'http:' ? 80 : 443), path: UP.pathname.replace(/\\/$/, '') + req.url, method: req.method, headers }, (r) => {
      log({ kind: 'api', path, model, status: r.statusCode });
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
    });
    up.on('error', (e) => { log({ kind: 'api', path, model, status: 502, error: e.code || 'error' }); if (!res.headersSent) deny(res, 502, 'upstream error'); else res.end(); });
    up.end(body);
  });
}).listen(RELAY_PORT, () => log({ ready: 'relay' }));
const proxy = http.createServer((req, res) => {
  let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  const ok = allowed(u.hostname);
  log({ kind: 'egress', method: req.method, host: u.hostname, port: Number(u.port || 80), allowed: ok });
  if (!ok) { res.writeHead(403); return res.end(); }
  const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
proxy.on('connect', (req, sock, head) => {
  const i = req.url.lastIndexOf(':'); const host = req.url.slice(0, i); const port = Number(req.url.slice(i + 1)) || 443;
  const ok = allowed(host);
  log({ kind: 'egress', method: 'CONNECT', host, port, allowed: ok });
  if (!ok) { sock.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n'); return; }
  const up = net.connect(port, host, () => { sock.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
proxy.listen(PROXY_PORT, () => log({ ready: 'proxy' }));
`;

export interface RelayEvent {
  kind: 'api' | 'egress';
  ts: number;
  host?: string;
  port?: number;
  allowed?: boolean;
  path?: string;
  model?: string | null;
  status?: number;
  refused?: string;
}

/** Parses the relay's log lines (anything else is ignored). */
export function parseRelayLog(logs: string): RelayEvent[] {
  return logs.split('\n').flatMap((line) => {
    try {
      const o = JSON.parse(line) as Partial<RelayEvent>;
      return (o.kind === 'api' || o.kind === 'egress') && typeof o.ts === 'number'
        ? [o as RelayEvent]
        : [];
    } catch {
      return [];
    }
  });
}
