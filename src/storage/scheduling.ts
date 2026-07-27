import { createHash, randomUUID } from 'node:crypto';

import type { ReleaseRule } from '../core/release-rule.js';
import { targetSupportsRuleReminders } from '../core/target-support.js';
import {
  findSourceBinding,
  isBoundSourceManifest,
  type SourceAdapter,
} from '../core/source-adapter.js';
import type { WatchTask } from '../core/watch-task.js';
import { resolveCatalogScope } from './catalog.js';
import type { SqliteDatabase } from './database.js';
import type { SqliteJobRunner } from './job-runner.js';
import { failReleaseReminderBatchesForRule } from './notification-outbox.js';
import { listReleaseRules } from './release-rules.js';
import { sourceMinimumIntervalMs } from './source-runtime.js';
import { listWatchTasks } from './watch-tasks.js';

type ReleaseRuleScope = {
  hospitalId: string;
  campusId: string | null;
  departmentId: string;
};

function matchesReleaseRuleScope(
  candidate: ReleaseRuleScope,
  scope: ReleaseRuleScope,
): boolean {
  return (
    candidate.hospitalId === scope.hospitalId &&
    candidate.campusId === scope.campusId &&
    candidate.departmentId === scope.departmentId
  );
}

export function getEnabledReleaseRuleForScope(
  database: SqliteDatabase,
  scope: ReleaseRuleScope,
): ReleaseRule | undefined {
  return listReleaseRules(database).find(
    (candidate) => candidate.enabled && matchesReleaseRuleScope(candidate, scope),
  );
}

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

export type WatchTaskSchedulingResult = {
  status:
    | 'scheduled'
    | 'inactive'
    | 'unsupported-target'
    | 'source-unavailable'
    | 'rule-unavailable'
    | 'not-scheduled';
};

export function scheduleWatchTask(
  database: SqliteDatabase,
  runner: SqliteJobRunner,
  task: WatchTask,
  adapters: Map<string, SourceAdapter>,
  now: number,
): WatchTaskSchedulingResult {
  if (!task.enabled) return { status: 'inactive' };

  const target = resolveCatalogScope(database, task);
  if (!target || !target.support.canCreateWatchTask) {
    return { status: 'unsupported-target' };
  }

  if (target.support.supportMode === 'public-source') {
    let sourceBound = false;
    for (const adapter of adapters.values()) {
      if (!isBoundSourceManifest(adapter.manifest)) continue;
      const binding = findSourceBinding(adapter.manifest, {
        targetId: target.targetId,
        hospitalId: task.hospitalId,
        campusId: task.campusId,
        departmentId: task.departmentId,
      });
      if (!binding) continue;
      sourceBound = true;

      const scope = {
        adapterKey: adapter.manifest.adapterKey,
        sourceId: adapter.manifest.sourceId,
        hospitalId: binding.hospitalId,
        campusId: binding.campusId,
        departmentId: binding.departmentId,
      };
      const scopeKey = createSourceScopeKey(scope);
      if (runner.hasActiveSourceScopeJob(scopeKey)) continue;
      runner.enqueue({
        type: 'source-check',
        payload: {
          ...scope,
          scopeKey,
          // 单域所有 binding 串行轮转；每个 scope 的有效周期按 binding 数扩展，
          // 避免第一个 scope 的 recurrence 与被节流 scope 同时到期而长期饿死后者。
          minIntervalMs:
            sourceMinimumIntervalMs(adapter.manifest.minIntervalMs) *
            adapter.manifest.bindings.length,
        },
        runAt: now,
        dedupeKey: `source-check:${scopeKey}:${now}:${randomUUID()}`,
        maxAttempts: 3,
      });
    }
    return { status: sourceBound ? 'scheduled' : 'source-unavailable' };
  }

  if (
    !targetSupportsRuleReminders(target.support) ||
    task.remindBeforeMinutes === null ||
    !task.eventTypes.includes('schedule_released')
  ) {
    return { status: 'not-scheduled' };
  }

  const rule = getEnabledReleaseRuleForScope(database, task);
  if (!rule) return { status: 'rule-unavailable' };

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
    if (occurrenceAt < now) continue;

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

    const existingBatch = database
      .prepare(
        `SELECT 1 FROM notification_batch
         WHERE task_id = ?
           AND json_extract(event_ids_json, '$.kind') = 'release-reminder'
           AND json_extract(event_ids_json, '$.occurrenceAt') = ?
           AND json_extract(event_ids_json, '$.targetDate') = ?
           AND official_entry_url = ?
         LIMIT 1`,
      )
      .get(task.id, occurrenceAt, targetDate, rule.officialEntryUrl);
    if (existingBatch) continue;

    if (runner.hasActiveTaskJob('release-reminder', task.id, task.version)) {
      return { status: 'scheduled' };
    }
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
      runAt: Math.max(reminderAt, now),
      dedupeKey: `release-reminder:${task.id}:${task.version}:${rule.id}:${occurrenceAt}:${targetDate}:${urlHash}`,
      maxAttempts: 4,
    });
    return { status: 'scheduled' };
  }
  return { status: 'not-scheduled' };
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
// 已被 worker claim 的 running job 不在此处理；worker 发送前会校验当前首选规则，
// 旧 job 终止后再为仍有效任务补排当前规则。
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

