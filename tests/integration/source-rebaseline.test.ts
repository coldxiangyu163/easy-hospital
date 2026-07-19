import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult, SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';

// README 承诺「应用停止、电脑休眠或网络中断期间不会继续监测；恢复后先建立新基线，
// 不推断离线期间发生过的变化」。runSourceCheck 在记录本次 attempt 前读取
// source_runtime：距 lastAttemptAt 超过 2× 有效最小轮询间隔即删除该 scope 基线，
// 本轮只静默重建，不产生事件。
describe('监测空窗后重建基线（rebaseline）', () => {
  const NOW0 = Date.parse('2026-07-19T00:00:00.000Z'); // 北京时间 08:00
  const INTERVAL_MS = 7_200_000; // pumch 有效最小轮询间隔 2h
  const THRESHOLD_MS = INTERVAL_MS * 2;

  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const headers = { host: '127.0.0.1' };

  type CannedObservation = {
    slotKey: string;
    availability?: 'available' | 'unavailable' | 'unknown';
  };

  const makeObservation = (canned: CannedObservation) => ({
    slotKey: canned.slotKey,
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
    date: '2026-07-20',
    session: 'AM' as const,
    doctorName: `医生-${canned.slotKey}`,
    title: '主任医师',
    scheduleStatus: 'present' as const,
    availability: canned.availability ?? ('unknown' as const),
    officialEntryUrl: 'https://hospital.example/appointment',
    evidence: 'explicit' as const,
  });

  const makeAdapter = (
    script: Array<{ status?: 'OK' | 'PARTIAL'; observations: CannedObservation[] }>,
    state: { calls: number },
  ): SourceAdapter => ({
    manifest: {
      adapterKey: 'pumch-public-dermatology-schedule',
      contractVersion: 1,
      version: '1.0.0-rebaseline-fixture',
      accessClass: 'A',
      transport: 'fetch',
      allowedHosts: ['hospital.example'],
      minIntervalMs: INTERVAL_MS,
    },
    async check(): Promise<CheckResult> {
      const step = script[Math.min(state.calls, script.length - 1)]!;
      state.calls += 1;
      return {
        status: step.status ?? 'OK',
        observedAt: new Date(currentNow()).toISOString(),
        nextAllowedAt: null,
        contentHash: String(state.calls).padStart(64, '0'),
        observations: step.observations.map(makeObservation),
      };
    },
  });

  let now = NOW0;
  const currentNow = () => now;

  async function startApp(script: Parameters<typeof makeAdapter>[0], state: { calls: number }) {
    now = NOW0; // 每个用例从同一时刻起跑，避免用例间时钟泄漏
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rebaseline-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [makeAdapter(script, state)],
      workerPollMs: 5,
      now: currentNow,
    });
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
        dateFrom: '2026-07-19',
        dateTo: '2026-07-26',
        session: 'ANY',
        eventTypes: ['schedule_released', 'availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });
  }

  const eventCount = async (): Promise<number> =>
    (await app!.inject({ method: 'GET', url: '/api/events', headers })).json().events.length;

  const workerHealth = async () =>
    (await app!.inject({ method: 'GET', url: '/api/health', headers })).json().checks.worker;

  const baselines = () =>
    database!
      .prepare('SELECT source_id, established_at FROM monitoring_baseline ORDER BY established_at')
      .all() as Array<{ source_id: string; established_at: number }>;

  it('正常 2h 轮询不误判：基线保留，新增排班照常产生事件', async () => {
    const state = { calls: 0 };
    await startApp(
      [{ observations: [{ slotKey: 'slotA' }] }, { observations: [{ slotKey: 'slotA' }, { slotKey: 'slotB' }] }],
      state,
    );
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(1);
    expect(await eventCount()).toBe(0); // 首轮静默建基线

    now += INTERVAL_MS; // 恰好 1× 间隔
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(2);
    await expect.poll(eventCount, { timeout: 1_000 }).toBe(1); // slotB schedule_released

    const health = await workerHealth();
    expect(health.lastRebaselineAt).toBeNull();
  });

  it('阈值边界：gap 恰好等于 2× 间隔不算空窗（超过才算）', async () => {
    const state = { calls: 0 };
    await startApp(
      [{ observations: [{ slotKey: 'slotA' }] }, { observations: [{ slotKey: 'slotA' }, { slotKey: 'slotB' }] }],
      state,
    );
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(1);

    now += THRESHOLD_MS; // gap == 2×，不触发 rebaseline
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(2);
    await expect.poll(eventCount, { timeout: 1_000 }).toBe(1);

    const health = await workerHealth();
    expect(health.lastRebaselineAt).toBeNull();

    await app.close();
    app = undefined;
    database = openDatabase(join(directory!, 'data.sqlite3'));
    expect(baselines()).toHaveLength(1); // 基线从未被删除
  });

  it('gap 超过 2× 间隔 1s：本轮 0 事件静默重建，审计状态保留，下一轮恢复 diff', async () => {
    const state = { calls: 0 };
    await startApp(
      [
        { observations: [{ slotKey: 'slotA' }] },
        { observations: [{ slotKey: 'slotA' }, { slotKey: 'slotB' }] },
        { observations: [{ slotKey: 'slotA' }, { slotKey: 'slotB' }, { slotKey: 'slotC' }] },
      ],
      state,
    );
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(1);

    const rebaselineAt = now + THRESHOLD_MS + 1_000;
    now = rebaselineAt;
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await eventCount()).toBe(0); // 空窗轮 0 事件：slotB 被静默收入基线

    const health = await workerHealth();
    expect(health.lastRebaselineAt).toBe(new Date(rebaselineAt).toISOString());

    now += INTERVAL_MS; // 正常间隔的下一轮：恢复对新增排班报事件
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(3);
    await expect.poll(eventCount, { timeout: 1_000 }).toBe(1);
    const events = (await app!.inject({ method: 'GET', url: '/api/events', headers })).json()
      .events;
    expect(events[0]).toMatchObject({ slotKey: 'slotC', eventType: 'schedule_released' });

    await app.close();
    app = undefined;
    database = openDatabase(join(directory!, 'data.sqlite3'));
    // 基线被重建（established_at = 空窗轮观测时间），schedule_state 审计行保留且
    // slotA 的 first_seen_at 仍是首轮时间——重建只删基线，不清审计状态。
    const baselineRows = baselines();
    expect(baselineRows).toHaveLength(1);
    expect(baselineRows[0]!.established_at).toBe(rebaselineAt);
    const scheduleStates = database!
      .prepare('SELECT slot_key, first_seen_at FROM schedule_state ORDER BY slot_key')
      .all() as Array<{ slot_key: string; first_seen_at: number }>;
    expect(scheduleStates.map((row) => row.slot_key)).toEqual(['slotA', 'slotB', 'slotC']);
    expect(scheduleStates[0]!.first_seen_at).toBe(NOW0);
  });

  it('rebaseline 轮抑制可用性事件但状态照常落库', async () => {
    const state = { calls: 0 };
    await startApp(
      [
        { observations: [{ slotKey: 'slotA', availability: 'unavailable' }] },
        { observations: [{ slotKey: 'slotA', availability: 'available' }] },
      ],
      state,
    );
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(1);
    expect(await eventCount()).toBe(0);

    now += THRESHOLD_MS + 1_000;
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // unavailable → available 本会产生 availability_changed_to_available，
    // 但空窗轮必须 0 事件（不把离线期间的差异当作变化）。
    expect(await eventCount()).toBe(0);

    await app.close();
    app = undefined;
    database = openDatabase(join(directory!, 'data.sqlite3'));
    // 状态照常落库：当前可用性已是 available，供下一轮 diff 使用。
    const availability = database!
      .prepare(
        "SELECT availability, current_availability FROM availability_state WHERE slot_key = 'slotA'",
      )
      .get() as { availability: string; current_availability: string };
    expect(availability).toEqual({ availability: 'available', current_availability: 'available' });
  });

  it('PARTIAL 空结果在空窗轮仍不能建立基线（p9 守护不被 rebaseline 绕过）', async () => {
    const state = { calls: 0 };
    await startApp(
      [
        { observations: [{ slotKey: 'slotA' }] },
        { status: 'PARTIAL', observations: [] },
        { observations: [{ slotKey: 'slotA' }] },
        { observations: [{ slotKey: 'slotA' }, { slotKey: 'slotB' }] },
      ],
      state,
    );
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(1);

    now += THRESHOLD_MS + 1_000; // 空窗轮：PARTIAL 空结果
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await eventCount()).toBe(0);

    now += INTERVAL_MS; // OK 轮：无基线 → 再次静默建基线
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await eventCount()).toBe(0);

    now += INTERVAL_MS; // 基线已重建 → slotB 正常报事件
    await expect.poll(() => state.calls, { timeout: 1_000 }).toBe(4);
    await expect.poll(eventCount, { timeout: 1_000 }).toBe(1);

    await app.close();
    app = undefined;
    database = openDatabase(join(directory!, 'data.sqlite3'));
    expect(baselines()).toHaveLength(1); // 第 3 轮才重新建立
  });

  it('tick 卡死在 adapter 时 health 读时计算 gap 并报 degraded，lastErrorCode 仍为 null', async () => {
    let releaseAdapter!: () => void;
    let called = false;
    const hangingAdapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-hanging-fixture',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: INTERVAL_MS,
      },
      check(): Promise<CheckResult> {
        called = true;
        return new Promise((resolve) => {
          releaseAdapter = () =>
            resolve({
              status: 'OK',
              observedAt: new Date(currentNow()).toISOString(),
              nextAllowedAt: null,
              contentHash: 'b'.repeat(64),
              observations: [],
            });
        });
      },
    };
    now = NOW0;
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rebaseline-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [hangingAdapter],
      workerPollMs: 5,
      now: currentNow,
    });
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
        dateFrom: '2026-07-19',
        dateTo: '2026-07-26',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    await expect.poll(() => called, { timeout: 1_000 }).toBe(true);

    now += 10 * 60_000; // tick 已卡死 10 分钟（fake 时钟）
    const health = await workerHealth();
    expect(health).toMatchObject({
      status: 'degraded',
      running: true,
      lastErrorCode: null, // 没有 tick 错误：degraded 完全来自读时 gap 判定
      lastRebaselineAt: null,
    });
    expect(health.heartbeatGapMs).toBeGreaterThanOrEqual(10 * 60_000);

    releaseAdapter();
    await app.close();
    app = undefined;
  });
});
