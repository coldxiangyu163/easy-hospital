import { randomUUID } from 'node:crypto';

import type { NotificationMessage, NotificationSendResult } from '../core/notification-channel.js';
import type { EventType } from '../core/watch-task.js';
import type { SqliteDatabase } from './database.js';
import type { SqliteJobRunner } from './job-runner.js';

type NotificationBatchRow = {
  id: string;
  task_id: string;
  state: NotificationBatch['state'];
  opens_at: number;
  closes_at: number;
  event_tags_json: string;
  event_ids_json: string;
  official_entry_url: string;
};

type BatchMetadata = {
  eventIds: string[];
  taskVersion?: number;
  kind?: 'event' | 'release-reminder';
  terminalReason?: string;
  occurrenceAt?: number;
  targetDate?: string;
  ruleId?: string;
  needsReconfirmation?: boolean;
};

type NotificationDeliveryRow = {
  id: string;
  batch_id: string;
  channel_key: string;
  state: NotificationDeliveryView['state'];
  attempts: number;
  message_id: string;
  provider_message_id: string | null;
  last_error_code: string | null;
  sent_at: number | null;
};

export type NotificationDeliveryView = {
  id: string;
  channel: string;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'delivery_unknown';
  attempts: number;
  providerMessageId: string | null;
  errorCode: string | null;
  sentAt: string | null;
};

export type NotificationBatch = {
  id: string;
  taskId: string;
  state: 'collecting' | 'pending' | 'sending' | 'sent' | 'failed' | 'delivery_unknown';
  opensAt: string;
  closesAt: string;
  eventTags: EventType[];
  eventIds: string[];
  officialEntryUrl: string;
  kind: 'event' | 'release-reminder';
  targetDate: string | null;
  needsReconfirmation: boolean;
  terminalReason: string | null;
  deliveries: NotificationDeliveryView[];
};

function parseBatchMetadata(value: string): BatchMetadata {
  const parsed = JSON.parse(value) as string[] | BatchMetadata;
  return Array.isArray(parsed) ? { eventIds: parsed } : parsed;
}

function serializeBatchMetadata(metadata: BatchMetadata): string {
  return JSON.stringify(metadata);
}

export function getNotificationDelivery(
  database: SqliteDatabase,
  deliveryId: string,
): NotificationDeliveryView | undefined {
  const row = database
    .prepare('SELECT * FROM notification_delivery WHERE id = ?')
    .get(deliveryId) as NotificationDeliveryRow | undefined;
  return row
    ? {
        id: row.id,
        channel: row.channel_key,
        state: row.state,
        attempts: row.attempts,
        providerMessageId: row.provider_message_id,
        errorCode: row.last_error_code,
        sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
      }
    : undefined;
}

function listDeliveryViews(
  database: SqliteDatabase,
  batchId: string,
): NotificationDeliveryView[] {
  const rows = database
    .prepare('SELECT * FROM notification_delivery WHERE batch_id = ? ORDER BY channel_key')
    .all(batchId) as NotificationDeliveryRow[];
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel_key,
    state: row.state,
    attempts: row.attempts,
    providerMessageId: row.provider_message_id,
    errorCode: row.last_error_code,
    sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
  }));
}

function toBatch(database: SqliteDatabase, row: NotificationBatchRow): NotificationBatch {
  const metadata = parseBatchMetadata(row.event_ids_json);
  return {
    id: row.id,
    taskId: row.task_id,
    state: row.state,
    opensAt: new Date(row.opens_at).toISOString(),
    closesAt: new Date(row.closes_at).toISOString(),
    eventTags: JSON.parse(row.event_tags_json) as EventType[],
    eventIds: metadata.eventIds,
    officialEntryUrl: row.official_entry_url,
    kind: metadata.kind ?? 'event',
    targetDate: metadata.targetDate ?? null,
    needsReconfirmation: metadata.needsReconfirmation ?? false,
    terminalReason: metadata.terminalReason ?? null,
    deliveries: listDeliveryViews(database, row.id),
  };
}

