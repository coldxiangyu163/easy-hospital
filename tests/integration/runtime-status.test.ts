import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startApplicationFromEnvironment,
  type RunningApplication,
} from '../../src/server/runtime.js';

describe('GET /api/runtime-status', () => {
  let running: RunningApplication | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await running?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('默认装配协和适配器与本机通知状态，且不泄露路径或 secret', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-secret-user-'));
    const barkSecret = 'bark-device-secret-do-not-leak';
    const agentSecret = 'browser-agent-secret-do-not-leak';
    running = await startApplicationFromEnvironment({
      RADAR_HOST: '127.0.0.1',
      RADAR_PORT: '0',
      RADAR_DATA_DIR: directory,
      RADAR_TIMEZONE: 'Asia/Shanghai',
      BARK_DEVICE_KEY: barkSecret,
      EASY_HOSPITAL_BROWSER_AGENT_TOKEN: agentSecret,
    });

    const response = await fetch(`${running.url}/api/runtime-status`);
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({
      dataDirectory: { display: expect.stringMatching(/^…\//) },
      sqlite: { status: 'healthy' },
      worker: { status: 'healthy', running: true },
      notifications: expect.arrayContaining([
        expect.objectContaining({ key: 'macos', enabled: expect.any(Boolean) }),
        expect.objectContaining({ key: 'bark', enabled: true, reason: null }),
        expect.objectContaining({ key: 'smtp', enabled: false, reason: expect.any(String) }),
      ]),
      browserAgent: { configured: true, lastSeenAt: null },
      sourceCapabilities: expect.arrayContaining([
        expect.objectContaining({
          key: 'pumch-public-dermatology-schedule',
          accessClass: 'A',
          runtime: null,
        }),
        expect.objectContaining({
          key: 'browser-agent',
          accessClass: 'B',
          capabilities: expect.objectContaining({ schedule: false }),
          runtime: null,
        }),
        expect.objectContaining({ key: 'tongren-rhinology-rules', accessClass: 'C' }),
      ]),
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain(barkSecret);
    expect(serialized).not.toContain(agentSecret);
  });

  it('列出 A/B/C 三类来源及协和适配器最小间隔', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-'));
    running = await startApplicationFromEnvironment({
      RADAR_HOST: '127.0.0.1',
      RADAR_PORT: '0',
      RADAR_DATA_DIR: directory,
    });

    const response = await fetch(`${running.url}/api/source-adapters`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      adapters: expect.arrayContaining([
        expect.objectContaining({
          key: 'pumch-public-dermatology-schedule',
          accessClass: 'A',
          enabled: true,
          minIntervalMs: 7_200_000,
          capabilities: {
            schedule: true,
            availability: false,
            cancellation: false,
            ruleReminder: false,
          },
          runtime: null,
        }),
        expect.objectContaining({ key: 'browser-agent', accessClass: 'B' }),
        expect.objectContaining({ key: 'tongren-rhinology-rules', accessClass: 'C' }),
      ]),
    });
  });

  it('拒绝低熵 Browser Agent 配对 token', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-short-token-'));
    await expect(
      startApplicationFromEnvironment({
        RADAR_HOST: '127.0.0.1',
        RADAR_PORT: '0',
        RADAR_DATA_DIR: directory,
        EASY_HOSPITAL_BROWSER_AGENT_TOKEN: 'too-short',
      }),
    ).rejects.toThrow('至少需要 32 字节');
  });

  it('仅 EASY_HOSPITAL_DISABLE_LIVE_SOURCES=1 时禁用真实来源适配器', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-no-live-'));
    running = await startApplicationFromEnvironment({
      RADAR_HOST: '127.0.0.1',
      RADAR_PORT: '0',
      RADAR_DATA_DIR: directory,
      EASY_HOSPITAL_DISABLE_LIVE_SOURCES: '1',
    });

    const disabledResponse = await fetch(`${running.url}/api/source-adapters`);
    const disabled = (await disabledResponse.json()) as {
      adapters: Array<{ key: string }>;
    };
    expect(disabled.adapters.map(({ key }) => key)).not.toContain(
      'pumch-public-dermatology-schedule',
    );

    await running.close();
    running = undefined;
    await rm(directory, { recursive: true, force: true });
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-live-by-default-'));
    running = await startApplicationFromEnvironment({
      RADAR_HOST: '127.0.0.1',
      RADAR_PORT: '0',
      RADAR_DATA_DIR: directory,
      EASY_HOSPITAL_DISABLE_LIVE_SOURCES: 'true',
    });

    const enabledResponse = await fetch(`${running.url}/api/source-adapters`);
    const enabled = (await enabledResponse.json()) as {
      adapters: Array<{ key: string }>;
    };
    expect(enabled.adapters.map(({ key }) => key)).toContain(
      'pumch-public-dermatology-schedule',
    );
  });
});
