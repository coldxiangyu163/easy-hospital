import { createHash, randomUUID } from 'node:crypto';

import type { ReleaseRule } from '../core/release-rule.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { WatchTask } from '../core/watch-task.js';
import type { SqliteDatabase } from './database.js';
import type { SqliteJobRunner } from './job-runner.js';
import { failReleaseReminderBatchesForRule } from './notification-outbox.js';
import { listReleaseRules } from './release-rules.js';
import { sourceMinimumIntervalMs } from './source-runtime.js';
import { listWatchTasks } from './watch-tasks.js';

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
    // dedupeKey 含目标日期与官方入口哈希：规则改 advanceDays 或 URL 后，
    // 同 occurrence 的重排不会被旧 job（含已 complete 的）占住 dedupe 位。
    const urlHash = createHash('sha256')
      .update(rule.officialEntryUrl)
      .digest('hex')
      .slice(0, 12);
    runner.enqueue({
      type: 'release-reminder',
      payload: {
        taskId: task.id,
        taskVersion: task.version,
        ruleId: rule.id,
        occurrenceAt,
        reminderAt,
        targetDate,
        officialEntryUrl: rule.officialEntryUrl,
        needsReconfirmation: rule.needsReconfirmation,
      },
      runAt: reminderAt,
      dedupeKey: `release-reminder:${task.id}:${task.version}:${rule.id}:${occurrenceAt}:${targetDate}:${urlHash}`,
      maxAttempts: 4,
    });
    break;
  }
}

// 运行中 job 的规则一致性校验：payload 快照必须与当前 rule 计算出的
// occurrence（放号时刻 + 目标就诊日期）、scope 与官方入口一致。
// 任一不一致说明规则已在 job 入队后变更，旧 job 不得再发送。
export function releaseRuleMatchesOccurrence(
  rule: ReleaseRule,
  task: WatchTask,
  input: { occurrenceAt: number; targetDate: string; officialEntryUrl: string },
): boolean {
  if (
    rule.hospitalId !== task.hospitalId ||
    rule.campusId !== task.campusId ||
    rule.departmentId !== task.departmentId ||
    rule.officialEntryUrl !== input.officialEntryUrl
  ) {
    return false;
  }
  const [hour, minute] = rule.releaseTimeLocal.split(':').map(Number) as [number, number];
  const beijingOccurrence = new Date(input.occurrenceAt + 8 * 60 * 60 * 1_000);
  if (beijingOccurrence.getUTCHours() !== hour || beijingOccurrence.getUTCMinutes() !== minute) {
    return false;
  }
  const expectedTarget = new Date(
    Date.UTC(
      beijingOccurrence.getUTCFullYear(),
      beijingOccurrence.getUTCMonth(),
      beijingOccurrence.getUTCDate() + rule.advanceDays,
    ),
  );
  const expectedTargetDate = [
    expectedTarget.getUTCFullYear(),
    String(expectedTarget.getUTCMonth() + 1).padStart(2, '0'),
    String(expectedTarget.getUTCDate()).padStart(2, '0'),
  ].join('-');
  return expectedTargetDate === input.targetDate;
}

// 规则变更/删除时取消该规则所有 pending 提醒 job：旧时刻不再发送。
// 实现为物理删除 pending 行（而非置 cancelled）：job 表的 dedupe_key UNIQUE 会
// 拦截同 occurrence 的再次 enqueue，删除才能释放 dedupe 位，让 disable→enable
// 重排能重建相同时刻的 job；提醒发送历史以 notification_batch 为准，job 行不作审计。
// 已被 worker claim 的 running job 不在此处理（租约很短，且 worker 侧对 rule
// 不存在/停用仍 fail closed），属可接受的残余窗口。
export function cancelPendingReleaseReminderJobs(
  database: SqliteDatabase,
  ruleId: string,
  reason: 'RULE_CHANGED' | 'RULE_DELETED',
  now: number,
): number {
  // 先落地批次终态：首轮重试产生的 pending batch/delivery 必须诚实终结
  // （保留 sent / delivery_unknown），绝不随 job 删除而永久悬挂。
  failReleaseReminderBatchesForRule(database, ruleId, reason, now);
  return database
    .prepare(
      `DELETE FROM job
       WHERE type = 'release-reminder' AND state = 'pending'
         AND json_extract(payload_json, '$.ruleId') = ?`,
    )
    .run(ruleId).changes;
}

// 规则 PATCH 后重排：先取消旧 job，再按规则的当前状态为匹配 scope 的 enabled 任务
// 立即重排——改时间后新时刻产生新 job，disable 后不再排，enable 后无需重启即可恢复。
// scheduleWatchTask 内部会再次核对规则 enabled 与任务字段，幂等安全。
export function rescheduleReleaseRemindersForRule(
  database: SqliteDatabase,
  runner: SqliteJobRunner,
  adapters: Map<string, SourceAdapter>,
  rule: ReleaseRule,
  now: number,
): number {
  const cancelled = cancelPendingReleaseReminderJobs(database, rule.id, 'RULE_CHANGED', now);
  for (const task of listWatchTasks(database)) {
    if (!task.enabled) continue;
    if (
      task.hospitalId !== rule.hospitalId ||
      task.campusId !== rule.campusId ||
      task.departmentId !== rule.departmentId
    ) {
      continue;
    }
    scheduleWatchTask(database, runner, task, adapters, now);
  }
  return cancelled;
}
