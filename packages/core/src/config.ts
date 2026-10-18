import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  configSchema,
  FORBIDDEN_MODEL_PATTERN,
  type AppConfig,
  type SecretEnvKey,
} from '@cc-setup-agent/shared';
import { ConfigError } from './errors.js';

export type Env = Record<string, string | undefined>;

/**
 * Validates environment variables into a typed config.
 * Throws ConfigError listing each bad variable by name; values never appear in the message.
 */
export function parseConfig(env: Env): AppConfig {
  const result = configSchema.safeParse(env);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const variable = String(issue.path[0] ?? 'config');
    return { variable, text: `${variable}: ${issue.message}` };
  });
  const variables = [...new Set(lines.map((l) => l.variable))];
  throw new ConfigError(
    `Invalid configuration:\n  ${lines.map((l) => l.text).join('\n  ')}`,
    variables,
  );
}

/** Walks up from `startDir` to find a `.env` file; returns its path or undefined. */
export function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let cached: AppConfig | undefined;

/**
 * Loads config once per process: `.env` (nearest ancestor of cwd, if any) fills variables
 * not already set in the real environment, then everything is validated.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const envFile = process.env['ENV_FILE'] ?? findEnvFile(process.cwd());
  if (envFile) process.loadEnvFile(envFile);
  cached = parseConfig(process.env);
  return cached;
}

/** Returns a secret that a specific command needs, or throws naming the missing variable. */
export function requireSecret(config: AppConfig, key: SecretEnvKey): string {
  const value = config[key];
  if (value === undefined || value === '') {
    throw new ConfigError(
      `${key} is not set. Add it to .env (see .env.example) before running this command.`,
      [key],
    );
  }
  return value;
}

/** Last line of defence before any Anthropic API call. */
export function assertModelAllowed(config: AppConfig, model: string): void {
  if (FORBIDDEN_MODEL_PATTERN.test(model)) {
    throw new ConfigError(`Model ${model} is forbidden (Opus models are never allowed)`, [
      'ALLOWED_MODELS',
    ]);
  }
  if (!config.ALLOWED_MODELS.includes(model)) {
    throw new ConfigError(`Model ${model} is not in ALLOWED_MODELS`, ['ALLOWED_MODELS']);
  }
}
