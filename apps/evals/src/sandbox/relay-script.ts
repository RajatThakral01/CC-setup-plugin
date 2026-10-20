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
const http = require('http'), https = require('https'), net = require('net'), zlib = require('zlib');
const KEY = process.env.ANTHROPIC_API_KEY || '';
const RELAY_PORT = Number(process.env.RELAY_PORT || ${RELAY_PORT}), PROXY_PORT = Number(process.env.PROXY_PORT || ${PROXY_PORT});
const UP = new URL(process.env.RELAY_UPSTREAM);
const MODELS = new Set((process.env.ALLOWED_MODELS || '').split(',').filter(Boolean));
const HOSTS = (process.env.ALLOW_HOSTS || '').split(',').filter(Boolean);
delete process.env.ANTHROPIC_API_KEY;
const log = (o) => process.stdout.write(JSON.stringify({ ts: Date.now(), ...o }) + '\\n');
const allowed = (h) => HOSTS.some((a) => h === a || h.endsWith('.' + a));
// Usage of every messages response (streaming SSE or JSON), logged once per response, also when the
// stream is cut short (the agent was killed): 'complete' says whether the response finished.
const tapUsage = (r, res, path, model) => {
  const u = { model, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  let saw = false, done = false, logged = false, buf = '', json = '';
  const sse = String(r.headers['content-type'] || '').includes('text/event-stream');
  const take = (m) => {
    if (!m || typeof m !== 'object') return;
    saw = true;
    if (typeof m.input_tokens === 'number') u.input = m.input_tokens;
    if (typeof m.output_tokens === 'number') u.output = Math.max(u.output, m.output_tokens);
    if (typeof m.cache_read_input_tokens === 'number') u.cacheRead = m.cache_read_input_tokens;
    if (m.cache_creation && typeof m.cache_creation === 'object') {
      u.cacheWrite5m = m.cache_creation.ephemeral_5m_input_tokens || 0;
      u.cacheWrite1h = m.cache_creation.ephemeral_1h_input_tokens || 0;
    } else if (typeof m.cache_creation_input_tokens === 'number') u.cacheWrite5m = m.cache_creation_input_tokens;
  };
  const line = (l) => {
    if (!l.startsWith('data:')) return;
    let d; try { d = JSON.parse(l.slice(5).trim()); } catch { return; }
    if (d.type === 'message_start' && d.message) { if (d.message.model) u.model = d.message.model; take(d.message.usage); }
    else if (d.type === 'message_delta') take(d.usage);
    else if (d.type === 'message_stop') done = true;
  };
  // A compressed response (should the upstream ignore 'identity') is parsed from a decompressed copy.
  const enc = String(r.headers['content-encoding'] || '').toLowerCase();
  const unzip = enc === 'gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress() : enc === 'deflate' ? zlib.createInflate() : null;
  const src = unzip ? r.pipe(unzip) : r;
  src.on('data', (c) => {
    if (sse) { buf += c.toString('utf8'); const parts = buf.split('\\n'); buf = parts.pop() || ''; parts.forEach(line); }
    else if (json.length < 5000000) json += c.toString('utf8');
  });
  const finish = () => {
    if (logged) return; logged = true;
    if (sse && buf) line(buf);
    if (!sse && json) { try { const j = JSON.parse(json); if (j.model) u.model = j.model; take(j.usage); done = true; } catch {} }
    if (saw) log({ kind: 'usage', path, ...u, complete: done });
  };
  // With a decompressor in between, give it a moment to flush what it has before logging.
  const later = () => (unzip ? setTimeout(finish, 100) : finish());
  src.on('end', finish); src.on('error', finish); r.on('close', later); r.on('aborted', later); r.on('error', later); res.on('close', later);
};
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
    // Uncompressed responses, so the usage tap can read every one (M10: compressed streams had none).
    headers['accept-encoding'] = 'identity';
    const up = (UP.protocol === 'http:' ? http : https).request({ protocol: UP.protocol, hostname: UP.hostname, port: UP.port || (UP.protocol === 'http:' ? 80 : 443), path: UP.pathname.replace(/\\/$/, '') + req.url, method: req.method, headers }, (r) => {
      log({ kind: 'api', path, model, status: r.statusCode });
      if (path === '/v1/messages' && r.statusCode === 200) tapUsage(r, res, path, model);
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
      // An upstream that aborts mid-response must not leave the client waiting.
      r.on('aborted', () => res.destroy()); r.on('error', () => res.destroy());
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
  kind: 'api' | 'egress' | 'usage';
  ts: number;
  host?: string;
  port?: number;
  allowed?: boolean;
  path?: string;
  model?: string | null;
  status?: number;
  refused?: string;
  /** `usage` events: tokens of one messages response, as the API reported them. */
  input?: number;
  output?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
  /** False when the response was cut short (for example the agent was killed). */
  complete?: boolean;
}

/** Parses the relay's log lines (anything else is ignored). */
export function parseRelayLog(logs: string): RelayEvent[] {
  return logs.split('\n').flatMap((line) => {
    try {
      const o = JSON.parse(line) as Partial<RelayEvent>;
      return (o.kind === 'api' || o.kind === 'egress' || o.kind === 'usage') &&
        typeof o.ts === 'number'
        ? [o as RelayEvent]
        : [];
    } catch {
      return [];
    }
  });
}
