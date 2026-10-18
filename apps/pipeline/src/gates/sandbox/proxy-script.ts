/**
 * Egress-logging forward proxy, run with `node -e` inside a pinned official node container on the
 * sandbox network. It is our code, not third-party code. Each connection is logged as one JSON line.
 */
export const PROXY_PORT = 3128;

export const PROXY_SCRIPT = `
const http = require('http'), net = require('net');
const log = (o) => process.stdout.write(JSON.stringify({ ts: Date.now(), ...o }) + '\\n');
const server = http.createServer((req, res) => {
  let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  log({ method: req.method, host: u.hostname, port: Number(u.port || 80) });
  const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
server.on('connect', (req, sock, head) => {
  const i = req.url.lastIndexOf(':'); const host = req.url.slice(0, i); const port = Number(req.url.slice(i + 1)) || 443;
  log({ method: 'CONNECT', host, port });
  const up = net.connect(port, host, () => { sock.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
server.listen(${PROXY_PORT}, () => log({ ready: true }));
`;
