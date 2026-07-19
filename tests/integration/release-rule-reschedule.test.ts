import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  NotificationChannel,
  NotificationMessage,
} from '../../src/core/notification-channel.js';
import { buildApp } from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';

// 规则重排 × 通知状态机交叉：改时间 / disable→enable / delete / 重试中 PATCH 非时刻字段，
// 以及 worker 对规则不一致 job 的兜底校验。
describe('规则重排与提醒批次终态', () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const headers = { host: '127.0.0.1' };
  const taskPayload = {
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
    matchMode: 'any_expert',
    doctorName: null,
    titles: [],
    dateFrom: '2026-07-20',
    dateTo: '2026-08-02',
    session: 'ANY',
    eventTypes: ['schedule_released'],
    remindBeforeMinutes: 5,
  };
  const ruleId = 'rule-tongren-rhinology-daily-1500';
  // 种子规则 15:00（北京）放号：2026-07-19 occurrence=07:00Z，reminderAt=06:55Z
  const firstReminderAt = Date.parse('2026-07-19T06:55:00.000Z');

  async function batches() {
    return (
      await app!.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches as Array<{
      id: string;
      state: string;
      terminalReason: string | null;
      deliveries: Array<{
        channel: string;
        state: string;
        attempts: number;
        errorCode: string | null;
      }>;
    }>;
  }

  it('首轮重试中改放号时间：旧批次 RULE_CHANGED 终态、sent 保留、新时刻重排并送达', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let aCalls = 0;
    let bCalls = 0;
    const channelA: NotificationChannel = {
      key: 'rule-a',
      async send() {
        aCalls += 1;
        return { status: 'accepted', providerMessageId: 'a-ok' };
      },
    };
    const channelB: NotificationChannel = {
      key: 'rule-b',
      async send() {
        bCalls += 1;
        return bCalls === 1
          ? { status: 'rejected', errorCode: 'B_TEMP', retryable: true }
          : { status: 'accepted', providerMessageId: 'b-ok' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-time-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channelA, channelB],
      workerPollMs: 5,
      now: () => now,
    });
    await app.inject({ method: 'POST', url: '/api/watch-tasks', headers, payload: taskPayload });

    now = firstReminderAt;
    await expect.poll(() => aCalls + bCalls, { timeout: 1_000 }).toBe(2);

    // 重试等待中把放号时间 15:00 → 16:00（reminder 07:55Z）
    now = firstReminderAt + 30_000;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${ruleId}`,
      headers,
      payload: { releaseTimeLocal: '16:00' },
    });
    expect(patch.statusCode).toBe(200);

    await expect.poll(async () => (await batches())[0]?.state, { timeout: 1_000 }).toBe('failed');
    const oldBatch = (await batches())[0]!;
    expect(oldBatch.terminalReason).toBe('RULE_CHANGED');
    const oldA = oldBatch.deliveries.find((d) => d.channel === 'rule-a')!;
    const oldB = oldBatch.deliveries.find((d) => d.channel === 'rule-b')!;
    expect(oldA).toMatchObject({ state: 'sent', attempts: 1 }); // 已送达渠道保留终态
    expect(oldB).toMatchObject({ state: 'failed', errorCode: 'RULE_CHANGED' });
    expect(aCalls).toBe(1);

    // 新时刻到点：新批次全渠道送达（A 收到的是新时刻提醒，不是重复发送）
    now = Date.parse('2026-07-19T07:55:00.000Z');
    await expect.poll(() => bCalls, { timeout: 1_000 }).toBe(2);
    expect(aCalls).toBe(2);
    const all = await batches();
    const newBatch = all.find((batch) => batch.id !== oldBatch.id)!;
    expect(newBatch).toMatchObject({ state: 'sent', terminalReason: null });
  });

  it('disable 后不再发送且已有批次转 RULE_CHANGED，enable 后恢复未来 occurrence', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let aCalls = 0;
    let bCalls = 0;
    const channelA: NotificationChannel = {
      key: 'toggle-a',
      async send() {
        aCalls += 1;
        return { status: 'accepted', providerMessageId: 'a-ok' };
      },
    };
    const channelB: NotificationChannel = {
      key: 'toggle-b',
      async send() {
        bCalls += 1;
        return bCalls === 1
          ? { status: 'rejected', errorCode: 'B_TEMP', retryable: true }
          : { status: 'accepted', providerMessageId: 'b-ok' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-toggle-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      notificationChannels: [channelA, channelB],
      workerPollMs: 5,
      now: () => now,
    });
    await app.inject({ method: 'POST', url: '/api/watch-tasks', headers, payload: taskPayload });

    now = firstReminderAt;
    await expect.poll(() => aCalls + bCalls, { timeout: 1_000 }).toBe(2);

    // 重试等待中 disable：job 取消、批次终态、sent 保留
    now = firstReminderAt + 30_000;
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${ruleId}`,
      headers,
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    await expect.poll(async () => (await batches())[0]?.state, { timeout: 1_000 }).toBe('failed');
    expect((await batches())[0]).toMatchObject({ terminalReason: 'RULE_CHANGED' });
    expect(aCalls).toBe(1);
    now += 120_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bCalls).toBe(1); // 不再重试

    // enable：无需重启即按当前规则重排（今天 occurrence 已过 → 排明天 07-20 的）
    const enable = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${ruleId}`,
      headers,
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    now = Date.parse('2026-07-20T06:55:00.000Z');
    await expect.poll(() => aCalls + bCalls, { timeout: 1_000 }).toBe(4);
    const tomorrowBatch = (await batches()).find((batch) => batch.state !== 'failed');
    expect(tomorrowBatch).toMatchObject({ state: 'sent', terminalReason: null });
  });

  it('首轮重试中删除规则：批次转 RULE_DELETED 终态，绝不重发', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let sends = 0;
    const flaky: NotificationChannel = {
      key: 'delete-flaky',
      async send() {
        sends += 1;
        return { status: 'rejected', errorCode: 'TEMP', retryable: true };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-delete-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [flaky],
      workerPollMs: 5,
      now: () => now,
    });
    await app.inject({ method: 'POST', url: '/api/watch-tasks', headers, payload: taskPayload });

    now = firstReminderAt;
    await expect.poll(() => sends, { timeout: 1_000 }).toBe(1);

    now = firstReminderAt + 30_000;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/release-rules/${ruleId}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    await expect.poll(async () => (await batches())[0]?.state, { timeout: 1_000 }).toBe('failed');
    expect((await batches())[0]).toMatchObject({
      terminalReason: 'RULE_DELETED',
      deliveries: [
        expect.objectContaining({ state: 'failed', errorCode: 'RULE_DELETED' }),
      ],
    });
    now += 20 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sends).toBe(1);
  });

  it('重试中 PATCH 非时刻字段不取消 job：重试继续、已 sent 渠道不重复、正文用新核验日期', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let aCalls = 0;
    const bMessages: NotificationMessage[] = [];
    const channelA: NotificationChannel = {
      key: 'meta-a',
      async send() {
        aCalls += 1;
        return { status: 'accepted', providerMessageId: 'a-ok' };
      },
    };
    const channelB: NotificationChannel = {
      key: 'meta-b',
      async send(message) {
        bMessages.push(message);
        return bMessages.length === 1
          ? { status: 'rejected', errorCode: 'B_TEMP', retryable: true }
          : { status: 'accepted', providerMessageId: 'b-ok' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-meta-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channelA, channelB],
      workerPollMs: 5,
      now: () => now,
    });
    await app.inject({ method: 'POST', url: '/api/watch-tasks', headers, payload: taskPayload });

    now = firstReminderAt;
    await expect.poll(() => aCalls + bMessages.length, { timeout: 1_000 }).toBe(2);

    // 仅更新 verifiedAt（非时刻字段）：不得取消/重排 job
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${ruleId}`,
      headers,
      payload: { verifiedAt: '2026-07-20T08:30:00.000Z' },
    });
    expect(patch.statusCode).toBe(200);

    // +60s 重试照常发生（job 未被取消）：B 成功，A 不重复
    now = firstReminderAt + 60_000;
    await expect.poll(() => bMessages.length, { timeout: 1_000 }).toBe(2);
    expect(aCalls).toBe(1);
    expect((await batches())[0]).toMatchObject({ state: 'sent' });
    expect(bMessages[1]!.text).toContain('规则最后核验日期：2026-07-20');
  });

  it('规则变更后漏网旧 job 被 worker 校验拦截：0 发送、RULE_CHANGED 终态', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let sends = 0;
    const received: NotificationMessage[] = [];
    const capture: NotificationChannel = {
      key: 'stale-capture',
      async send(message) {
        sends += 1;
        received.push(message);
        return { status: 'accepted', providerMessageId: 'stale-ok' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-stale-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      notificationChannels: [capture],
      workerPollMs: 5,
      now: () => now,
    });
    const task = (
      await app.inject({ method: 'POST', url: '/api/watch-tasks', headers, payload: taskPayload })
    ).json();

    // 改放号时间（pending job 被物理删除），随后模拟一个漏网的旧 payload job
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${ruleId}`,
      headers,
      payload: { releaseTimeLocal: '16:00' },
    });
    expect(patch.statusCode).toBe(200);
    database = openDatabase(databasePath);
    new SqliteJobRunner(database).enqueue({
      type: 'release-reminder',
      payload: {
        taskId: task.id,
        taskVersion: task.version,
        ruleId,
        occurrenceAt: Date.parse('2026-07-19T07:00:00.000Z'),
        reminderAt: firstReminderAt,
        targetDate: '2026-07-26',
        officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
        needsReconfirmation: true,
      },
      runAt: firstReminderAt,
      dedupeKey: `release-reminder:stale-job:${task.id}`,
      maxAttempts: 4,
    });
    database.close();
    database = undefined;

    now = firstReminderAt;
    await expect
      .poll(async () => (await batches()).length, { timeout: 1_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await batches())[0]?.state, { timeout: 1_000 })
      .toBe('failed');
    expect((await batches())[0]).toMatchObject({
      terminalReason: 'RULE_CHANGED',
      deliveries: [expect.objectContaining({ state: 'failed', errorCode: 'RULE_CHANGED' })],
    });
    expect(sends).toBe(0);
  });
});
