import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5176',
  },
  webServer: {
    command: 'pnpm run dev',
    port: 5176,
    reuseExistingServer: true,
  },
});
