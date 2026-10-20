import {
  createHttpClientFromConfig,
  createLlmClient,
  createLogger,
  loadConfig,
  requireSecret,
  type HttpClient,
  type LlmClient,
  type Logger,
} from '@cc-setup-agent/core';
import type { AppConfig } from '@cc-setup-agent/shared';
import { createDb, createLedgerGuard, type Db } from '@cc-setup-agent/db';
import { createGithubClient, type GithubClient } from './sources/github.js';
import { createNpmClient, type NpmClient } from './sources/npm.js';
import { createDockerCli, type DockerCli } from './gates/sandbox/docker.js';
import type { GateDeps } from './gates/run.js';
import { readVendors } from './catalog-config.js';

/** Everything a pipeline command needs, built once from config. */
export interface PipelineContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  http: HttpClient;
  github: GithubClient;
  npm: NpmClient;
  docker: DockerCli;
  /** Created on first use, so commands without LLM calls don't need ANTHROPIC_API_KEY. */
  llm(): LlmClient;
  close(): Promise<void>;
}

export function createContext(): PipelineContext {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: 'pipeline' });
  const http = createHttpClientFromConfig(config, logger);
  const handle = createDb(config.DATABASE_URL);
  let llm: LlmClient | undefined;
  return {
    config,
    logger,
    db: handle.db,
    http,
    github: createGithubClient(http, requireSecret(config, 'GITHUB_TOKEN'), config.GITHUB_API_URL),
    npm: createNpmClient(http, config.NPM_REGISTRY_URL),
    docker: createDockerCli(),
    llm() {
      llm ??= createLlmClient({ config, guard: createLedgerGuard(handle.db, config, logger) });
      return llm;
    },
    close: handle.close,
  };
}

/**
 * Gate dependencies from the context. The injection review needs the API (M10 safeguard a); without
 * a key every rule match stays suspected (blocked, no org lock), never confirmed.
 */
export async function gateDeps(ctx: PipelineContext): Promise<GateDeps> {
  return {
    db: ctx.db,
    http: ctx.http,
    github: ctx.github,
    npm: ctx.npm,
    docker: ctx.docker,
    config: ctx.config,
    logger: ctx.logger,
    vendors: await readVendors(),
    ...(ctx.config.ANTHROPIC_API_KEY ? { llm: ctx.llm() } : {}),
  };
}
