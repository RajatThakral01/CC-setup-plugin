import { loadConfig, createLogger } from '@cc-setup-agent/core';
import { checkDatabaseHealth } from '@cc-setup-agent/db';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, name: 'db-health' });
const health = await checkDatabaseHealth(config.DATABASE_URL);
if (health.ok) {
  logger.info({ serverVersion: health.serverVersion }, 'database reachable');
} else {
  logger.error({ error: health.error }, 'database unreachable');
  process.exitCode = 1;
}
