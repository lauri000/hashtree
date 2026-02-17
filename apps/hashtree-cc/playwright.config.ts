import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5177',
  },
  webServer: [
    {
      command: 'node ../iris-files/e2e/relay/index.js',
      url: 'http://localhost:4736',
      reuseExistingServer: false,
      timeout: 5000,
    },
    {
      command: 'pnpm run dev --port 5177 --strictPort',
      url: 'http://localhost:5177',
      reuseExistingServer: false,
    },
  ],
});
