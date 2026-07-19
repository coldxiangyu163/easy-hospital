import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  NotificationChannel,
  NotificationSendResult,
} from '../../src/core/notification-channel.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';
import {
  markDeliverySending,
  prepareDueNotificationJobs,
} from '../../src/storage/notification-outbox.js';

describe('事件通知租约恢复', () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    [
      'sent',
      { status: 'accepted', providerMessageId: 'provider-sent' } satisfies NotificationSendResult,
    ],
    [
      'delivery_unknown',
      { status: 'unknown', errorCode: 'PROVIDER_AMBIGUOUS' } satisfies NotificationSendResult,
    ],
  ])('%s delivery 即使 Job 重放也不再次调用渠道', async (terminalState, result) => {
    const now = Date.now();
    let sourceAttempt = 0;
    let sends = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: `fixture-recovery-${terminalState}`,
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
          contentHash: createHash('sha256').update(`${terminalState}-${sourceAttempt}`).digest('hex'),
          observations: [
            {
              slotKey: `slot-${terminalState}`,
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
      key: `channel-${terminalState}`,
      async send() {
        sends += 1;
        return result;
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-notification-recovery-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = {
      databasePath,
      sourceAdapters: [adapter],
      notificationChannels: [channel],
      workerPollMs: 5,
    };
    app = await buildApp(options);
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
      requestId: `recovery-${terminalState}-1`,
      sourceId: `source-recovery-${terminalState}`,
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
      url: `/api/source-checks/${adapter.manifest.adapterKey}`,
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: `/api/source-checks/${adapter.manifest.adapterKey}`,
      headers,
      payload: { ...payload, requestId: `recovery-${terminalState}-2` },
    });
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);
    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch.deliveries[0].state).toBe(terminalState);
    const deliveryId = batch.deliveries[0].id;

    await app.close();
    app = undefined;
    database = openDatabase(databasePath);
    new SqliteJobRunner(database).enqueue({
      type: 'notification',
      payload: { deliveryId, channelKey: channel.key },
      runAt: Date.now(),
      dedupeKey: `forced-replay:${deliveryId}`,
      maxAttempts: 4,
    });
    database.close();
    database = undefined;

    app = await buildApp(options);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sends).toBe(1);
  });

  it('崩溃遗留 sending 与过期租约恢复为 delivery_unknown，绝不重发', async () => {
    const observedNow = Date.now();
    let sourceAttempt = 0;
    let sends = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-sending-crash',
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
          observedAt: new Date(available ? observedNow - 5 * 60_000 : observedNow - 10 * 60_000).toISOString(),
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(`sending-${sourceAttempt}`).digest('hex'),
          observations: [
            {
              slotKey: 'sending-crash-slot',
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
      key: 'crash-channel',
      async send() {
        sends += 1;
        return { status: 'accepted', providerMessageId: 'must-not-send' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-notification-crash-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      sourceAdapters: [adapter],
      notificationChannels: [channel],
      workerPollMs: 60_000,
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
      requestId: 'sending-crash-1',
      sourceId: 'source-sending-crash',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: new Date(observedNow + 60_000).toISOString(),
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-sending-crash',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-sending-crash',
      headers,
      payload: { ...payload, requestId: 'sending-crash-2' },
    });
    await app.close();
    app = undefined;

    const crashAt = observedNow + 1_000;
    database = openDatabase(databasePath);
    const runner = new SqliteJobRunner(database);
    prepareDueNotificationJobs(database, runner, [channel.key], crashAt);
    const claimed = runner.claimNext({ now: crashAt, leaseMs: 50 });
    const deliveryId = (claimed!.payload as { deliveryId: string }).deliveryId;
    markDeliverySending(database, deliveryId, crashAt);
    database.close();
    database = undefined;

    let recoveredNow = crashAt + 51;
    app = await buildApp({
      databasePath,
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => recoveredNow,
    });
    await expect
      .poll(
        async () =>
          (
            await app!.inject({
              method: 'GET',
              url: '/api/notification-batches',
              headers,
            })
          ).json().batches[0],
        { timeout: 1_000 },
      )
      .toMatchObject({
        state: 'delivery_unknown',
        deliveries: [
          expect.objectContaining({
            state: 'delivery_unknown',
            errorCode: 'DELIVERY_STATE_AMBIGUOUS',
            attempts: 1,
          }),
        ],
      });
    expect(sends).toBe(0);
    recoveredNow += 60_000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(0);
  });
});
