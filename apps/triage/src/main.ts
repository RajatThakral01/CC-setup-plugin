import { serve } from '@hono/node-server';
import { createLogger, loadConfig, requireSecret } from '@cc-setup-agent/core';
import { createDb } from '@cc-setup-agent/db';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, name: 'triage' });
const handle = createDb(config.DATABASE_URL);
const app = createApp({
  db: handle.db,
  adminToken: requireSecret(config, 'TRIAGE_ADMIN_TOKEN'),
  logger,
});

// Bound to localhost by default (TRIAGE_HOST); hosting puts it behind HTTPS and a real auth provider.
const server = serve(
  { fetch: app.fetch, hostname: config.TRIAGE_HOST, port: config.TRIAGE_PORT },
  (info) =>
    logger.info({ url: `http://${config.TRIAGE_HOST}:${info.port}` }, 'triage UI listening'),
);
const shutdown = () => server.close(() => void handle.close());
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