// 规则增删改后按 scope 收敛到唯一生效规则。规则按 listReleaseRules 的
// created_at/id 顺序选择；若更早规则进入 scope，会取消后到规则的 pending job。
// running job 由 worker 在发送前再次校验并在终止后补排。
export function reconcileReleaseReminderScopes(
  database: SqliteDatabase,
  runner: SqliteJobRunner,
  adapters: Map<string, SourceAdapter>,
  scopes: ReleaseRuleScope[],
  now: number,
  invalidatedRules: Array<{
    id: string;
    reason: 'RULE_CHANGED' | 'RULE_DELETED';
  }> = [],
): number {
  let cancelled = 0;
  const cancelledRuleIds = new Set<string>();
  const cancelRule = (
    ruleId: string,
    reason: 'RULE_CHANGED' | 'RULE_DELETED',
  ): void => {
    if (cancelledRuleIds.has(ruleId)) return;
    cancelledRuleIds.add(ruleId);
    cancelled += cancelPendingReleaseReminderJobs(database, ruleId, reason, now);
  };
  for (const rule of invalidatedRules) cancelRule(rule.id, rule.reason);

  const uniqueScopes = [
    ...new Map(
      scopes.map((scope) => [
        JSON.stringify([scope.hospitalId, scope.campusId, scope.departmentId]),
        scope,
      ]),
    ).values(),
  ];
  const tasks = listWatchTasks(database);
  const pendingJobs = database
    .prepare(
      `SELECT
         json_extract(payload_json, '$.taskId') AS task_id,
         json_extract(payload_json, '$.ruleId') AS rule_id
       FROM job
       WHERE type = 'release-reminder' AND state = 'pending'`,
    )
    .all() as Array<{ task_id: string | null; rule_id: string | null }>;

  for (const scope of uniqueScopes) {
    const scopeTasks = tasks.filter((task) => matchesReleaseRuleScope(task, scope));
    const scopeTaskIds = new Set(scopeTasks.map((task) => task.id));
    const selectedRule = getEnabledReleaseRuleForScope(database, scope);
    for (const job of pendingJobs) {
      if (
        job.task_id &&
        job.rule_id &&
        scopeTaskIds.has(job.task_id) &&
        job.rule_id !== selectedRule?.id
      ) {
        cancelRule(job.rule_id, 'RULE_CHANGED');
      }
    }
    for (const task of scopeTasks) {
      if (task.enabled) scheduleWatchTask(database, runner, task, adapters, now);
    }
  }
  return cancelled;
}

export function rescheduleReleaseRemindersForRule(
  database: SqliteDatabase,
  runner: SqliteJobRunner,
  adapters: Map<string, SourceAdapter>,
  rule: ReleaseRule,
  now: number,
): number {
  return reconcileReleaseReminderScopes(database, runner, adapters, [rule], now, [
    { id: rule.id, reason: 'RULE_CHANGED' },
  ]);
}
