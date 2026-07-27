import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { pumchDermatologyScheduleManifest } from '../../src/adapters/sources/pumch.js';
import type {
  NotificationChannel,
  NotificationMessage,
} from '../../src/core/notification-channel.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import {
  buildApp as buildBaseApp,
  type BuildAppOptions,
} from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';
import { prepareDueNotificationJobs } from '../../src/storage/notification-outbox.js';

const pumchAdmissionAdapter: SourceAdapter = {
  manifest: pumchDermatologyScheduleManifest,
  async check() {
    throw new Error('Outbox seam 测试不应运行准入 Adapter');
  },
};

const buildApp = (options: BuildAppOptions) =>
  buildBaseApp({
    ...options,
    sourceAdapters: [...(options.sourceAdapters ?? []), pumchAdmissionAdapter],
    browserAgentToken: 'notification-outbox-browser-agent-token',
  });

// 事件批次在无渠道或沉睡过久时必须进入诚实终态，而不是永久 collecting 或补发陈旧提醒。
describe('事件批次诚实终态', () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const observedAt = Date.parse('2026-07-19T00:05:00.000Z');

  const makeAdapter = (): SourceAdapter => {
    let attempt = 0;
    return {
      manifest: {
        adapterKey: 'fixture-terminal',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const available = attempt > 1;
        return {
          status: 'OK',
          observedAt: new Date(available ? observedAt : observedAt - 5 * 60_000).toISOString(),
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(`terminal-${attempt}`).digest('hex'),
          observations: [
            {
              slotKey: 'slot-terminal',
              hospitalId: 'hospital-pumch',
              campusId: 'campus-pumch-dongdan',
              departmentId: 'department-pumch-dermatology',
              date: '2026-07-20',
              session: 'AM' as const,
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present' as const,
              availability: available ? 'available' : 'unavailable',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit' as const,
            },
          ],
        };
      },
    };
  };

  async function createTaskAndFireEvents(nowRef: { now: number }): Promise<void> {
    const headers = { host: '127.0.0.1' };
    await app!.inject({
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
      sourceId: 'source-terminal',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: new Date(nowRef.now + 60_000).toISOString(),
    };
    await app!.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-terminal',
      headers,
      payload: { ...payload, requestId: 'terminal-1' },
    });
    await app!.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-terminal',
      headers,
      payload: { ...payload, requestId: 'terminal-2' },
    });
  }

  async function firstBatch() {
    return (
      await app!.inject({
        method: 'GET',
        url: '/api/notification-batches',
        headers: { host: '127.0.0.1' },
      })
    ).json().batches[0];
  }

  it('没有任何可用渠道时，到期批次转为 NOTIFICATION_CHANNEL_NOT_FOUND 终态', async () => {
    const nowRef = { now: observedAt };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-no-channel-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [makeAdapter()],
      notificationChannels: [],
      workerPollMs: 5,
      now: () => nowRef.now,
    });
    await createTaskAndFireEvents(nowRef);
    expect((await firstBatch()).state).toBe('collecting');

    nowRef.now = observedAt + 61_000;
    await expect
      .poll(async () => (await firstBatch()).state, { timeout: 1_000 })
      .toBe('failed');
    expect(await firstBatch()).toMatchObject({
      state: 'failed',
      terminalReason: 'NOTIFICATION_CHANNEL_NOT_FOUND',
      deliveries: [],
    });

    // 24 小时后状态不得回退或滞留
    nowRef.now = observedAt + 24 * 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await firstBatch()).state).toBe('failed');
  });

  it('已排队渠道在重启后缺失时，pending delivery 仍经 sending 收敛为诚实终态', async () => {
    let sends = 0;
    const removedChannel: NotificationChannel = {
      key: 'removed-after-enqueue',
      async send() {
        sends += 1;
        return { status: 'accepted', providerMessageId: 'must-not-send' };
      },
    };
    const nowRef = { now: observedAt };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-removed-channel-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      sourceAdapters: [makeAdapter()],
      notificationChannels: [removedChannel],
      workerPollMs: 60_000,
      now: () => nowRef.now,
    });
    await createTaskAndFireEvents(nowRef);
    await app.close();
    app = undefined;

    nowRef.now = observedAt + 61_000;
    database = openDatabase(databasePath);
    prepareDueNotificationJobs(
      database,
      new SqliteJobRunner(database),
      [removedChannel.key],
      nowRef.now,
    );
    database.close();
    database = undefined;

    app = await buildApp({
      databasePath,
      notificationChannels: [],
      workerPollMs: 5,
      now: () => nowRef.now,
    });
    await expect
      .poll(async () => (await firstBatch()).state, { timeout: 1_000 })
      .toBe('failed');
    expect(await firstBatch()).toMatchObject({
      state: 'failed',
      deliveries: [
        expect.objectContaining({
          state: 'failed',
          attempts: 1,
          errorCode: 'NOTIFICATION_CHANNEL_NOT_FOUND',
        }),
      ],
    });
    expect(sends).toBe(0);
  });

  it('聚合窗口关闭超过 15 分钟仍未送达的事件转为 EVENT_NOTIFICATION_STALE，不补发', async () => {
    const received: NotificationMessage[] = [];
    const capture: NotificationChannel = {
      key: 'capture-stale',
      async send(message) {
        received.push(message);
        return { status: 'accepted', providerMessageId: 'stale-provider' };
      },
    };
    const nowRef = { now: observedAt };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-stale-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [makeAdapter()],
      notificationChannels: [capture],
      workerPollMs: 5,
      now: () => nowRef.now,
    });
    await createTaskAndFireEvents(nowRef);

    // 休眠 17 分钟后醒来：closes_at(00:06) < now-15min(00:07)，事件早已失去行动价值
    nowRef.now = observedAt + 17 * 60_000;
    await expect
      .poll(async () => (await firstBatch()).state, { timeout: 1_000 })
      .toBe('failed');
    expect(await firstBatch()).toMatchObject({
      state: 'failed',
      terminalReason: 'EVENT_NOTIFICATION_STALE',
      deliveries: [],
    });
    expect(received).toHaveLength(0);
  });

  it('15 分钟窗口内到期的事件仍正常发送（staleness 不误伤）', async () => {
    const received: NotificationMessage[] = [];
    const capture: NotificationChannel = {
      key: 'capture-fresh',
      async send(message) {
        received.push(message);
        return { status: 'accepted', providerMessageId: 'fresh-provider' };
      },
    };
    const nowRef = { now: observedAt };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-fresh-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [makeAdapter()],
      notificationChannels: [capture],
      workerPollMs: 5,
      now: () => nowRef.now,
    });
    await createTaskAndFireEvents(nowRef);

    nowRef.now = observedAt + 61_000;
    await expect.poll(() => received.length, { timeout: 1_000 }).toBe(1);
    expect(await firstBatch()).toMatchObject({ state: 'sent' });
  });
});
