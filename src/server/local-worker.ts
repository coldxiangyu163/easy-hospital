import { randomUUID } from 'node:crypto';

import {
  sendNotification,
  type NotificationChannel,
  type NotificationMessage,
} from '../core/notification-channel.js';
import { runSourceAdapter, type SourceAdapter } from '../core/source-adapter.js';
import type { SqliteDatabase } from '../storage/database.js';
import { SqliteJobRunner, type PersistentJob } from '../storage/job-runner.js';
import { applyCheckResult } from '../storage/monitoring.js';
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
import { createSourceScopeKey, scheduleWatchTask } from '../storage/scheduling.js';
import {
  recordSourceAttempt,
  recordSourceFailure,
  recordSourceResult,
  sourceMinimumIntervalMs,
  sourceRetryAfterMs,
} from '../storage/source-runtime.js';
import { getWatchTask, listWatchTasks } from '../storage/watch-tasks.js';

export type WorkerHealth = {
  status: 'healthy' | 'degraded' | 'stopped';
  running: boolean;
  lastHeartbeatAt: string;
  lastErrorCode: string | null;
  heartbeatGapMs: number | null;
};

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
    return {
      status: this.running
        ? this.lastErrorCode
          ? 'degraded'
          : 'healthy'
        : 'stopped',
      running: this.running,
      lastHeartbeatAt: new Date(this.lastHeartbeat).toISOString(),
      lastErrorCode: this.lastErrorCode,
      heartbeatGapMs: this.heartbeatGapMs,
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
    if (
      !adapter ||
      !payload.sourceId ||
      !payload.scopeKey ||
      !payload.hospitalId ||
      !payload.departmentId ||
      payload.scopeKey !==
        createSourceScopeKey({
          adapterKey: payload.adapterKey!,
          hospitalId: payload.hospitalId,
          campusId: payload.campusId ?? null,
          departmentId: payload.departmentId,
        })
    ) {
      this.runner.complete(job.id, now);
      return;
    }

    const beijingNow = new Date(now + 8 * 60 * 60 * 1_000);
    const today = [
      beijingNow.getUTCFullYear(),
      String(beijingNow.getUTCMonth() + 1).padStart(2, '0'),
      String(beijingNow.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const tasks = listWatchTasks(this.database).filter(
      (task) =>
        task.enabled &&
        task.hospitalId === payload.hospitalId &&
        task.campusId === (payload.campusId ?? null) &&
        task.departmentId === payload.departmentId &&
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
    const minIntervalMs = sourceMinimumIntervalMs(
      adapter.manifest.adapterKey,
      adapter.manifest.minIntervalMs,
    );
    const retryAfterMs = sourceRetryAfterMs(this.database, adapter.manifest.adapterKey, now);
    if (retryAfterMs > 0) {
      this.runner.complete(job.id, now);
      this.enqueueNextSourceCheck(payload as SourceCheckJobPayload, now + retryAfterMs);
      return;
    }

    recordSourceAttempt(
      this.database,
      adapter.manifest.adapterKey,
      now,
      minIntervalMs,
    );

    try {
      const request = {
        requestId: randomUUID(),
        sourceId: payload.sourceId,
        hospitalId: payload.hospitalId,
        campusId: payload.campusId ?? null,
        departmentId: payload.departmentId,
        dateFrom,
        dateTo,
        doctorName: null,
        titles: [],
        session: 'ANY' as const,
        deadlineAt: new Date(now + 30_000).toISOString(),
      };
      const result = await runSourceAdapter(adapter, request);
      const minNextAllowedAt = now + minIntervalMs;
      recordSourceResult(
        this.database,
        adapter.manifest.adapterKey,
        result,
        minNextAllowedAt,
      );
      applyCheckResult(this.database, {
        sourceId: request.sourceId,
        scopeKey: payload.scopeKey,
        requestId: request.requestId,
        result,
      });
      this.runner.complete(job.id, this.now());

      const resultNextAllowedAt = result.nextAllowedAt
        ? Date.parse(result.nextAllowedAt)
        : minNextAllowedAt;
      this.enqueueNextSourceCheck(
        payload as SourceCheckJobPayload,
        Math.max(minNextAllowedAt, resultNextAllowedAt),
      );
    } catch {
      const failedAt = this.now();
      recordSourceFailure(
        this.database,
        adapter.manifest.adapterKey,
        'SOURCE_CHECK_FAILED',
        failedAt + minIntervalMs,
      );
      this.runner.fail(job.id, {
        now: failedAt,
        errorCode: 'SOURCE_CHECK_FAILED',
        retryAt: failedAt + minIntervalMs,
      });
      if (job.attempts >= job.maxAttempts) {
        this.enqueueNextSourceCheck(
          payload as SourceCheckJobPayload,
          failedAt + minIntervalMs,
        );
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
      !rule ||
      !rule.enabled ||
      !payload.occurrenceAt ||
      !payload.targetDate ||
      !payload.officialEntryUrl
    ) {
      this.runner.complete(job.id, now);
      return;
    }
    if (now - job.runAt > 300_000) {
      ensureReleaseReminderBatch(
        this.database,
        {
          taskId: task.id,
          taskVersion: task.version,
          ruleId: rule.id,
          reminderAt: job.runAt,
          occurrenceAt: payload.occurrenceAt,
          targetDate: payload.targetDate,
          officialEntryUrl: payload.officialEntryUrl,
          needsReconfirmation: payload.needsReconfirmation ?? false,
          channelKeys: [...this.channels.keys()],
          terminalReason: 'RELEASE_REMINDER_MISSED',
        },
        now,
      );
      this.runner.complete(job.id, now);
      scheduleWatchTask(
        this.database,
        this.runner,
        task,
        this.sourceAdapters,
        now + 1,
      );
      return;
    }
    const channelKeys = [...this.channels.keys()];
    if (channelKeys.length === 0) {
      ensureReleaseReminderBatch(
        this.database,
        {
          taskId: task.id,
          taskVersion: task.version,
          ruleId: rule.id,
          reminderAt: job.runAt,
          occurrenceAt: payload.occurrenceAt,
          targetDate: payload.targetDate,
          officialEntryUrl: payload.officialEntryUrl,
          needsReconfirmation: payload.needsReconfirmation ?? false,
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
        reminderAt: job.runAt,
        occurrenceAt: payload.occurrenceAt,
        targetDate: payload.targetDate,
        officialEntryUrl: payload.officialEntryUrl,
        needsReconfirmation: payload.needsReconfirmation ?? false,
        channelKeys,
      },
      now,
    );
    const warning = payload.needsReconfirmation
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
        recordDeliveryResult(
          this.database,
          delivery.id,
          { status: 'rejected', errorCode: 'NOTIFICATION_CHANNEL_NOT_FOUND', retryable: false },
          now,
        );
        continue;
      }

      const message: NotificationMessage = {
        messageId: `${delivery.id}@easy-hospital.local`,
        subject: '放号前规则提醒',
        text: `北京同仁医院 · 崇文门院区 · 鼻科\n预计 ${rule.releaseTimeLocal} 放号，目标就诊日期 ${payload.targetDate}。${warning}`,
        officialEntryUrl: payload.officialEntryUrl,
        eventTags: ['schedule_released'],
        detectedAt: new Date(now).toISOString(),
      };
      markDeliverySending(this.database, delivery.id, now);
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
      this.runner.fail(job.id, {
        now: this.now(),
        errorCode: retryableError,
        retryAt: this.now() + retryDelay,
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
      recordDeliveryResult(
        this.database,
        payload.deliveryId,
        { status: 'rejected', errorCode, retryable: false },
        now,
      );
      this.runner.complete(job.id, now);
      return;
    }

    markDeliverySending(this.database, payload.deliveryId, now);
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
