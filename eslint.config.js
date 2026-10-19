import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.tsbuild/**',
      '**/coverage/**',
      'test/fixtures/projects/**',
      // Eval fixture app and hidden task checks run inside the eval image, not in this workspace.
      'apps/evals/fixtures/**',
      'apps/evals/tasks/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/plugin/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@cc-setup-agent/db',
                '@cc-setup-agent/pipeline',
                '**/packages/db/**',
                '**/apps/pipeline/**',
              ],
              message: 'apps/plugin must not depend on packages/db or apps/pipeline.',
            },
          ],
        },
      ],
    },
  },
);
