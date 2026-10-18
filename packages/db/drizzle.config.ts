import { defineConfig } from 'drizzle-kit';

// Used only for `drizzle-kit generate`; migrations are applied by `pnpm db:migrate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
});