export function addEventToNotificationBatch(
  database: SqliteDatabase,
  input: {
    taskId: string;
    eventId: string;
    eventType: EventType;
    detectedAt: number;
    officialEntryUrl: string;
  },
): NotificationBatch {
  const current = database
    .prepare(
      `SELECT * FROM notification_batch
       WHERE task_id = ? AND state = 'collecting' AND closes_at >= ?
       ORDER BY opens_at DESC LIMIT 1`,
    )
    .get(input.taskId, input.detectedAt) as NotificationBatchRow | undefined;

  if (!current) {
    const id = randomUUID();
    const task = database
      .prepare('SELECT version FROM watch_task WHERE id = ?')
      .get(input.taskId) as { version: number };
    database
      .prepare(
        `INSERT INTO notification_batch (
          id, task_id, state, opens_at, closes_at, event_tags_json,
          event_ids_json, official_entry_url, created_at, updated_at
        ) VALUES (?, ?, 'collecting', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.detectedAt,
        input.detectedAt + 60_000,
        JSON.stringify([input.eventType]),
        serializeBatchMetadata({
          eventIds: [input.eventId],
          taskVersion: task.version,
          kind: 'event',
        }),
        input.officialEntryUrl,
        input.detectedAt,
        input.detectedAt,
      );
    return getNotificationBatch(database, id)!;
  }

  const eventTags = JSON.parse(current.event_tags_json) as EventType[];
  const metadata = parseBatchMetadata(current.event_ids_json);
  if (!eventTags.includes(input.eventType)) eventTags.push(input.eventType);
  if (!metadata.eventIds.includes(input.eventId)) metadata.eventIds.push(input.eventId);
  database
    .prepare(
      `UPDATE notification_batch
       SET event_tags_json = ?, event_ids_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      JSON.stringify(eventTags),
      serializeBatchMetadata(metadata),
      input.detectedAt,
      current.id,
    );
  return getNotificationBatch(database, current.id)!;
}

export function ensureReleaseReminderBatch(
  database: SqliteDatabase,
  input: {
    taskId: string;
    taskVersion: number;
    ruleId: string;
    reminderAt: number;
    occurrenceAt: number;
    targetDate: string;
    officialEntryUrl: string;
    needsReconfirmation: boolean;
    channelKeys: string[];
    terminalReason?: string;
  },
  now: number,
): NotificationBatch {
  const id = `release-reminder:${input.taskId}:${input.occurrenceAt}`;
  const state = input.terminalReason ? 'failed' : 'pending';
  const metadata: BatchMetadata = {
    eventIds: [],
    taskVersion: input.taskVersion,
    kind: 'release-reminder',
    terminalReason: input.terminalReason,
    occurrenceAt: input.occurrenceAt,
    targetDate: input.targetDate,
    ruleId: input.ruleId,
    needsReconfirmation: input.needsReconfirmation,
  };

  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO notification_batch (
          id, task_id, state, opens_at, closes_at, event_tags_json,
          event_ids_json, official_entry_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        id,
        input.taskId,
        state,
        input.reminderAt,
        input.occurrenceAt,
        JSON.stringify(['schedule_released']),
        serializeBatchMetadata(metadata),
        input.officialEntryUrl,
        now,
        now,
      );

    for (const channelKey of input.channelKeys) {
      database
        .prepare(
          `INSERT INTO notification_delivery (
            id, batch_id, channel_key, state, attempts, message_id,
            last_error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
          ON CONFLICT (batch_id, channel_key) DO NOTHING`,
        )
        .run(
          randomUUID(),
          id,
          channelKey,
          state,
          `${id}:${channelKey}@easy-hospital.local`,
          input.terminalReason ?? null,
          now,
          now,
        );
    }
  })();

  return getNotificationBatch(database, id)!;
}

export function getNotificationBatch(
  database: SqliteDatabase,
  id: string,
): NotificationBatch | undefined {
  const row = database.prepare('SELECT * FROM notification_batch WHERE id = ?').get(id) as
    | NotificationBatchRow
    | undefined;
  return row ? toBatch(database, row) : undefined;
}

