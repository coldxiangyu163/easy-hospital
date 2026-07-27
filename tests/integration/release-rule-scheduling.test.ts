import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';
import { openDatabase } from '../../src/storage/database.js';
import { createWatchTask } from '../../src/storage/watch-tasks.js';

// 固定时间：2026-07-19 08:00 北京（00:00Z），种子规则 15:00 放号、remind 30 分钟
// → occurrence 2026-07-19T07:00:00.000Z，reminderAt 06:30Z，尚未到期，job 保持 pending。
const FIXED_NOW = Date.parse('2026-07-19T00:00:00.000Z');
const RULE_ID = 'rule-tongren-rhinology-daily-1500';

type ReminderJobRow = {
  id: string;
  state: string;
  run_at: number;
  payload: {
    taskId: string;
    taskVersion: number;
    ruleId: string;
    occurrenceAt: number;
    targetDate: string;
    officialEntryUrl: string;
  };
};

function listReminderJobs(databasePath: string): ReminderJobRow[] {
  const inspector = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return (
      inspector
        .prepare(
          "SELECT id, state, run_at, payload_json FROM job WHERE type = 'release-reminder' ORDER BY run_at, id",
        )
        .all() as Array<{ id: string; state: string; run_at: number; payload_json: string }>
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  } finally {
    inspector.close();
  }
}

const taskPayload = {
  hospitalId: 'hospital-tongren',
  campusId: 'campus-tongren-chongwenmen',
  departmentId: 'department-tongren-rhinology',
  matchMode: 'any_expert',
  doctorName: null,
  titles: [],
  dateFrom: '2026-07-20',
  dateTo: '2026-07-27',
  session: 'ANY',
  eventTypes: ['schedule_released'],
  remindBeforeMinutes: 30,
};

