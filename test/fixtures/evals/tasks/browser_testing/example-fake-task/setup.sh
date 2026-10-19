#!/usr/bin/env bash
# Installs a fake `claude` that records what it can see and prints canned JSON.
set -euo pipefail
cat > /home/node/fake-claude <<'JS'
#!/usr/bin/env node
const fs = require('fs'), http = require('http'), https = require('https');
const out = { argv: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, opus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL };
const direct = () => new Promise((r) => { const q = https.get('https://example.com', () => r('reached')); q.on('error', () => r('blocked')); q.setTimeout(3000, () => { q.destroy(); r('blocked'); }); });
const viaProxy = () => new Promise((r) => { const u = new URL(process.env.HTTPS_PROXY); const q = http.request({ host: u.hostname, port: u.port, method: 'CONNECT', path: 'evil.example.invalid:443' }); q.on('connect', (res) => r(String(res.statusCode))); q.on('error', () => r('error')); q.end(); });
(async () => {
  out.direct = await direct();
  out.proxy = await viaProxy();
  fs.writeFileSync('/home/node/agent-was-here', JSON.stringify(out));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, modelUsage: {} }));
})();
JS
chmod +x /home/node/fake-claude
