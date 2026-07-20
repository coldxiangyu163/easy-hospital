import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { NotificationChannel, NotificationMessage } from '../../src/core/notification-channel.js';
import { buildApp } from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';

describe('Release reminder 恢复状态机', () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('从未尝试且超过 occurrenceAt 后记录 missed，并仍安排下个 occurrence', async () => {
    const beforeReminder = Date.parse('2026-07-19T00:00:00.000Z');
    let now = beforeReminder;
    let sends = 0;
    const channel: NotificationChannel = {
      key: 'reminder-channel',
      async send() {
        sends += 1;
        return { status: 'accepted', providerMessageId: 'should-not-send-missed' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-recovery-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = {
      databasePath,
      notificationChannels: [channel],
      workerPollMs: 60_000,
      now: () => now,
    };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-26',
        dateTo: '2026-07-27',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    await app.close();
    app = undefined;

    now = Date.parse('2026-07-19T07:01:00.000Z'); // 北京时间 15:01，已错过 6 分钟
    app = await buildApp({ ...options, workerPollMs: 5 });
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
        state: 'failed',
        terminalReason: 'RELEASE_REMINDER_MISSED',
        deliveries: [
          expect.objectContaining({
            channel: 'reminder-channel',
            state: 'failed',
            errorCode: 'RELEASE_REMINDER_MISSED',
            attempts: 0,
          }),
        ],
      });
    expect(sends).toBe(0);

    await app.close();
    app = undefined;
    database = openDatabase(databasePath);
    const next = new SqliteJobRunner(database).claimNext({
      now: Date.parse('2026-07-20T06:55:00.000Z'),
      leaseMs: 30_000,
    });
    expect(next).toMatchObject({
      type: 'release-reminder',
      payload: {
        occurrenceAt: Date.parse('2026-07-20T07:00:00.000Z'),
        targetDate: '2026-07-27',
      },
    });
  });

  it('按渠道持久化部分成功，重试不重复已成功渠道且重启不重发', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    const reminderAt = Date.parse('2026-07-19T06:55:00.000Z');
    let channelACalls = 0;
    let channelBCalls = 0;
    const channelA: NotificationChannel = {
      key: 'reminder-a',
      async send() {
        channelACalls += 1;
        return { status: 'accepted', providerMessageId: 'reminder-a-sent' };
      },
    };
    const channelB: NotificationChannel = {
      key: 'reminder-b',
      async send() {
        channelBCalls += 1;
        return channelBCalls === 1
          ? { status: 'rejected', errorCode: 'REMINDER_TEMPORARY', retryable: true }
          : { status: 'accepted', providerMessageId: 'reminder-b-sent' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-recovery-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = {
      databasePath,
      notificationChannels: [channelA, channelB],
      workerPollMs: 5,
      now: () => now,
    };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-26',
        dateTo: '2026-07-27',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });

    now = reminderAt;
    await expect.poll(() => channelACalls + channelBCalls, { timeout: 1_000 }).toBe(2);
    let batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'pending',
      deliveries: expect.arrayContaining([
        expect.objectContaining({ channel: 'reminder-a', state: 'sent', attempts: 1 }),
        expect.objectContaining({ channel: 'reminder-b', state: 'pending', attempts: 1 }),
      ]),
    });

    now += 60_000;
    await expect.poll(() => channelBCalls, { timeout: 1_000 }).toBe(2);
    expect(channelACalls).toBe(1);
    batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'sent',
      deliveries: expect.arrayContaining([
        expect.objectContaining({ channel: 'reminder-a', state: 'sent', attempts: 1 }),
        expect.objectContaining({ channel: 'reminder-b', state: 'sent', attempts: 2 }),
      ]),
    });

    await app.close();
    app = await buildApp(options);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(channelACalls).toBe(1);
    expect(channelBCalls).toBe(2);
  });

  const reminderTaskPayload = {
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
    matchMode: 'any_expert',
    doctorName: null,
    titles: [],
    dateFrom: '2026-07-26',
    dateTo: '2026-07-27',
    session: 'ANY',
    eventTypes: ['schedule_released'],
    remindBeforeMinutes: 5,
  };

  it('计划提醒被 claim 后崩溃，超过 occurrenceAt 恢复不补发且记为 missed', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let sends = 0;
    const channel: NotificationChannel = {
      key: 'reminder-crash-channel',
      async send() {
        sends += 1;
        return { status: 'accepted', providerMessageId: 'must-not-send' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-crash-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = {
      databasePath,
      notificationChannels: [channel],
      workerPollMs: 60_000,
      now: () => now,
    };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: reminderTaskPayload,
    });

    // 到达计划提醒时刻：job 被 claim（lease 30s）后进程直接崩溃
    now = Date.parse('2026-07-19T06:55:00.000Z');
    database = openDatabase(databasePath);
    const claimed = new SqliteJobRunner(database).claimNext({ now, leaseMs: 30_000 });
    expect(claimed).toMatchObject({ type: 'release-reminder', state: 'running' });
    database.close();
    database = undefined;
    await app.close();
    app = undefined;

    // 10 分钟后重启：LEASE_EXPIRED 恢复会把 run_at 改写为恢复时刻，
    // 但 missed 判定必须基于 payload 中不可变的 reminderAt。
    now = Date.parse('2026-07-19T07:05:00.000Z');
    app = await buildApp({ ...options, workerPollMs: 5 });
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/notification-batches', headers })
          ).json().batches[0],
        { timeout: 1_000 },
      )
      .toMatchObject({
        state: 'failed',
        terminalReason: 'RELEASE_REMINDER_MISSED',
        deliveries: [
          expect.objectContaining({
            state: 'failed',
            errorCode: 'RELEASE_REMINDER_MISSED',
            attempts: 0,
          }),
        ],
      });
    expect(sends).toBe(0);
  });

  it('已有渠道失败后跨过 occurrenceAt，批次标记 retry expired 并保留最后错误', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    const reminderAt = Date.parse('2026-07-19T06:55:00.000Z');
    let sends = 0;
    const channel: NotificationChannel = {
      key: 'reminder-flaky',
      async send() {
        sends += 1;
        return { status: 'rejected', errorCode: 'TEMPORARY', retryable: true };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-missed-retry-'));
    const options = {
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
    };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: reminderTaskPayload,
    });

    now = reminderAt;
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);

    // 首轮失败 retryAt=+60s；休眠到 occurrenceAt 之后。
    now = reminderAt + 400_000;
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/notification-batches', headers })
          ).json().batches[0],
        { timeout: 1_000 },
      )
      .toMatchObject({
        state: 'failed',
        terminalReason: 'RELEASE_REMINDER_RETRY_EXPIRED',
        deliveries: [
          expect.objectContaining({
            state: 'failed',
            errorCode: 'TEMPORARY',
            attempts: 1,
          }),
        ],
      });
    now += 600_000;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sends).toBe(1);
  });

  it('提前 30 分钟提醒保留 1/5/15 分钟完整重试阶梯', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let sends = 0;
    const channel: NotificationChannel = {
      key: 'reminder-30-minute-deadline',
      async send() {
        sends += 1;
        return { status: 'rejected', errorCode: `TEMP_${sends}`, retryable: true };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-30-minute-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: { ...reminderTaskPayload, remindBeforeMinutes: 30 },
    });

    for (const [attemptAt, expectedSends] of [
      ['2026-07-19T06:30:00.000Z', 1],
      ['2026-07-19T06:31:00.000Z', 2],
      ['2026-07-19T06:36:00.000Z', 3],
      ['2026-07-19T06:51:00.000Z', 4],
    ] as const) {
      now = Date.parse(attemptAt);
      await expect.poll(() => sends, { timeout: 1_000 }).toBe(expectedSends);
    }

    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'failed',
      terminalReason: null,
      deliveries: [
        expect.objectContaining({ attempts: 4, errorCode: 'TEMP_4', state: 'failed' }),
      ],
    });
  });

  it('提前 5 分钟提醒把越界退避 clamp 到 occurrenceAt，并在该时刻最后尝试', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let sends = 0;
    const channel: NotificationChannel = {
      key: 'reminder-5-minute-deadline',
      async send() {
        sends += 1;
        return { status: 'rejected', errorCode: `TEMP_${sends}`, retryable: true };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-5-minute-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: reminderTaskPayload,
    });

    now = Date.parse('2026-07-19T06:55:00.000Z');
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);
    now = Date.parse('2026-07-19T06:56:00.000Z');
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(2);
    now = Date.parse('2026-07-19T06:59:00.000Z');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sends).toBe(2);

    now = Date.parse('2026-07-19T07:00:00.000Z');
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(3);
    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'failed',
      terminalReason: 'RELEASE_REMINDER_RETRY_EXPIRED',
      deliveries: [
        expect.objectContaining({ attempts: 3, errorCode: 'TEMP_3', state: 'failed' }),
      ],
    });
  });

  it('提前 0 分钟提醒在 occurrenceAt 可最后尝试，失败后不再重试', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let sends = 0;
    const channel: NotificationChannel = {
      key: 'reminder-0-minute-deadline',
      async send() {
        sends += 1;
        return { status: 'rejected', errorCode: 'TEMP_AT_DEADLINE', retryable: true };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-0-minute-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: { ...reminderTaskPayload, remindBeforeMinutes: 0 },
    });

    now = Date.parse('2026-07-19T07:00:00.000Z');
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);
    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'failed',
      terminalReason: 'RELEASE_REMINDER_RETRY_EXPIRED',
      deliveries: [
        expect.objectContaining({
          attempts: 1,
          errorCode: 'TEMP_AT_DEADLINE',
          state: 'failed',
        }),
      ],
    });
    now += 60_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sends).toBe(1);
  });

  it('重试等待期间移除全部通知渠道，重启后批次进入诚实终态', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    const reminderAt = Date.parse('2026-07-19T06:55:00.000Z');
    let sends = 0;
    const doomed: NotificationChannel = {
      key: 'doomed',
      async send() {
        sends += 1;
        return { status: 'rejected', errorCode: 'TEMPORARY', retryable: true };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-channel-removed-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      notificationChannels: [doomed],
      workerPollMs: 5,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: reminderTaskPayload,
    });

    now = reminderAt;
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);
    await app.close();
    app = undefined;

    now = reminderAt + 60_000;
    app = await buildApp({
      databasePath,
      notificationChannels: [],
      workerPollMs: 5,
      now: () => now,
    });
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/notification-batches', headers })
          ).json().batches[0],
        { timeout: 1_000 },
      )
      .toMatchObject({
        state: 'failed',
        terminalReason: 'NOTIFICATION_CHANNEL_NOT_FOUND',
        deliveries: [
          expect.objectContaining({
            state: 'failed',
            errorCode: 'NOTIFICATION_CHANNEL_NOT_FOUND',
          }),
        ],
      });
    expect(sends).toBe(1);
  });

  it('提醒正文使用目录名称与规则核验日期，messageId 与持久化值一致', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-reminder-copy-'));
    const databasePath = join(directory, 'data.sqlite3');
    // 改动目录种子名称：若正文来自硬编码而不是 catalog join，此测试立即失败
    database = openDatabase(databasePath);
    database.prepare("UPDATE hospital SET name = '测试总医院' WHERE id = 'hospital-tongren'").run();
    database
      .prepare("UPDATE campus SET name = '测试院区' WHERE id = 'campus-tongren-chongwenmen'")
      .run();
    database
      .prepare("UPDATE department SET name = '测试科' WHERE id = 'department-tongren-rhinology'")
      .run();
    database.close();
    database = undefined;

    const received: NotificationMessage[] = [];
    const channel: NotificationChannel = {
      key: 'capture-reminder-copy',
      async send(message) {
        received.push(message);
        return { status: 'accepted', providerMessageId: 'reminder-copy-provider' };
      },
    };
    app = await buildApp({
      databasePath,
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: reminderTaskPayload,
    });

    now = Date.parse('2026-07-19T06:55:00.000Z');
    await expect.poll(() => received.length, { timeout: 1_000 }).toBe(1);
    expect(received[0]!.text).toContain('测试总医院 · 测试院区 · 测试科');
    expect(received[0]!.text).toContain('规则最后核验日期：2026-07-19');
    expect(received[0]!.text).toContain('需要重新核验');
    expect(received[0]!.text).toContain('不代替人工预约');
    expect(received[0]!.text).not.toContain('可用号源');

    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(received[0]!.messageId).toBe(batch.deliveries[0].messageId);
    expect(received[0]!.messageId).toContain('release-reminder:');
  });
});
