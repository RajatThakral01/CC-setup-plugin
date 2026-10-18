import { createLogger, loadConfig } from '@cc-setup-agent/core';
import { runMigrations } from '@cc-setup-agent/db';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, name: 'db-migrate' });
await runMigrations(config.DATABASE_URL);
logger.info('migrations applied');
