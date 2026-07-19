// release-reminder 日历边界回归测试。
//
// 放号提醒的时间数学集中在 src/storage/scheduling.ts（北京时间 = UTC+8，无 DST）。
// 本文件固定月末、年末、闰日与清晨放号（UTC 小时为负、跨日回卷）下
// occurrenceAt / reminderAt / targetDate 的期望值，防止日历格回归。

import { afterEach, describe, expect, it } from 'vitest';

import type { WatchTask } from '../../src/core/watch-task.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';
import { scheduleWatchTask } from '../../src/storage/scheduling.js';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;

function beijingWallClock(ms: number): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

function makeTask(dateFrom: string, dateTo: string): WatchTask {
  return {
    id: `task-${dateFrom}-${dateTo}`,
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
    matchMode: 'any_expert',
    doctorName: null,
    titles: [],
    dateFrom,
    dateTo,
    session: 'ANY',
    eventTypes: ['schedule_released'],
    remindBeforeMinutes: 5,
    enabled: true,
    version: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

type EnqueuedReminder = {
  reminderAtBeijing: string;
  occurrenceAtBeijing: string;
  targetDate: string;
};

describe('release-reminder 日历边界', () => {
  let database: SqliteDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function enqueueReminder(
    task: WatchTask,
    nowMs: number,
    releaseTimeLocal?: string,
  ): EnqueuedReminder | undefined {
    database = openDatabase(':memory:');
    if (releaseTimeLocal !== undefined) {
      database
        .prepare("UPDATE release_rule SET release_time_local = ? WHERE id = 'rule-tongren-rhinology-daily-1500'")
        .run(releaseTimeLocal);
    }
    const runner = new SqliteJobRunner(database);
    scheduleWatchTask(database, runner, task, new Map(), nowMs);
    const row = database
      .prepare(
        "SELECT payload_json, run_at FROM job WHERE type = 'release-reminder' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { payload_json: string; run_at: number } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as { occurrenceAt: number; targetDate: string };
    return {
      reminderAtBeijing: beijingWallClock(row.run_at),
      occurrenceAtBeijing: beijingWallClock(payload.occurrenceAt),
      targetDate: payload.targetDate,
    };
  }

  it('月末：7/31 15:00 放号、提前 5 分钟提醒、目标就诊日 8/7', () => {
    const reminder = enqueueReminder(
      makeTask('2026-07-31', '2026-08-13'),
      Date.parse('2026-07-31T06:00:00.000Z'), // 北京 7/31 14:00
    );
    expect(reminder).toEqual({
      reminderAtBeijing: '2026-07-31 14:55',
      occurrenceAtBeijing: '2026-07-31 15:00',
      targetDate: '2026-08-07',
    });
  });

  it('年末：12/31 15:00 放号，目标就诊日跨年落 1/7', () => {
    const reminder = enqueueReminder(
      makeTask('2026-12-31', '2027-01-13'),
      Date.parse('2026-12-31T06:00:00.000Z'), // 北京 12/31 14:00
    );
    expect(reminder).toEqual({
      reminderAtBeijing: '2026-12-31 14:55',
      occurrenceAtBeijing: '2026-12-31 15:00',
      targetDate: '2027-01-07',
    });
  });

  it('闰日：2028-02-29 15:00 放号，目标就诊日 2028-03-07', () => {
    const reminder = enqueueReminder(
      makeTask('2028-02-29', '2028-03-13'),
      Date.parse('2028-02-29T06:00:00.000Z'), // 北京 2/29 14:00
    );
    expect(reminder).toEqual({
      reminderAtBeijing: '2028-02-29 14:55',
      occurrenceAtBeijing: '2028-02-29 15:00',
      targetDate: '2028-03-07',
    });
  });

  it('闰年 2/28 放号，目标就诊日跨闰日落 3/6', () => {
    const reminder = enqueueReminder(
      makeTask('2028-02-28', '2028-03-12'),
      Date.parse('2028-02-28T06:00:00.000Z'), // 北京 2/28 14:00
    );
    expect(reminder).toEqual({
      reminderAtBeijing: '2028-02-28 14:55',
      occurrenceAtBeijing: '2028-02-28 15:00',
      targetDate: '2028-03-06',
    });
  });

  it('清晨 07:00 放号（UTC 小时为负、回卷前一日）仍落正确日历格', () => {
    const reminder = enqueueReminder(
      makeTask('2026-07-26', '2026-08-02'),
      Date.parse('2026-07-19T00:00:00.000Z'), // 北京 7/19 08:00，当日 07:00 已过
      '07:00',
    );
    expect(reminder).toEqual({
      reminderAtBeijing: '2026-07-20 06:55',
      occurrenceAtBeijing: '2026-07-20 07:00',
      targetDate: '2026-07-27',
    });
  });
});
