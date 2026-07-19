import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { NotificationChannel } from '../../src/core/notification-channel.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

describe('通知重试状态机', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('首次失败后按 1/5/15 分钟重试，总计最多 4 次且 attempts 准确', async () => {
    let now = Date.parse('2026-07-19T01:00:00.000Z');
    let sourceAttempt = 0;
    let sends = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-notification-retries',
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
          contentHash: createHash('sha256').update(`retry-${sourceAttempt}`).digest('hex'),
          observations: [
            {
              slotKey: 'retry-slot',
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
      key: 'retry-channel',
      async send() {
        sends += 1;
        return sends < 4
          ? { status: 'rejected', errorCode: `TEMP_${sends}`, retryable: true }
          : { status: 'accepted', providerMessageId: 'accepted-on-fourth' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-notification-retries-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
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
      requestId: 'retry-source-1',
      sourceId: 'source-retry',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T02:00:00.000Z',
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-notification-retries',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-notification-retries',
      headers,
      payload: { ...payload, requestId: 'retry-source-2' },
    });

    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);
    now += 60_000;
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(2);
    now += 5 * 60_000;
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(3);
    now += 15 * 60_000;
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(4);

    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'sent',
      deliveries: [
        expect.objectContaining({
          channel: 'retry-channel',
          state: 'sent',
          attempts: 4,
          providerMessageId: 'accepted-on-fourth',
        }),
      ],
    });
  });
});
