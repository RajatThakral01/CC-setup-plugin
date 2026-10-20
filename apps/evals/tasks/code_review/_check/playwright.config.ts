// Hidden check config: copied into the app only after the agent has finished.
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.check\.ts$/,
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