export function listNotificationBatches(database: SqliteDatabase): NotificationBatch[] {
  return (
    database.prepare('SELECT * FROM notification_batch ORDER BY opens_at, id').all() as NotificationBatchRow[]
  ).map((row) => toBatch(database, row));
}

type DueBatchRow = NotificationBatchRow & { task_id: string };

export function cancelInvalidNotificationBatches(
  database: SqliteDatabase,
  now: number,
): void {
  const batches = database
    .prepare("SELECT * FROM notification_batch WHERE state IN ('collecting', 'pending')")
    .all() as NotificationBatchRow[];

  for (const batch of batches) {
    const metadata = parseBatchMetadata(batch.event_ids_json);
    const task = database
      .prepare('SELECT version, enabled, deleted_at FROM watch_task WHERE id = ?')
      .get(batch.task_id) as
      | { version: number; enabled: 0 | 1; deleted_at: number | null }
      | undefined;
    const reason = !task || task.deleted_at !== null
      ? 'TASK_DELETED'
      : task.enabled === 0
        ? 'TASK_INACTIVE'
        : metadata.taskVersion === undefined
          ? 'TASK_VERSION_UNKNOWN'
          : metadata.taskVersion !== task.version
            ? 'TASK_CHANGED'
            : undefined;
    if (!reason) continue;

    metadata.terminalReason = reason;
    database.transaction(() => {
      database
        .prepare(
          `UPDATE notification_batch
           SET state = 'failed', event_ids_json = ?, updated_at = ?
           WHERE id = ? AND state IN ('collecting', 'pending')`,
        )
        .run(serializeBatchMetadata(metadata), now, batch.id);
      database
        .prepare(
          `UPDATE notification_delivery
           SET state = 'failed', last_error_code = ?, updated_at = ?
           WHERE batch_id = ? AND state = 'pending'`,
        )
        .run(reason, now, batch.id);
    })();
  }
}

export function prepareDueNotificationJobs(
  database: SqliteDatabase,
  runner: SqliteJobRunner,
  channelKeys: string[],
  now: number,
): void {
  if (channelKeys.length === 0) return;

  const due = database
    .prepare("SELECT * FROM notification_batch WHERE state = 'collecting' AND closes_at <= ?")
    .all(now) as DueBatchRow[];

  for (const batch of due) {
    database.transaction(() => {
      const updated = database
        .prepare("UPDATE notification_batch SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'collecting'")
        .run(now, batch.id);
      if (updated.changes !== 1) return;

      for (const channelKey of channelKeys) {
        const deliveryId = randomUUID();
        database
          .prepare(
            `INSERT INTO notification_delivery (
              id, batch_id, channel_key, state, attempts, message_id, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
            ON CONFLICT (batch_id, channel_key) DO NOTHING`,
          )
          .run(deliveryId, batch.id, channelKey, `${batch.id}@easy-hospital.local`, now, now);
        const delivery = database
          .prepare('SELECT id FROM notification_delivery WHERE batch_id = ? AND channel_key = ?')
          .get(batch.id, channelKey) as { id: string };
        runner.enqueue({
          type: 'notification',
          payload: { deliveryId: delivery.id, channelKey },
          runAt: now,
          dedupeKey: `notify:${delivery.id}`,
          maxAttempts: 4,
        });
      }
    })();
  }
}

type DeliveryMessageRow = {
  delivery_id: string;
  channel_key: string;
  message_id: string;
  batch_id: string;
  opens_at: number;
  event_tags_json: string;
  official_entry_url: string;
  hospital_name: string;
  campus_name: string | null;
  department_name: string;
};

