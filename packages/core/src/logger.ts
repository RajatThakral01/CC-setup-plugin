import { pino, type Logger } from 'pino';
import { SECRET_ENV_KEYS } from '@cc-setup-agent/shared';

export type { Logger };

const REDACT_PATHS = [
  ...SECRET_ENV_KEYS,
  ...SECRET_ENV_KEYS.map((k) => `*.${k}`),
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
];

/** JSON logger with secret-looking fields redacted. */
export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  return pino({
    level: options.level ?? 'info',
    ...(options.name ? { name: options.name } : {}),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}
