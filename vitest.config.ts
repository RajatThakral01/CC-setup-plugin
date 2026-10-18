import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
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
