import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'ui-flow.spec.ts',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: '../../artifacts/ui/playwright',
  use: {
    baseURL: 'http://127.0.0.1:3210',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'cd ../.. && rm -rf /tmp/easy-hospital-ui-e2e && EASY_HOSPITAL_DATA_DIR=/tmp/easy-hospital-ui-e2e npm start',
    url: 'http://127.0.0.1:3210/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
