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

  it('默认装配官方公开来源适配器与本机通知状态，且不泄露路径或 secret', async () => {
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
          stability: 'stable',
          eventTypes: ['schedule_released'],
          runtime: null,
        }),
        expect.objectContaining({
          key: 'anzhen-public-heart-center-schedule',
          accessClass: 'A',
          stability: 'experimental',
          eventTypes: ['schedule_released'],
          bindings: expect.arrayContaining([
            expect.objectContaining({ targetId: 'target-anzhen-arrhythmia-center' }),
          ]),
          runtime: null,
        }),
        expect.objectContaining({
          key: 'browser-agent',
          accessClass: 'B',
          capabilities: expect.objectContaining({ schedule: false }),
          runtime: null,
        }),
        expect.objectContaining({
          key: 'rules-only:target-tongren-rhinology',
          targetId: 'target-tongren-rhinology',
          accessClass: 'C',
        }),
      ]),
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain(barkSecret);
    expect(serialized).not.toContain(agentSecret);
  });

  it('列出 A/B/C 三类来源及 manifest 派生能力', async () => {
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
        expect.objectContaining({
          key: 'anzhen-public-heart-center-schedule',
          accessClass: 'A',
          enabled: true,
          minIntervalMs: 43_200_000,
          stability: 'experimental',
          capabilities: {
            schedule: true,
            availability: false,
            cancellation: false,
            ruleReminder: false,
          },
          runtime: null,
        }),
        expect.objectContaining({ key: 'browser-agent', accessClass: 'B' }),
        expect.objectContaining({
          key: 'rules-only:target-tongren-rhinology',
          targetId: 'target-tongren-rhinology',
          accessClass: 'C',
        }),
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
    expect(disabled.adapters.map(({ key }) => key)).not.toEqual(
      expect.arrayContaining([
        'pumch-public-dermatology-schedule',
        'anzhen-public-heart-center-schedule',
      ]),
    );
    const rejectedTask = await fetch(`${running.url}/api/watch-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-27',
        dateTo: '2026-08-02',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: null,
      }),
    });
    expect(rejectedTask.status).toBe(400);
    await expect(rejectedTask.json()).resolves.toEqual({
      error: 'SOURCE_BINDING_NOT_AVAILABLE',
    });
    const persistedTasks = (await (
      await fetch(`${running.url}/api/watch-tasks`)
    ).json()) as { tasks: unknown[] };
    expect(persistedTasks.tasks).toEqual([]);

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
    expect(enabled.adapters.map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        'pumch-public-dermatology-schedule',
        'anzhen-public-heart-center-schedule',
      ]),
    );
  });
});
