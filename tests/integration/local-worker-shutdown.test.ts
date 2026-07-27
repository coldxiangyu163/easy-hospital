import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { pumchDermatologyScheduleManifest } from '../../src/adapters/sources/pumch.js';
import type { NotificationChannel, NotificationSendResult } from '../../src/core/notification-channel.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

describe('LocalWorker 优雅退出', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('no-op tick 不覆盖 activeTick，close 等待真实外部通知调用结束', async () => {
    const now = Date.now();
    let sourceAttempt = 0;
    let releaseSend!: (result: NotificationSendResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-slow-shutdown',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        sourceAttempt += 1;
        const available = sourceAttempt > 1;
        return {
          status: 'OK',
          observedAt: new Date(available ? now - 5 * 60_000 : now - 10 * 60_000).toISOString(),
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(`shutdown-${sourceAttempt}`).digest('hex'),
          observations: [
            {
              slotKey: 'slow-shutdown-slot',
              hospitalId: 'hospital-pumch',
              campusId: 'campus-pumch-dongdan',
              departmentId: 'department-pumch-dermatology',
              date: '2026-07-20',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present',
              availability: available ? 'available' : 'unavailable',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };
    const channel: NotificationChannel = {
      key: 'slow-channel',
      async send() {
        markStarted();
        return await new Promise<NotificationSendResult>((resolve) => {
          releaseSend = resolve;
        });
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-worker-shutdown-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [
        adapter,
        {
          manifest: pumchDermatologyScheduleManifest,
          async check() {
            throw new Error('关闭 seam 测试不应运行准入 Adapter');
          },
        },
      ],
      browserAgentToken: 'shutdown-browser-agent-admission-token',
      notificationChannels: [channel],
      workerPollMs: 5,
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'shutdown-1',
      sourceId: 'source-shutdown',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: new Date(now + 60_000).toISOString(),
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-slow-shutdown',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-slow-shutdown',
      headers,
      payload: { ...payload, requestId: 'shutdown-2' },
    });

    await started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    releaseSend({ status: 'accepted', providerMessageId: 'slow-complete' });
    await closing;
    expect(closed).toBe(true);
    app = undefined;
  });
});
