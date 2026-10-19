// Runs the agent's own e2e/contact.spec.ts against a fresh build on a private port.
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: join(__dirname, '..', 'e2e'),
  testMatch: /contact\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx next start --hostname 127.0.0.1 --port 3100',
    cwd: join(__dirname, '..'),
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
