import { randomUUID } from 'node:crypto';

import {
  sendNotification,
  type NotificationChannel,
  type NotificationMessage,
} from '../core/notification-channel.js';
import {
  findSourceBinding,
  isBoundSourceManifest,
  runSourceAdapter,
  sourceRateLimitKey,
  type SourceAdapter,
} from '../core/source-adapter.js';
import type { SqliteDatabase } from '../storage/database.js';
import { SqliteJobRunner, type PersistentJob } from '../storage/job-runner.js';
import { applyCheckResult, deleteMonitoringBaseline } from '../storage/monitoring.js';
import {
  cancelInvalidNotificationBatches,
  ensureReleaseReminderBatch,
  getDeliveryMessage,
  getNotificationDelivery,
  markDeliverySending,
  markDeliveryUnknown,
  prepareDueNotificationJobs,
  recordDeliveryResult,
  recoverAmbiguousSendingDeliveries,
  recordDeliveryRetry,
} from '../storage/notification-outbox.js';
import { getReleaseRule } from '../storage/release-rules.js';
import { runDataRetention } from '../storage/retention.js';
import {
  createSourceScopeKey,
  getEnabledReleaseRuleForScope,
  releaseRuleMatchesOccurrence,
  scheduleWatchTask,
} from '../storage/scheduling.js';
import {
  recordSourceAttempt,
  recordSourceFailure,
  recordSourceResult,
  recordSourceScopeAttempt,
  sourceMinimumIntervalMs,
  sourceRetryAfterMs,
  sourceScopeNeedsRebaseline,
} from '../storage/source-runtime.js';
import { getWatchTask, listWatchTasks } from '../storage/watch-tasks.js';

export type WorkerHealth = {
  status: 'healthy' | 'degraded' | 'stopped';
  running: boolean;
  lastHeartbeatAt: string;
  lastErrorCode: string | null;
  heartbeatGapMs: number | null;
  // 最近一次因监测空窗而删除基线并静默重建的时间（北京时间轮询读模型，供 UI 展示空窗）。
  lastRebaselineAt: string | null;
};

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type SourceCheckJobPayload = {
  adapterKey: string;
  sourceId: string;
  scopeKey: string;
  hospitalId: string;
  campusId: string | null;
  departmentId: string;
  minIntervalMs: number;
};

export class LocalWorker {
  private readonly runner: SqliteJobRunner;
  private readonly channels: Map<string, NotificationChannel>;
  private readonly sourceAdapters: Map<string, SourceAdapter>;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private ticking = false;
  private activeTick: Promise<void> = Promise.resolve();
  private lastHeartbeat = 0;
  private lastErrorCode: string | null = null;
  private heartbeatGapMs: number | null = null;
  private lastRebaselineAt: number | null = null;
  private lastRetentionAt: number | null = null;

