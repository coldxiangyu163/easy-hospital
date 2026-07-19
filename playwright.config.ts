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
    // 先用常规工具链构建，再以注入 E2E 防护（tests/e2e/server-guard.mjs）的服务器进程
    // 启动。不能用 npm start + NODE_OPTIONS 注入：--import 会传播到 prestart 的
    // tsc/vite，platform 伪装会让 rollup 解析不到本机原生绑定导致构建失败。
    // npm start 的 prestart 路径由 scripts/smoke-production-start.mjs 单独覆盖。
    command:
      'npm run build && node --import=./tests/e2e/server-guard.mjs --env-file-if-exists=.env dist/server/server/main.js',
    url: 'http://127.0.0.1:3210/api/health',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RADAR_HOST: '127.0.0.1',
      RADAR_PORT: '3210',
      RADAR_DATA_DIR: e2eDataDirectory,
      EASY_HOSPITAL_DISABLE_LIVE_SOURCES: '1',
      // 显式置空全部真实通知/配对凭据。进程环境变量优先于 --env-file-if-exists
      // 加载的 .env（含空串），确保开发者本机 .env 中的真实渠道在 E2E 中不会上膛；
      // macOS 渠道没有环境变量开关，由 server-guard.mjs 的 platform 伪装禁用。
      EASY_HOSPITAL_BROWSER_AGENT_TOKEN: '',
      BARK_DEVICE_KEY: '',
      BARK_BASE_URL: '',
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_SECURE: '',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      SMTP_FROM: '',
      SMTP_TO: '',
    },
  },
});
