// Bundles the plugin's MCP server into one file, so installing the plugin needs no `pnpm install`.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  conditions: ['@cc-setup-agent/source'],
  legalComments: 'none',
  minify: true,
  // Some bundled CommonJS dependencies call require(); give ESM output a require().
  banner: {
    js: "import { createRequire as __ccsaCreateRequire } from 'node:module'; const require = __ccsaCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
