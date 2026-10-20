import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRelayLog, RELAY_SCRIPT } from './relay-script.js';

// The relay is our own script; here it runs as a plain node process against a fake upstream.
let upstream: Server;
let relay: ChildProcess;
let logs = '';
const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
const relayPort = 18000 + Math.floor(Math.random() * 1000);
const proxyPort = relayPort + 1000;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
      const start = ev({
        type: 'message_start',
        message: {
          model: 'example-fast',
          usage: {
            input_tokens: 120,
            output_tokens: 1,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
          },
        },
      });
      if (body.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Split mid-event to prove the parser buffers across chunks.
        res.write(start.slice(0, 40));
        res.write(start.slice(40));
        if (body.includes('"cut":true')) return void setTimeout(() => res.destroy(), 50);
        res.write(ev({ type: 'message_delta', usage: { output_tokens: 57 } }));
        return res.end(ev({ type: 'message_stop' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.url === '/v1/messages'
          ? JSON.stringify({
              ok: true,
              model: 'example-fast',
              usage: { input_tokens: 10, output_tokens: 5 },
            })
          : '{"ok":true}',
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as AddressInfo).port;
  relay = spawn(process.execPath, ['-e', RELAY_SCRIPT], {
    env: {
      PATH: process.env['PATH'] ?? '',
      ANTHROPIC_API_KEY: 'test-real-key',
      RELAY_UPSTREAM: `http://127.0.0.1:${port}`,
      ALLOWED_MODELS: 'example-fast,example-strong',
      ALLOW_HOSTS: 'registry.example.invalid',
      RELAY_PORT: String(relayPort),
      PROXY_PORT: String(proxyPort),
    },
  });
  relay.stdout!.on('data', (d: Buffer) => (logs += d.toString()));
  for (let i = 0; i < 100 && !(logs.includes('"relay"') && logs.includes('"proxy"')); i++)
    await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => {
  relay.kill();
  upstream.close();
});

function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: relayPort,
        path,
        method: 'POST',
        headers: { 'x-api-key': 'placeholder', 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('eval API relay', () => {
  const usage = () => parseRelayLog(logs).filter((e) => e.kind === 'usage');

  it('records the usage of streamed and plain messages responses', async () => {
    const before = usage().length;
    await post('/v1/messages', { model: 'example-fast', stream: true, messages: [] });
    await post('/v1/messages', { model: 'example-fast', messages: [] });
    await new Promise((r) => setTimeout(r, 100));
    const [streamed, plain] = usage().slice(before);
    expect(streamed).toMatchObject({
      model: 'example-fast',
      input: 120,
      output: 57,
      cacheRead: 900,
      cacheWrite5m: 200,
      cacheWrite1h: 100,
      complete: true,
    });
    expect(plain).toMatchObject({ input: 10, output: 5, complete: true });
  });

  it('records what it saw of a response that was cut short', async () => {
    const before = usage().length;
    await post('/v1/messages', {
      model: 'example-fast',
      stream: true,
      cut: true,
      messages: [],
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(usage().slice(before)).toEqual([
      expect.objectContaining({ input: 120, output: 1, cacheRead: 900, complete: false }),
    ]);
  });

  it('forwards allowed models with the real key instead of the placeholder', async () => {
    const r = await post('/v1/messages', { model: 'example-fast', messages: [] });
    expect(r.status).toBe(200);
    const last = seen.at(-1)!;
    expect(last.url).toBe('/v1/messages');
    expect(last.headers['x-api-key']).toBe('test-real-key');
    expect(JSON.parse(last.body)).toEqual({ model: 'example-fast', messages: [] });
  });

  it('refuses Opus and any model outside the allow-list, before reaching upstream', async () => {
    const before = seen.length;
    expect((await post('/v1/messages', { model: 'claude-opus-5-5' })).status).toBe(403);
    expect((await post('/v1/messages', { model: 'example-other' })).status).toBe(403);
    expect((await post('/other', {})).status).toBe(404);
    expect(seen.length).toBe(before);
    const refused = parseRelayLog(logs).filter((e) => e.refused);
    expect(refused.map((e) => e.refused)).toEqual(['model', 'model', 'path']);
  });

  it('never writes the key to its log', () => {
    expect(logs).not.toContain('test-real-key');
  });

  it('lets CONNECT through only to allow-listed hosts', async () => {
    const reply = await new Promise<string>((resolve) => {
      const s = connect(proxyPort, '127.0.0.1', () =>
        s.write('CONNECT evil.example.invalid:443 HTTP/1.1\r\nHost: evil.example.invalid\r\n\r\n'),
      );
      s.on('data', (d: Buffer) => {
        resolve(d.toString());
        s.destroy();
      });
    });
    expect(reply).toMatch(/^HTTP\/1.1 403/);
    expect(parseRelayLog(logs)).toContainEqual(
      expect.objectContaining({ kind: 'egress', host: 'evil.example.invalid', allowed: false }),
    );
  });
});