describe('Release rule 变更时的 release-reminder 重排（R3）', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function startApp() {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-sched-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({ databasePath, now: () => FIXED_NOW, workerPollMs: 60_000 });
    return databasePath;
  }

  async function createTask(payload = taskPayload) {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  async function createRule(releaseTimeLocal = '16:00') {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        advanceDays: 7,
        releaseTimeLocal,
        sameDayPolicy: '以官方页面为准',
        officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
        sourceUrl: 'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
        verifiedAt: '2026-07-19T01:00:00.000Z',
        confidence: 'low',
        needsReconfirmation: true,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  it('任意 rules-only 目标都按有效规则调度，不依赖同仁医院 ID', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-generic-rule-sched-'));
    const databasePath = join(directory, 'data.sqlite3');
    const database = openDatabase(databasePath);
    database
      .prepare(
        "UPDATE department SET support_mode = 'rules-only' WHERE id = 'department-pumch-dermatology'",
      )
      .run();
    database.close();
    app = await buildApp({ databasePath, now: () => FIXED_NOW, workerPollMs: 60_000 });

    const rule = await app.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        advanceDays: 7,
        releaseTimeLocal: '15:00',
        sameDayPolicy: '测试中人工核验的规则',
        officialEntryUrl: 'https://www.pumch.cn/',
        sourceUrl: 'https://www.pumch.cn/detail/appointment.html',
        verifiedAt: '2026-07-19T01:00:00.000Z',
        confidence: 'low',
        needsReconfirmation: true,
      },
    });
    expect(rule.statusCode).toBe(201);

    const task = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        ...taskPayload,
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
      },
    });
    expect(task.statusCode).toBe(201);
    expect(listReminderJobs(databasePath)).toEqual([
      expect.objectContaining({
        state: 'pending',
        payload: expect.objectContaining({
          taskId: task.json().id,
          ruleId: rule.json().id,
          targetDate: '2026-07-26',
        }),
      }),
    ]);
  });

  it('POST 第一条同 scope 规则后立即为既有任务安排 reminder', async () => {
    const databasePath = await startApp();
    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
    });
    expect(deleted.statusCode).toBe(204);
    const legacyDatabase = openDatabase(databasePath);
    const task = createWatchTask(legacyDatabase, taskPayload);
    legacyDatabase.close();
    expect(listReminderJobs(databasePath)).toHaveLength(0);

    const rule = await createRule();
    const pending = listReminderJobs(databasePath).filter((job) => job.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({ taskId: task.id, ruleId: rule.id });
  });

  it('PATCH 改放号时间：旧时刻 pending job 被取消，新时刻立即产生新 job', async () => {
    const databasePath = await startApp();
    await createTask();

    const before = listReminderJobs(databasePath);
    expect(before).toHaveLength(1);
    expect(before[0].state).toBe('pending');
    expect(before[0].payload.ruleId).toBe(RULE_ID);
    const oldOccurrence = before[0].payload.occurrenceAt;
    expect(new Date(oldOccurrence).toISOString()).toBe('2026-07-19T07:00:00.000Z');

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
      payload: { releaseTimeLocal: '16:30' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().releaseTimeLocal).toBe('16:30');

    const after = listReminderJobs(databasePath);
    const pending = after.filter((job) => job.state === 'pending');

    // 旧时刻不再发送：任何状态下都不存在指向旧 occurrence 的 job
    expect(after.some((job) => job.payload.occurrenceAt === oldOccurrence)).toBe(false);

    // 新时刻（16:30 北京 = 08:30Z）产生一个新 pending job
    expect(pending).toHaveLength(1);
    expect(new Date(pending[0].payload.occurrenceAt).toISOString()).toBe(
      '2026-07-19T08:30:00.000Z',
    );
    expect(pending[0].payload.ruleId).toBe(RULE_ID);
  });

  it('PATCH disable 后 pending job 取消，enable 后无需重启立即恢复', async () => {
    const databasePath = await startApp();
    await createTask();
    expect(
      listReminderJobs(databasePath).filter((job) => job.state === 'pending'),
    ).toHaveLength(1);

    const disabled = await app!.inject({
      method: 'PATCH',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      listReminderJobs(databasePath).filter((job) => job.state === 'pending'),
    ).toHaveLength(0);

    const enabled = await app!.inject({
      method: 'PATCH',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    const restored = listReminderJobs(databasePath).filter((job) => job.state === 'pending');
    expect(restored).toHaveLength(1);
    expect(new Date(restored[0].payload.occurrenceAt).toISOString()).toBe(
      '2026-07-19T07:00:00.000Z',
    );
  });

  it('DELETE 主规则后同 scope enabled 备用规则立即接管', async () => {
    const databasePath = await startApp();
    const task = await createTask();
    const backup = await createRule('16:00');
    expect(listReminderJobs(databasePath)[0]?.payload.ruleId).toBe(RULE_ID);

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
    });
    expect(deleted.statusCode).toBe(204);

    const pending = listReminderJobs(databasePath).filter((job) => job.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({ taskId: task.id, ruleId: backup.id });
    expect(new Date(pending[0].payload.occurrenceAt).toISOString()).toBe(
      '2026-07-19T08:00:00.000Z',
    );
  });

  it('PATCH 拒绝 department→campus 推导不一致的跨院区 scope', async () => {
    const databasePath = await startApp();
    const task = await createTask();

    const catalog = new Database(databasePath);
    try {
      catalog
        .prepare(
          "INSERT INTO campus (id, hospital_id, name, sort_order) VALUES ('campus-tongren-test', 'hospital-tongren', '测试院区', 99)",
        )
        .run();
    } finally {
      catalog.close();
    }

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
      payload: { campusId: 'campus-tongren-test' },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });

    const pending = listReminderJobs(databasePath).filter((job) => job.state === 'pending');
    expect(pending).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ taskId: task.id, ruleId: RULE_ID }),
      }),
    ]);
  });

  it('DELETE 唯一规则取消其全部 pending 提醒 job', async () => {
    const databasePath = await startApp();
    await createTask();
    expect(
      listReminderJobs(databasePath).filter((job) => job.state === 'pending'),
    ).toHaveLength(1);

    const deleted = await app!.inject({
      method: 'DELETE',
      url: `/api/release-rules/${RULE_ID}`,
      headers: { host: '127.0.0.1' },
    });
    expect(deleted.statusCode).toBe(204);

    const jobs = listReminderJobs(databasePath);
    expect(jobs.filter((job) => job.state === 'pending')).toHaveLength(0);
    expect(jobs.filter((job) => job.payload.ruleId === RULE_ID && job.state === 'pending'))
      .toHaveLength(0);
  });

  it('PATCH 其他规则不取消、也不重复占用当前任务的提醒 job', async () => {
    const databasePath = await startApp();
    await createTask();
    const seedJob = listReminderJobs(databasePath)[0];
    expect(seedJob.state).toBe('pending');

    // 第二条同 scope 规则（18:00），域组合合法
    const secondRuleId = (await createRule('18:00')).id;

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/api/release-rules/${secondRuleId}`,
      headers: { host: '127.0.0.1' },
      payload: { releaseTimeLocal: '19:00' },
    });
    expect(patched.statusCode).toBe(200);

    const jobs = listReminderJobs(databasePath);
    // 种子规则的 pending job 原样保留（occurrence 未变、未被取消）
    const seed = jobs.find((job) => job.payload.ruleId === RULE_ID);
    expect(seed?.state).toBe('pending');
    expect(seed?.payload.occurrenceAt).toBe(seedJob.payload.occurrenceAt);
    // 任务已有活跃提醒 job：不为第二条规则重复排队
    expect(jobs).toHaveLength(1);
    expect(jobs.filter((job) => job.state === 'pending')).toHaveLength(1);
  });
});