export function getDeliveryMessage(
  database: SqliteDatabase,
  deliveryId: string,
): { channelKey: string; message: NotificationMessage } | undefined {
  const row = database
    .prepare(
      `SELECT
        nd.id AS delivery_id,
        nd.channel_key,
        nd.message_id,
        nb.id AS batch_id,
        nb.opens_at,
        nb.event_tags_json,
        nb.official_entry_url,
        h.name AS hospital_name,
        c.name AS campus_name,
        d.name AS department_name
      FROM notification_delivery nd
      JOIN notification_batch nb ON nb.id = nd.batch_id
      JOIN watch_task wt ON wt.id = nb.task_id
      JOIN hospital h ON h.id = wt.hospital_id
      LEFT JOIN campus c ON c.id = wt.campus_id
      JOIN department d ON d.id = wt.department_id
      WHERE nd.id = ?`,
    )
    .get(deliveryId) as DeliveryMessageRow | undefined;
  if (!row) return undefined;

  const eventTags = JSON.parse(row.event_tags_json) as EventType[];
  const batch = database
    .prepare('SELECT event_ids_json FROM notification_batch WHERE id = ?')
    .get(row.batch_id) as { event_ids_json: string };
  const eventIds = parseBatchMetadata(batch.event_ids_json).eventIds;
  const eventRows = eventIds
    .map((eventId) =>
      database
        .prepare(
          'SELECT source_id, event_type, evidence, payload_json FROM detected_event WHERE id = ?',
        )
        .get(eventId) as
        | {
            source_id: string;
            event_type: EventType;
            evidence: 'explicit' | 'inferred';
            payload_json: string;
          }
        | undefined,
    )
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  const hasExplicitAvailable = eventRows.some((event) => {
    if (!event || event.evidence !== 'explicit') return false;
    const payload = JSON.parse(event.payload_json) as { availability?: string };
    return payload.availability === 'available';
  });
  const baseText = [row.hospital_name, row.campus_name, row.department_name]
    .filter(Boolean)
    .join(' · ');
  const isCancellation = eventTags.includes('cancellation_slot_detected');
  const isScheduleOnly =
    eventTags.includes('schedule_released') &&
    !eventTags.includes('availability_changed_to_available') &&
    !isCancellation;
  const subject = isCancellation
    ? '疑似退号回流'
    : isScheduleOnly
      ? '新排班已发布'
      : hasExplicitAvailable
        ? '检测到可用号源'
        : '号源状态发生变化';
  const detail = isCancellation
    ? '检测到疑似退号回流，请以官方渠道实时状态为准。'
    : isScheduleOnly
      ? '检测到新的公开排班；排班信息不代表可预约状态。'
      : hasExplicitAvailable
        ? '官方来源明确显示可用号源，请尽快前往官方渠道确认。'
        : '检测到状态变化，请前往官方渠道确认。';
  const firstEvent = eventRows[0];
  const firstPayload = firstEvent
    ? (JSON.parse(firstEvent.payload_json) as {
        date?: string;
        session?: 'AM' | 'PM';
        doctorName?: string | null;
        title?: string | null;
      })
    : undefined;
  const firstItemParts = firstPayload?.date
    ? [
        `就诊日期 ${firstPayload.date}`,
        firstPayload.session === 'AM'
          ? '上午'
          : firstPayload.session === 'PM'
            ? '下午'
            : undefined,
        firstPayload.doctorName ?? undefined,
        firstPayload.title ?? undefined,
      ].filter((part): part is string => Boolean(part))
    : [];
  const beijingDetectedAt = new Date(row.opens_at + 8 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const evidence = eventRows.some((event) => event.evidence === 'inferred')
    ? '包含状态推断'
    : '官方来源明确观测';
  const source = eventRows.some((event) => event.source_id.startsWith('browser-agent-'))
    ? '本机 Browser Agent 规范化观测'
    : '医院官方公开来源';
  const text = [
    baseText,
    detail,
    firstItemParts.length > 0 ? `首项：${firstItemParts.join(' · ')}` : undefined,
    `检测时间（北京时间）：${beijingDetectedAt}`,
    `证据：${evidence}；来源：${source}`,
    `本批次共 ${eventIds.length} 项`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  return {
    channelKey: row.channel_key,
    message: {
      messageId: row.message_id,
      subject,
      text,
      officialEntryUrl: row.official_entry_url,
      eventTags,
      detectedAt: new Date(row.opens_at).toISOString(),
    },
  };
}

function recomputeBatchState(database: SqliteDatabase, batchId: string, now: number): void {
  const rows = database
    .prepare('SELECT state FROM notification_delivery WHERE batch_id = ?')
    .all(batchId) as Array<{ state: NotificationDeliveryView['state'] }>;
  if (rows.length === 0) return;

  const states = rows.map((row) => row.state);
  const state: NotificationBatch['state'] = states.includes('sending')
    ? 'sending'
    : states.includes('pending')
      ? 'pending'
      : states.includes('delivery_unknown')
        ? 'delivery_unknown'
        : states.every((candidate) => candidate === 'sent')
          ? 'sent'
          : 'failed';
  database
    .prepare('UPDATE notification_batch SET state = ?, updated_at = ? WHERE id = ?')
    .run(state, now, batchId);
}

export function markDeliverySending(database: SqliteDatabase, deliveryId: string, now: number): void {
  database.transaction(() => {
    const delivery = database
      .prepare('SELECT batch_id FROM notification_delivery WHERE id = ?')
      .get(deliveryId) as { batch_id: string } | undefined;
    if (!delivery) return;
    database
      .prepare(
        `UPDATE notification_delivery
         SET state = 'sending', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(now, deliveryId);
    recomputeBatchState(database, delivery.batch_id, now);
  })();
}

export function recoverAmbiguousSendingDeliveries(
  database: SqliteDatabase,
  now: number,
): void {
  const rows = database
    .prepare("SELECT id, batch_id FROM notification_delivery WHERE state = 'sending'")
    .all() as Array<{ id: string; batch_id: string }>;
  for (const row of rows) {
    database.transaction(() => {
      database
        .prepare(
          `UPDATE notification_delivery
           SET state = 'delivery_unknown', last_error_code = 'DELIVERY_STATE_AMBIGUOUS', updated_at = ?
           WHERE id = ? AND state = 'sending'`,
        )
        .run(now, row.id);
      recomputeBatchState(database, row.batch_id, now);
    })();
  }
}

export function markDeliveryUnknown(
  database: SqliteDatabase,
  deliveryId: string,
  errorCode: string,
  now: number,
): void {
  database.transaction(() => {
    const delivery = database
      .prepare('SELECT batch_id FROM notification_delivery WHERE id = ?')
      .get(deliveryId) as { batch_id: string } | undefined;
    if (!delivery) return;
    database
      .prepare(
        `UPDATE notification_delivery
         SET state = 'delivery_unknown', last_error_code = ?, updated_at = ?
         WHERE id = ? AND state = 'sending'`,
      )
      .run(errorCode, now, deliveryId);
    recomputeBatchState(database, delivery.batch_id, now);
  })();
}

export function recordDeliveryRetry(
  database: SqliteDatabase,
  deliveryId: string,
  errorCode: string,
  now: number,
): void {
  database.transaction(() => {
    const delivery = database
      .prepare('SELECT batch_id FROM notification_delivery WHERE id = ?')
      .get(deliveryId) as { batch_id: string } | undefined;
    if (!delivery) return;
    database
      .prepare(
        `UPDATE notification_delivery
         SET state = 'pending', last_error_code = ?, updated_at = ?
         WHERE id = ? AND state = 'sending'`,
      )
      .run(errorCode, now, deliveryId);
    recomputeBatchState(database, delivery.batch_id, now);
  })();
}

export function recordDeliveryResult(
  database: SqliteDatabase,
  deliveryId: string,
  result: NotificationSendResult,
  now: number,
): void {
  const state =
    result.status === 'accepted'
      ? 'sent'
      : result.status === 'unknown'
        ? 'delivery_unknown'
        : 'failed';
  const providerMessageId = result.status === 'accepted' ? result.providerMessageId : null;
  const errorCode = result.status === 'accepted' ? null : result.errorCode;

  database.transaction(() => {
    const delivery = database
      .prepare('SELECT batch_id FROM notification_delivery WHERE id = ?')
      .get(deliveryId) as { batch_id: string } | undefined;
    if (!delivery) return;
    database
      .prepare(
        `UPDATE notification_delivery
         SET state = ?, provider_message_id = ?, last_error_code = ?, sent_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(state, providerMessageId, errorCode, result.status === 'accepted' ? now : null, now, deliveryId);
    recomputeBatchState(database, delivery.batch_id, now);
  })();
}
