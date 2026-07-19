import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const dataDirectory = await mkdtemp(join(tmpdir(), 'easy-hospital-start-smoke-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['start'], {
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    RADAR_HOST: '127.0.0.1',
    RADAR_PORT: '0',
    RADAR_DATA_DIR: dataDirectory,
    EASY_HOSPITAL_DISABLE_LIVE_SOURCES: '1',
    BARK_DEVICE_KEY: '',
    SMTP_HOST: '',
    SMTP_PASSWORD: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let settled = false;
const started = new Promise((resolve, reject) => {
  const inspect = (chunk) => {
    output = `${output}${chunk}`.slice(-64 * 1024);
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match && !settled) {
      settled = true;
      resolve(match[0]);
    }
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  child.once('error', (error) => {
    if (!settled) {
      settled = true;
      reject(error);
    }
  });
  child.once('exit', (code, signal) => {
    if (!settled) {
      settled = true;
      reject(new Error(`npm start 在健康检查前退出：code=${code} signal=${signal}\n${output}`));
    }
  });
});

async function stop(signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

const timeout = globalThis.AbortSignal.timeout(120_000);
try {
  const url = await Promise.race([
    started,
    new Promise((_, reject) =>
      timeout.addEventListener('abort', () => reject(new Error(`npm start 超时\n${output}`)), {
        once: true,
      }),
    ),
  ]);
  const response = await globalThis.fetch(`${url}/api/health`, {
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `健康检查返回 ${response.status}`);
  globalThis.console.log(`生产启动健康检查通过：${url}/api/health`);
} finally {
  await stop();
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, 'exit'),
      delay(10_000, undefined, { ref: false }),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    await stop('SIGKILL');
    await Promise.race([
      once(child, 'exit'),
      delay(2_000, undefined, { ref: false }),
    ]);
  }
  await rm(dataDirectory, { recursive: true, force: true });
}