  constructor(
    private readonly database: SqliteDatabase,
    notificationChannels: NotificationChannel[],
    sourceAdapters: SourceAdapter[],
    private readonly pollMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {
    this.runner = new SqliteJobRunner(database);
    this.channels = new Map(notificationChannels.map((channel) => [channel.key, channel]));
    this.sourceAdapters = new Map(
      sourceAdapters.map((adapter) => [adapter.manifest.adapterKey, adapter]),
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastHeartbeat = this.now();
    this.timer = setInterval(() => {
      this.requestTick();
    }, this.pollMs);
    this.timer.unref();
    this.requestTick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
    await this.activeTick;
  }

  health(): WorkerHealth {
    // heartbeat gap 必须在读取时现场计算：tick 卡死（如 adapter 不返回）时
    // lastHeartbeat 不再推进，只有读时比对才能让 health 如实报 degraded。
    const heartbeatTimeoutMs = Math.max(30_000, this.pollMs * 3);
    const liveGapMs =
      this.running && this.lastHeartbeat > 0
        ? Math.max(0, this.now() - this.lastHeartbeat)
        : null;
    const stale = liveGapMs !== null && liveGapMs > heartbeatTimeoutMs;
    return {
      status: this.running
        ? this.lastErrorCode || stale
          ? 'degraded'
          : 'healthy'
        : 'stopped',
      running: this.running,
      lastHeartbeatAt: new Date(this.lastHeartbeat).toISOString(),
      lastErrorCode: this.lastErrorCode,
      heartbeatGapMs: stale ? liveGapMs : this.heartbeatGapMs,
      lastRebaselineAt:
        this.lastRebaselineAt === null ? null : new Date(this.lastRebaselineAt).toISOString(),
    };
  }

  private requestTick(): void {
    if (!this.running || this.ticking) return;
    this.activeTick = this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    const now = this.now();
    const previousHeartbeat = this.lastHeartbeat;
    const heartbeatGapMs = Math.max(0, now - previousHeartbeat);
    const detectedHeartbeatGap =
      previousHeartbeat > 0 &&
      heartbeatGapMs > Math.max(30_000, this.pollMs * 3);
    this.lastHeartbeat = now;
    let tickErrorCode: string | null = null;

    try {
      recoverAmbiguousSendingDeliveries(this.database, now);
      cancelInvalidNotificationBatches(this.database, now);
      prepareDueNotificationJobs(this.database, this.runner, [...this.channels.keys()], now);
      if (
        this.lastRetentionAt === null ||
        now - this.lastRetentionAt >= RETENTION_INTERVAL_MS
      ) {
        runDataRetention(this.database, now);
        this.lastRetentionAt = now;
      }
      const job = this.runner.claimNext({ now, leaseMs: 30_000 });
      if (!job) return;

      if (job.type === 'source-check') {
        await this.runSourceCheck(job, now);
        return;
      }
      if (job.type === 'notification') {
        await this.runNotification(job, now);
        return;
      }
      if (job.type === 'release-reminder') {
        await this.runReleaseReminder(job, now);
        return;
      }

      this.runner.fail(job.id, {
        now,
        errorCode: 'UNSUPPORTED_JOB_TYPE',
        retryAt: now + 60_000,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      tickErrorCode =
        typeof code === 'string' && code.startsWith('SQLITE_BUSY')
          ? 'SQLITE_BUSY'
          : 'WORKER_TICK_FAILED';
    } finally {
      if (tickErrorCode) {
        this.lastErrorCode = tickErrorCode;
        this.heartbeatGapMs = detectedHeartbeatGap ? heartbeatGapMs : null;
      } else if (detectedHeartbeatGap) {
        this.lastErrorCode = 'WORKER_HEARTBEAT_GAP';
        this.heartbeatGapMs = heartbeatGapMs;
      } else if (
        now > previousHeartbeat ||
        this.lastErrorCode !== 'WORKER_HEARTBEAT_GAP'
      ) {
        this.lastErrorCode = null;
        this.heartbeatGapMs = null;
      }
      this.ticking = false;
    }
  }

  private async runSourceCheck(job: PersistentJob, now: number): Promise<void> {
    const payload = job.payload as Partial<SourceCheckJobPayload>;
    const adapter = payload.adapterKey
      ? this.sourceAdapters.get(payload.adapterKey)
      : undefined;
    const binding = adapter
      ? findSourceBinding(adapter.manifest, {
          hospitalId: payload.hospitalId ?? '',
          campusId: payload.campusId ?? null,
          departmentId: payload.departmentId ?? '',
        })
      : undefined;
    if (
      !adapter ||
      !isBoundSourceManifest(adapter.manifest) ||
      !binding ||
      payload.sourceId !== adapter.manifest.sourceId ||
      !payload.scopeKey ||
      payload.scopeKey !==
        createSourceScopeKey({
          adapterKey: adapter.manifest.adapterKey,
          hospitalId: binding.hospitalId,
          campusId: binding.campusId,
          departmentId: binding.departmentId,
        })
    ) {
      this.runner.complete(job.id, now);
      return;
    }

    const sourcePayload: SourceCheckJobPayload = {
      adapterKey: adapter.manifest.adapterKey,
      sourceId: adapter.manifest.sourceId,
      scopeKey: payload.scopeKey,
      hospitalId: binding.hospitalId,
      campusId: binding.campusId,
      departmentId: binding.departmentId,
      minIntervalMs:
        sourceMinimumIntervalMs(adapter.manifest.minIntervalMs) *
        adapter.manifest.bindings.length,
    };

    const beijingNow = new Date(now + 8 * 60 * 60 * 1_000);
    const today = [
      beijingNow.getUTCFullYear(),
      String(beijingNow.getUTCMonth() + 1).padStart(2, '0'),
      String(beijingNow.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const tasks = listWatchTasks(this.database).filter(
      (task) =>
        task.enabled &&
        task.hospitalId === sourcePayload.hospitalId &&
        task.campusId === sourcePayload.campusId &&
        task.departmentId === sourcePayload.departmentId &&
        task.dateTo >= today,
    );
    if (tasks.length === 0) {
      this.runner.complete(job.id, now);
      return;
    }

    const dateFrom = tasks.reduce(
      (earliest, task) => (task.dateFrom < earliest ? task.dateFrom : earliest),
      tasks[0]!.dateFrom,
    );
    const dateTo = tasks.reduce(
      (latest, task) => (task.dateTo > latest ? task.dateTo : latest),
      tasks[0]!.dateTo,
    );
    const scopeIntervalMs = sourcePayload.minIntervalMs;
    const domainIntervalMs = sourceMinimumIntervalMs(adapter.manifest.minIntervalMs);
    const rateLimitKey = sourceRateLimitKey(adapter.manifest);
    const retryAfterMs = sourceRetryAfterMs(this.database, rateLimitKey, now);
    if (retryAfterMs > 0) {
      this.runner.complete(job.id, now);
      this.enqueueNextSourceCheck(sourcePayload, now + retryAfterMs);
      return;
    }

    // rateLimitKey 只负责同域低频节流；空窗判断必须按 target scope 独立记录，
    // 否则同一 adapter 的另一个 binding 会刷新 adapter-wide lastAttemptAt，导致
    // 本 scope 错过 rebaseline。
    const rebaseline = sourceScopeNeedsRebaseline(
      this.database,
      sourcePayload.scopeKey,
      now,
      scopeIntervalMs,
    );
    if (rebaseline) {
      deleteMonitoringBaseline(this.database, sourcePayload.sourceId, sourcePayload.scopeKey);
      this.lastRebaselineAt = now;
    }

    recordSourceAttempt(this.database, rateLimitKey, now, domainIntervalMs);
    recordSourceScopeAttempt(this.database, {
      scopeKey: sourcePayload.scopeKey,
      adapterKey: adapter.manifest.adapterKey,
      sourceId: adapter.manifest.sourceId,
      now,
    });

    try {
      const request = {
        requestId: randomUUID(),
        sourceId: sourcePayload.sourceId,
        hospitalId: sourcePayload.hospitalId,
        campusId: sourcePayload.campusId,
        departmentId: sourcePayload.departmentId,
        dateFrom,
        dateTo,
        doctorName: null,
        titles: [],
        session: 'ANY' as const,
        deadlineAt: new Date(now + 30_000).toISOString(),
      };
      const result = await runSourceAdapter(adapter, request);
      const minRateAllowedAt = now + domainIntervalMs;
      const nextScopeAt = now + scopeIntervalMs;
      recordSourceResult(
        this.database,
        rateLimitKey,
        result,
        minRateAllowedAt,
      );
      applyCheckResult(this.database, {
        sourceId: request.sourceId,
        scopeKey: sourcePayload.scopeKey,
        requestId: request.requestId,
        result,
        rebaseline,
      });
      this.runner.complete(job.id, this.now());

      const resultNextAllowedAt = result.nextAllowedAt
        ? Date.parse(result.nextAllowedAt)
        : minRateAllowedAt;
      this.enqueueNextSourceCheck(
        sourcePayload,
        Math.max(nextScopeAt, resultNextAllowedAt),
      );
    } catch {
      const failedAt = this.now();
      recordSourceFailure(
        this.database,
        rateLimitKey,
        'SOURCE_CHECK_FAILED',
        failedAt + domainIntervalMs,
      );
      this.runner.fail(job.id, {
        now: failedAt,
        errorCode: 'SOURCE_CHECK_FAILED',
        retryAt: failedAt + scopeIntervalMs,
      });
      if (job.attempts >= job.maxAttempts) {
        this.enqueueNextSourceCheck(sourcePayload, failedAt + scopeIntervalMs);
      }
    }
  }

  private enqueueNextSourceCheck(payload: SourceCheckJobPayload, runAt: number): void {
    this.runner.enqueue({
      type: 'source-check',
      payload,
      runAt,
      dedupeKey: `source-check:${payload.scopeKey}:${runAt}:${randomUUID()}`,
      maxAttempts: 3,
    });
  }

  private async runReleaseReminder(job: PersistentJob, now: number): Promise<void> {
    const payload = job.payload as {
      taskId?: string;
      taskVersion?: number;
      ruleId?: string;
      occurrenceAt?: number;
      reminderAt?: number;
      targetDate?: string;
      officialEntryUrl?: string;
      needsReconfirmation?: boolean;
    };
    const task = payload.taskId ? getWatchTask(this.database, payload.taskId) : undefined;
    const rule = payload.ruleId ? getReleaseRule(this.database, payload.ruleId) : undefined;
    if (
      !task ||
      !task.enabled ||
      task.version !== payload.taskVersion ||
      !payload.occurrenceAt ||
      !payload.targetDate ||
      !payload.officialEntryUrl
    ) {
      this.runner.complete(job.id, now);
      return;
    }
    const selectedRule = getEnabledReleaseRuleForScope(this.database, task);
    if (!rule || !rule.enabled || selectedRule?.id !== rule.id) {
      this.runner.complete(job.id, now);
      scheduleWatchTask(this.database, this.runner, task, this.sourceAdapters, now);
      return;
    }
    // reminderAt 是不可变的首次计划时刻：job.runAt 会被重试退避和
    // LEASE_EXPIRED 恢复改写，不能作为批次起点。旧 payload 缺少 reminderAt 时
    // 用 occurrenceAt 与任务当时的 remindBeforeMinutes（version 已校验）推导。
    const scheduledReminderAt =
      typeof payload.reminderAt === 'number'
        ? payload.reminderAt
        : payload.occurrenceAt - (task.remindBeforeMinutes ?? 0) * 60_000;
    const channelKeys = [...this.channels.keys()];
    const reminderBatchInput = {
      taskId: task.id,
      taskVersion: task.version,
      ruleId: rule.id,
      reminderAt: scheduledReminderAt,
      occurrenceAt: payload.occurrenceAt,
      targetDate: payload.targetDate,
      officialEntryUrl: payload.officialEntryUrl,
      needsReconfirmation: rule.needsReconfirmation,
      channelKeys,
    };
    const finishExpiredReminder = (
      reason: 'RELEASE_REMINDER_MISSED' | 'RELEASE_REMINDER_RETRY_EXPIRED',
      expiredAt: number,
    ): void => {
      if (reason === 'RELEASE_REMINDER_RETRY_EXPIRED') {
        const batch = ensureReleaseReminderBatch(
          this.database,
          reminderBatchInput,
          expiredAt,
        );
        // 已尝试 delivery 先保留最后渠道错误并转 failed；随后 ensure 只会给
        // 从未尝试的 pending delivery 写入统一 deadline 原因。
        this.database
          .prepare(
            `UPDATE notification_delivery
             SET state = 'failed', updated_at = ?
             WHERE batch_id = ? AND state = 'pending' AND attempts > 0`,
          )
          .run(expiredAt, batch.id);
      }
      ensureReleaseReminderBatch(
        this.database,
        { ...reminderBatchInput, terminalReason: reason },
        expiredAt,
      );
      this.runner.complete(job.id, expiredAt);
      scheduleWatchTask(
        this.database,
        this.runner,
        task,
        this.sourceAdapters,
        expiredAt + 1,
      );
    };
    // 规则一致性校验：payload 快照与当前 rule 计算出的 occurrence/官方入口不一致时，
    // 该 job 基于的是旧规则——0 发送、已有批次转终态、按当前规则重排。
    if (
      !releaseRuleMatchesOccurrence(rule, task, {
        occurrenceAt: payload.occurrenceAt,
        targetDate: payload.targetDate,
        officialEntryUrl: payload.officialEntryUrl,
      })
    ) {
      ensureReleaseReminderBatch(
        this.database,
        {
          taskId: task.id,
          taskVersion: task.version,
          ruleId: rule.id,
          reminderAt: scheduledReminderAt,
          occurrenceAt: payload.occurrenceAt,
          targetDate: payload.targetDate,
          officialEntryUrl: payload.officialEntryUrl,
          needsReconfirmation: rule.needsReconfirmation,
          channelKeys: [...this.channels.keys()],
          terminalReason: 'RULE_CHANGED',
        },
        now,
      );
      this.runner.complete(job.id, now);
      scheduleWatchTask(this.database, this.runner, task, this.sourceAdapters, now);
      return;
    }
    if (now > payload.occurrenceAt) {
      const existingBatch = this.database
        .prepare(
          `SELECT
             nb.state,
             EXISTS (
               SELECT 1 FROM notification_delivery nd
               WHERE nd.batch_id = nb.id
                 AND nd.state = 'pending'
                 AND nd.attempts > 0
                 AND nd.last_error_code IS NOT NULL
             ) AS retryable_pending,
             EXISTS (
               SELECT 1 FROM notification_delivery nd
               WHERE nd.batch_id = nb.id AND nd.attempts > 0
             ) AS attempted
           FROM notification_batch nb
           WHERE nb.task_id = ?
             AND nb.official_entry_url = ?
             AND json_extract(nb.event_ids_json, '$.kind') = 'release-reminder'
             AND json_extract(nb.event_ids_json, '$.occurrenceAt') = ?
             AND json_extract(nb.event_ids_json, '$.targetDate') = ?
           LIMIT 1`,
        )
        .get(
          task.id,
          payload.officialEntryUrl,
          payload.occurrenceAt,
          payload.targetDate,
        ) as
        | { state: string; retryable_pending: 0 | 1; attempted: 0 | 1 }
        | undefined;
      if (existingBatch?.retryable_pending === 1) {
        finishExpiredReminder('RELEASE_REMINDER_RETRY_EXPIRED', now);
        return;
      }
      if (
        existingBatch &&
        (existingBatch.attempted === 1 ||
          ['failed', 'sent', 'delivery_unknown'].includes(existingBatch.state))
      ) {
        this.runner.complete(job.id, now);
        scheduleWatchTask(this.database, this.runner, task, this.sourceAdapters, now + 1);
        return;
      }
      finishExpiredReminder('RELEASE_REMINDER_MISSED', now);
      return;
    }
    if (channelKeys.length === 0) {
      ensureReleaseReminderBatch(
        this.database,
        {
          taskId: task.id,
          taskVersion: task.version,
          ruleId: rule.id,
          reminderAt: scheduledReminderAt,
          occurrenceAt: payload.occurrenceAt,
          targetDate: payload.targetDate,
          officialEntryUrl: payload.officialEntryUrl,
          needsReconfirmation: rule.needsReconfirmation,
          channelKeys,
          terminalReason: 'NOTIFICATION_CHANNEL_NOT_FOUND',
        },
        now,
      );
      this.runner.complete(job.id, now);
      scheduleWatchTask(this.database, this.runner, task, this.sourceAdapters, now + 1);
      return;
    }

    const batch = ensureReleaseReminderBatch(
      this.database,
      {
        taskId: task.id,
        taskVersion: task.version,
        ruleId: rule.id,
        reminderAt: scheduledReminderAt,
        occurrenceAt: payload.occurrenceAt,
        targetDate: payload.targetDate,
        officialEntryUrl: payload.officialEntryUrl,
        needsReconfirmation: rule.needsReconfirmation,
        channelKeys,
      },
      now,
    );
    const scope = this.database
      .prepare(
        `SELECT h.name AS hospital_name, c.name AS campus_name, d.name AS department_name
         FROM watch_task wt
         JOIN hospital h ON h.id = wt.hospital_id
         LEFT JOIN campus c ON c.id = wt.campus_id
         JOIN department d ON d.id = wt.department_id
         WHERE wt.id = ?`,
      )
      .get(task.id) as
      | { hospital_name: string; campus_name: string | null; department_name: string }
      | undefined;
    const scopeText =
      [scope?.hospital_name, scope?.campus_name, scope?.department_name]
        .filter((part): part is string => Boolean(part))
        .join(' · ') || '关注任务';
    const verifiedDate = rule.verifiedAt.slice(0, 10);
    // 正文渲染一律读取当前 rule（needsReconfirmation / 官方入口 / 放号时间 / 核验日期），
    // 避免 payload 快照在规则非时刻字段更新后产生陈旧内容。
    const warning = rule.needsReconfirmation
      ? '该规则需要重新核验，请以医院官方渠道为准。'
      : '请以医院官方渠道为准。';
    let retryableError: string | undefined;
    let terminalRetryError: string | undefined;

    for (const delivery of batch.deliveries) {
      if (
        delivery.state === 'sent' ||
        delivery.state === 'delivery_unknown' ||
        delivery.state === 'failed'
      ) {
        continue;
      }
      if (delivery.state === 'sending') {
        markDeliveryUnknown(
          this.database,
          delivery.id,
          'DELIVERY_STATE_AMBIGUOUS',
          now,
        );
        continue;
      }

      const channel = this.channels.get(delivery.channel);
      if (!channel) {
        if (markDeliverySending(this.database, delivery.id, now)) {
          recordDeliveryResult(
            this.database,
            delivery.id,
            { status: 'rejected', errorCode: 'NOTIFICATION_CHANNEL_NOT_FOUND', retryable: false },
            now,
          );
        }
        continue;
      }

      const message: NotificationMessage = {
        messageId: delivery.messageId,
        subject: '放号前规则提醒',
        text: `${scopeText}\n预计 ${rule.releaseTimeLocal} 放号，目标就诊日期 ${payload.targetDate}。${warning}\n规则最后核验日期：${verifiedDate}；本提醒不代替人工预约，请前往官方入口自行完成预约。`,
        officialEntryUrl: rule.officialEntryUrl,
        eventTags: ['schedule_released'],
        detectedAt: new Date(now).toISOString(),
      };
      if (!markDeliverySending(this.database, delivery.id, now)) continue;
      let result;
      try {
        result = await sendNotification(channel, message);
      } catch {
        result = { status: 'unknown' as const, errorCode: 'CHANNEL_DELIVERY_UNKNOWN' };
      }
      const completedAt = this.now();
      if (result.status === 'rejected' && result.retryable) {
        if (job.attempts < job.maxAttempts) {
          recordDeliveryRetry(
            this.database,
            delivery.id,
            result.errorCode,
            completedAt,
          );
          retryableError ??= result.errorCode;
        } else {
          recordDeliveryResult(this.database, delivery.id, result, completedAt);
          terminalRetryError ??= result.errorCode;
        }
      } else {
        recordDeliveryResult(this.database, delivery.id, result, completedAt);
      }
    }

    if (retryableError) {
      const retryDelays = [60_000, 5 * 60_000, 15 * 60_000];
      const retryDelay = retryDelays[job.attempts - 1] ?? 15 * 60_000;
      const retryNow = this.now();
      if (now === payload.occurrenceAt || retryNow > payload.occurrenceAt) {
        finishExpiredReminder('RELEASE_REMINDER_RETRY_EXPIRED', retryNow);
        return;
      }
      this.runner.fail(job.id, {
        now: retryNow,
        errorCode: retryableError,
        retryAt: Math.min(retryNow + retryDelay, payload.occurrenceAt),
      });
      return;
    }

    if (terminalRetryError) {
      const failedAt = this.now();
      this.runner.fail(job.id, {
        now: failedAt,
        errorCode: terminalRetryError,
        retryAt: failedAt,
      });
      scheduleWatchTask(
        this.database,
        this.runner,
        task,
        this.sourceAdapters,
        failedAt + 1,
      );
      return;
    }

    this.runner.complete(job.id, this.now());
    scheduleWatchTask(
      this.database,
      this.runner,
      task,
      this.sourceAdapters,
      this.now() + 1,
    );
  }

  private async runNotification(job: PersistentJob, now: number): Promise<void> {
    const payload = job.payload as { deliveryId?: string; channelKey?: string };
    if (!payload.deliveryId || !payload.channelKey) {
      this.runner.fail(job.id, {
        now,
        errorCode: 'INVALID_JOB_PAYLOAD',
        retryAt: now + 60_000,
      });
      return;
    }

    const deliveryState = getNotificationDelivery(this.database, payload.deliveryId);
    if (!deliveryState) {
      this.runner.complete(job.id, now);
      return;
    }
    if (
      deliveryState.state === 'sent' ||
      deliveryState.state === 'delivery_unknown' ||
      deliveryState.state === 'failed'
    ) {
      this.runner.complete(job.id, now);
      return;
    }
    if (deliveryState.state === 'sending') {
      markDeliveryUnknown(
        this.database,
        payload.deliveryId,
        'DELIVERY_STATE_AMBIGUOUS',
        now,
      );
      this.runner.complete(job.id, now);
      return;
    }

    const delivery = getDeliveryMessage(this.database, payload.deliveryId);
    const channel = this.channels.get(payload.channelKey);
    if (!delivery || !channel) {
      const errorCode = delivery
        ? 'NOTIFICATION_CHANNEL_NOT_FOUND'
        : 'NOTIFICATION_CONTEXT_NOT_FOUND';
      if (markDeliverySending(this.database, payload.deliveryId, now)) {
        recordDeliveryResult(
          this.database,
          payload.deliveryId,
          { status: 'rejected', errorCode, retryable: false },
          now,
        );
      }
      this.runner.complete(job.id, now);
      return;
    }

    if (!markDeliverySending(this.database, payload.deliveryId, now)) {
      this.runner.complete(job.id, now);
      return;
    }
    let result;
    try {
      result = await sendNotification(channel, delivery.message);
    } catch {
      result = { status: 'unknown' as const, errorCode: 'CHANNEL_DELIVERY_UNKNOWN' };
    }
    const completedAt = this.now();

    if (result.status === 'rejected' && result.retryable) {
      if (job.attempts < job.maxAttempts) {
        const retryDelays = [60_000, 5 * 60_000, 15 * 60_000];
        const retryDelay = retryDelays[job.attempts - 1] ?? 15 * 60_000;
        recordDeliveryRetry(
          this.database,
          payload.deliveryId,
          result.errorCode,
          completedAt,
        );
        this.runner.fail(job.id, {
          now: completedAt,
          errorCode: result.errorCode,
          retryAt: completedAt + retryDelay,
        });
        return;
      }

      recordDeliveryResult(this.database, payload.deliveryId, result, completedAt);
      this.runner.fail(job.id, {
        now: completedAt,
        errorCode: result.errorCode,
        retryAt: completedAt,
      });
      return;
    }

    recordDeliveryResult(this.database, payload.deliveryId, result, completedAt);
    this.runner.complete(job.id, completedAt);
  }
}
