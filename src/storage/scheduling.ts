import { createHash, randomUUID } from 'node:crypto';

import type { SourceAdapter } from '../core/source-adapter.js';
import type { WatchTask } from '../core/watch-task.js';
import type { SqliteDatabase } from './database.js';
import type { SqliteJobRunner } from './job-runner.js';
import { listReleaseRules } from './release-rules.js';
import { sourceMinimumIntervalMs } from './source-runtime.js';

const PUMCH_ADAPTER_KEY = 'pumch-public-dermatology-schedule';

export function createSourceScopeKey(input: {
  adapterKey: string;
  hospitalId: string;
  campusId: string | null;
  departmentId: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.adapterKey,
        input.hospitalId,
        input.campusId,
        input.departmentId,
      ]),
    )
    .digest('hex');
}

export function scheduleWatchTask(
  database: SqliteDatabase,
  runner: SqliteJobRunner,
  task: WatchTask,
  adapters: Map<string, SourceAdapter>,
  now: number,
): void {
  if (!task.enabled) return;

  const pumchAdapter = adapters.get(PUMCH_ADAPTER_KEY);
  if (
    pumchAdapter &&
    task.hospitalId === 'hospital-pumch' &&
    task.departmentId === 'department-pumch-dermatology'
  ) {
    const scope = {
      adapterKey: PUMCH_ADAPTER_KEY,
      sourceId: 'source-pumch-public-schedule',
      hospitalId: task.hospitalId,
      campusId: task.campusId,
      departmentId: task.departmentId,
    };
    const scopeKey = createSourceScopeKey(scope);
    if (!runner.hasActiveSourceScopeJob(scopeKey)) {
      runner.enqueue({
        type: 'source-check',
        payload: {
          ...scope,
          scopeKey,
          minIntervalMs: sourceMinimumIntervalMs(
            PUMCH_ADAPTER_KEY,
            pumchAdapter.manifest.minIntervalMs,
          ),
        },
        runAt: now,
        dedupeKey: `source-check:${scopeKey}:${now}:${randomUUID()}`,
        maxAttempts: 3,
      });
    }
  }

  if (
    task.hospitalId !== 'hospital-tongren' ||
    task.departmentId !== 'department-tongren-rhinology' ||
    task.remindBeforeMinutes === null ||
    !task.eventTypes.includes('schedule_released')
  ) {
    return;
  }

  const rule = listReleaseRules(database).find(
    (candidate) =>
      candidate.enabled &&
      candidate.hospitalId === task.hospitalId &&
      candidate.campusId === task.campusId &&
      candidate.departmentId === task.departmentId,
  );
  if (!rule) return;

  const shifted = new Date(now + 8 * 60 * 60 * 1_000);
  const [hour, minute] = rule.releaseTimeLocal.split(':').map(Number) as [number, number];
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const occurrenceAt = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() + dayOffset,
      hour - 8,
      minute,
    );
    const reminderAt = occurrenceAt - task.remindBeforeMinutes * 60_000;
    if (reminderAt < now) continue;

    const target = new Date(
      Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate() + dayOffset + rule.advanceDays,
      ),
    );
    const targetDate = [
      target.getUTCFullYear(),
      String(target.getUTCMonth() + 1).padStart(2, '0'),
      String(target.getUTCDate()).padStart(2, '0'),
    ].join('-');
    if (targetDate < task.dateFrom || targetDate > task.dateTo) continue;

    if (runner.hasActiveTaskJob('release-reminder', task.id, task.version)) return;
    runner.enqueue({
      type: 'release-reminder',
      payload: {
        taskId: task.id,
        taskVersion: task.version,
        ruleId: rule.id,
        occurrenceAt,
        targetDate,
        officialEntryUrl: rule.officialEntryUrl,
        needsReconfirmation: rule.needsReconfirmation,
      },
      runAt: reminderAt,
      dedupeKey: `release-reminder:${task.id}:${task.version}:${rule.id}:${occurrenceAt}`,
      maxAttempts: 4,
    });
    break;
  }
}
