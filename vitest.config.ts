import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@cc-setup-agent/source'] },
  ssr: { resolve: { conditions: ['@cc-setup-agent/source'] } },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/plugin/server/**/*.test.ts',
      'scripts/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/fixtures/projects/**'],
  },
});
