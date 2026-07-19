import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { NotificationChannel } from '../../src/core/notification-channel.js';
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

  it('休眠错过 5 分钟后记录 missed 且仍安排下个 occurrence', async () => {
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
});
