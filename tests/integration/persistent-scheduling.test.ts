import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';

describe('WatchTask 持久调度', () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('同一协和来源范围的多个任务只共享一个宽查询 source-check Job', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 7_200_000,
      },
      async check() {
        throw new Error('本测试只验证持久调度，不应执行来源请求');
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      sourceAdapters: [adapter],
      workerPollMs: 60_000,
      now: () => now,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'doctor',
        doctorName: '示例医生',
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'title',
        doctorName: null,
        titles: ['主任医师'],
        dateFrom: '2026-07-24',
        dateTo: '2026-07-26',
        session: 'PM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    expect(second.statusCode).toBe(201);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${first.json().id}`,
      headers: { host: '127.0.0.1' },
      payload: { version: first.json().version, dateFrom: '2026-07-19' },
    });
    expect(edited.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/watch-tasks/${second.json().id}`,
          headers: { host: '127.0.0.1' },
        })
      ).statusCode,
    ).toBe(204);

    await app.close();
    app = undefined;
    database = openDatabase(databasePath);
    const runner = new SqliteJobRunner(database);
    const job = runner.claimNext({ now: now + 1_000, leaseMs: 30_000 });

    expect(job).toMatchObject({
      type: 'source-check',
      attempts: 1,
      payload: {
        adapterKey: 'pumch-public-dermatology-schedule',
        sourceId: 'source-pumch-public-schedule',
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        minIntervalMs: 7_200_000,
      },
    });
    expect(job?.payload).not.toHaveProperty('taskId');
    expect(job?.payload).not.toHaveProperty('taskVersion');
    expect(runner.claimNext({ now: now + 1_000, leaseMs: 30_000 })).toBeUndefined();
  });

  it('LocalWorker 用活动任务日期 union 执行无筛选宽查询，并全局至少间隔两小时', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    const adapterMinIntervalMs = 300_000;
    const pumchIntervalMs = 7_200_000;
    let calls = 0;
    let capturedRequest: Parameters<SourceAdapter['check']>[0] | undefined;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: adapterMinIntervalMs,
      },
      async check(request) {
        calls += 1;
        capturedRequest = request;
        return {
          status: 'OK',
          observedAt: new Date(now).toISOString(),
          nextAllowedAt: new Date(now + adapterMinIntervalMs).toISOString(),
          contentHash: 'a'.repeat(64),
          observations: [],
        };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      sourceAdapters: [adapter],
      workerPollMs: 60_000,
      now: () => now,
    });

    const taskInput = {
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: 5,
    };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        ...taskInput,
        matchMode: 'doctor',
        doctorName: '示例医生',
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-20',
        session: 'AM',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        ...taskInput,
        matchMode: 'title',
        doctorName: null,
        titles: ['主任医师'],
        dateFrom: '2026-07-24',
        dateTo: '2026-07-26',
        session: 'PM',
      },
    });

    await app.close();
    app = await buildApp({
      databasePath,
      sourceAdapters: [adapter],
      workerPollMs: 5,
      now: () => now,
    });
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
    expect(capturedRequest).toMatchObject({
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'ANY',
    });
    await app.close();
    app = undefined;
    database = openDatabase(databasePath);
    const runner = new SqliteJobRunner(database);
    expect(
      runner.claimNext({ now: now + pumchIntervalMs - 1, leaseMs: 30_000 }),
    ).toBeUndefined();
    expect(
      runner.claimNext({ now: now + pumchIntervalMs, leaseMs: 30_000 }),
    ).toMatchObject({ type: 'source-check', attempts: 1 });
  });

  it('创建同仁 C 级任务时按 ReleaseRule 写入放号前提醒 Job', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z'); // 北京时间 08:00
    const reminderAt = Date.parse('2026-07-19T06:55:00.000Z'); // 北京时间 14:55
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      now: () => now,
      workerPollMs: 60_000,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-26',
        dateTo: '2026-07-26',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    const task = created.json();
    expect(created.statusCode).toBe(201);

    await app.close();
    app = undefined;
    database = openDatabase(databasePath);
    const runner = new SqliteJobRunner(database);
    expect(runner.claimNext({ now: reminderAt - 1, leaseMs: 30_000 })).toBeUndefined();
    expect(runner.claimNext({ now: reminderAt, leaseMs: 30_000 })).toMatchObject({
      type: 'release-reminder',
      payload: {
        taskId: task.id,
        taskVersion: 1,
        ruleId: 'rule-tongren-rhinology-daily-1500',
        occurrenceAt: Date.parse('2026-07-19T07:00:00.000Z'),
        officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
      },
    });
  });

  it('重启时从 SQLite 活跃 WatchTask 补建缺失的 source-check Job', async () => {
    let calls = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 300_000,
      },
      async check() {
        calls += 1;
        return {
          status: 'OK',
          observedAt: new Date().toISOString(),
          nextAllowedAt: new Date(Date.now() + 300_000).toISOString(),
          contentHash: 'd'.repeat(64),
          observations: [],
        };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      sourceAdapters: [adapter],
      workerPollMs: 60_000,
    });
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'doctor',
        doctorName: '示例医生',
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    await app.close();
    app = undefined;

    database = openDatabase(databasePath);
    const runner = new SqliteJobRunner(database);
    const orphaned = runner.claimNext({ now: Date.now() + 1_000, leaseMs: 30_000 });
    expect(orphaned?.type).toBe('source-check');
    runner.complete(orphaned!.id, Date.now() + 1_001);
    database.close();
    database = undefined;

    app = await buildApp({
      databasePath,
      sourceAdapters: [adapter],
      workerPollMs: 5,
    });
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
  });

  it('一次宽查询结果在本地分别匹配同一来源范围内的所有活动任务', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let calls = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 300_000,
      },
      async check(request) {
        calls += 1;
        return {
          status: 'OK',
          observedAt: new Date(now).toISOString(),
          nextAllowedAt: null,
          contentHash: String(calls).padStart(64, '0'),
          observations:
            calls === 1
              ? []
              : ['甲医生', '乙医生'].map((doctorName) => ({
                  slotKey: `shared-${doctorName}`,
                  hospitalId: request.hospitalId,
                  campusId: request.campusId!,
                  departmentId: request.departmentId,
                  date: '2026-07-20',
                  session: 'AM' as const,
                  doctorName,
                  title: '主任医师',
                  scheduleStatus: 'present' as const,
                  availability: 'unknown' as const,
                  officialEntryUrl: 'https://pumchapp.pumch.cn/pages/pc/home/index',
                  evidence: 'explicit' as const,
                })),
        };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      workerPollMs: 60_000,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    const taskIds: string[] = [];
    for (const doctorName of ['甲医生', '乙医生']) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/watch-tasks',
        headers,
        payload: {
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          matchMode: 'doctor',
          doctorName,
          titles: [],
          dateFrom: '2026-07-20',
          dateTo: '2026-07-20',
          session: 'AM',
          eventTypes: ['schedule_released'],
          remindBeforeMinutes: 5,
        },
      });
      taskIds.push(created.json().id);
    }
    await app.close();
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      workerPollMs: 5,
      now: () => now,
    });

    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
    now += 7_200_000;
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(2);
    const events = (
      await app.inject({ method: 'GET', url: '/api/events', headers })
    ).json().events;
    expect(events).toHaveLength(2);
    expect(events.map((event: { taskId: string }) => event.taskId).sort()).toEqual(
      taskIds.sort(),
    );
  });

  it('共享来源 Job 重试期间删除一个任务不会饿死同范围内的其他任务', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let calls = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 300_000,
      },
      async check() {
        calls += 1;
        if (calls === 1) throw new Error('simulated shared-source failure');
        return {
          status: 'OK',
          observedAt: new Date(now).toISOString(),
          nextAllowedAt: null,
          contentHash: 'f'.repeat(64),
          observations: [],
        };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      workerPollMs: 60_000,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };
    const createdTasks = [];
    for (const doctorName of ['待删除医生', '保留医生']) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/watch-tasks',
        headers,
        payload: {
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          matchMode: 'doctor',
          doctorName,
          titles: [],
          dateFrom: '2026-07-20',
          dateTo: '2026-07-20',
          session: 'AM',
          eventTypes: ['schedule_released'],
          remindBeforeMinutes: 5,
        },
      });
      createdTasks.push(created.json());
    }
    await app.close();
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      workerPollMs: 5,
      now: () => now,
    });
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
    await app.inject({
      method: 'DELETE',
      url: `/api/watch-tasks/${createdTasks[0].id}`,
      headers,
    });

    now += 7_200_000;
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(2);
  });

  it('recurring source 连续异常达到 Job 上限后仍建立下一轮，不永久停止', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    let calls = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 300_000,
      },
      async check() {
        calls += 1;
        throw new Error('simulated recurring source exception');
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      workerPollMs: 5,
      now: () => now,
    });
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'doctor',
        doctorName: '示例医生',
        titles: [],
        dateFrom: '2026-07-19',
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });

    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
    database = openDatabase(join(directory, 'data.sqlite3'));
    expect(
      database
        .prepare(
          "SELECT last_status, last_error_code FROM source_runtime WHERE adapter_key = 'pumch-public-dermatology-schedule'",
        )
        .get(),
    ).toEqual({
      last_status: 'TEMPORARY_FAILURE',
      last_error_code: 'SOURCE_CHECK_FAILED',
    });
    database.close();
    database = undefined;

    now += 7_200_000;
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(2);
    now += 7_200_000;
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(3);
    now += 7_200_000;
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(4);
  });

  it('关注日期已过期的任务不再发起来源请求或建立 recurrence', async () => {
    const now = Date.parse('2026-07-21T00:00:00.000Z');
    let calls = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 300_000,
      },
      async check() {
        calls += 1;
        throw new Error('expired task must not call source');
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-scheduling-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      workerPollMs: 5,
      now: () => now,
    });
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'doctor',
        doctorName: '示例医生',
        titles: [],
        dateFrom: '2026-07-19',
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
  });
});
