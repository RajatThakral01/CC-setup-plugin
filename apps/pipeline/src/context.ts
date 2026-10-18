import {
  createHttpClientFromConfig,
  createLogger,
  loadConfig,
  requireSecret,
  type HttpClient,
  type Logger,
} from '@cc-setup-agent/core';
import type { AppConfig } from '@cc-setup-agent/shared';
import { createDb, type Db } from '@cc-setup-agent/db';
import { createGithubClient, type GithubClient } from './sources/github.js';
import { createNpmClient, type NpmClient } from './sources/npm.js';

/** Everything a pipeline command needs, built once from config. */
export interface PipelineContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  http: HttpClient;
  github: GithubClient;
  npm: NpmClient;
  close(): Promise<void>;
}

export function createContext(): PipelineContext {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: 'pipeline' });
  const http = createHttpClientFromConfig(config, logger);
  const handle = createDb(config.DATABASE_URL);
  return {
    config,
    logger,
    db: handle.db,
    http,
    github: createGithubClient(http, requireSecret(config, 'GITHUB_TOKEN')),
    npm: createNpmClient(http),
    close: handle.close,
  };
}
