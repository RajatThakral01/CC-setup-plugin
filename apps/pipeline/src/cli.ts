/**
 * Pipeline CLI: `pnpm pipeline <command> [options]`. Thin wrapper; job logic lives in modules.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError } from '@cc-setup-agent/core';
import { createContext } from './context.js';
import { formatSeedReport, importSeed } from './seed/import.js';
import { readSeedFile } from './seed/seed-file.js';

const DEFAULT_SEED_FILE = fileURLToPath(new URL('../../../catalog/seed.yaml', import.meta.url));

const USAGE = `Usage: pnpm pipeline <command>

Commands:
  seed [--file <path>]   Import catalog/seed.yaml as candidate items`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'seed': {
      const { values } = parseArgs({ args: rest, options: { file: { type: 'string' } } });
      const file = values.file ? resolve(values.file) : DEFAULT_SEED_FILE;
      const entries = await readSeedFile(file);
      const ctx = createContext();
      try {
        const report = await importSeed(ctx, entries);
        process.stdout.write(`${formatSeedReport(report)}\n`);
        return report.failed.length > 0 ? 1 : 0;
      } finally {
        await ctx.close();
      }
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return command === undefined || command === '--help' ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  },
);
