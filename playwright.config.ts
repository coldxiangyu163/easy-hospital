import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

const e2eDataDirectory = join(tmpdir(), `easy-hospital-e2e-${process.pid}`);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'ui-flow.spec.ts',
  outputDir: './artifacts/ui/playwright',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3210/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RADAR_DATA_DIR: e2eDataDirectory,
      EASY_HOSPITAL_DISABLE_LIVE_SOURCES: '1',
    },
  },
});
