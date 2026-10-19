import {
  createHttpClientFromConfig,
  createLogger,
  loadConfig,
  requireSecret,
  type HttpClient,
  type Logger,
} from '@cc-setup-agent/core';
import { createDb, type Db } from '@cc-setup-agent/db';
import type { AppConfig } from '@cc-setup-agent/shared';
import { createLocalArtifactStore } from './artifacts.js';
import { measuredCosts } from './costs.js';
import type { EvalContext } from './runner.js';
import { createDockerCli, type DockerCli } from './sandbox/docker.js';
import { createDockerDriver } from './sandbox/docker-driver.js';
import { imageClaudeVersion, imageExists, imageInputs, imageTag } from './sandbox/image.js';
import { EvalError } from './errors.js';
import { loadToolOverrides, type ToolOverrides } from './tools.js';

export interface EvalCommandContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  http: HttpClient;
  docker: DockerCli;
  overrides: ToolOverrides;
  close(): Promise<void>;
}

export async function createCommandContext(): Promise<EvalCommandContext> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, name: 'evals' });
  const handle = createDb(config.DATABASE_URL);
  return {
    config,
    logger,
    db: handle.db,
    http: createHttpClientFromConfig(config, logger),
    docker: createDockerCli(),
    overrides: await loadToolOverrides(),
    close: handle.close,
  };
}

export async function currentImage(c: EvalCommandContext) {
  const inputs = imageInputs(
    c.config.GATE_NODE_IMAGE,
    c.config.EVAL_CLAUDE_CODE_VERSION,
    c.overrides,
  );
  return { inputs, tag: await imageTag(inputs) };
}

/**
 * Run context for eval commands. `paid` runs need ANTHROPIC_API_KEY (given only to the relay);
 * self-tests don't.
 */
export async function createRunContext(c: EvalCommandContext, paid: boolean): Promise<EvalContext> {
  const { tag } = await currentImage(c);
  if (!(await imageExists(c.docker, tag)))
    throw new EvalError(`eval image ${tag} is not built yet; run \`pnpm evals image\` first`);
  const claudeCodeVersion = await imageClaudeVersion(c.docker, tag);
  if (claudeCodeVersion !== c.config.EVAL_CLAUDE_CODE_VERSION)
    throw new EvalError(
      `image has Claude Code ${claudeCodeVersion}, config pins ${c.config.EVAL_CLAUDE_CODE_VERSION}`,
    );
  const driver = createDockerDriver(
    c.docker,
    {
      agentImage: tag,
      relayImage: c.config.GATE_NODE_IMAGE,
      apiKey: paid ? requireSecret(c.config, 'ANTHROPIC_API_KEY') : undefined,
      apiUpstream: c.config.EVAL_ANTHROPIC_API_URL,
      allowedModels: c.config.ALLOWED_MODELS,
      modelFast: c.config.MODEL_FAST,
      modelStrong: c.config.MODEL_STRONG,
      egressAllowlist: c.config.EVAL_EGRESS_ALLOWLIST,
      limits: {
        cpus: c.config.EVAL_CPUS,
        memoryMb: c.config.EVAL_MEMORY_MB,
        pidsLimit: c.config.EVAL_PIDS_LIMIT,
      },
      ...(c.config.EVAL_PLATFORM ? { platform: c.config.EVAL_PLATFORM } : {}),
    },
    c.logger,
  );
  return {
    config: c.config,
    logger: c.logger,
    db: c.db,
    driver,
    artifacts: createLocalArtifactStore(c.config.EVAL_ARTIFACT_DIR),
    claudeCodeVersion,
    image: tag,
    measured: () => measuredCosts(c.db),
  };
}
