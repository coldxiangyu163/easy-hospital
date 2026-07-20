import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalWorker } from '../../src/server/local-worker.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { runDataRetention } from '../../src/storage/retention.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

function insertCheckRun(
  database: SqliteDatabase,
  id: string,
  observedAt: number,
  expiresAt?: number,
): void {
  database
    .prepare(
      `INSERT INTO check_run (
        id, source_id, request_id, status, observed_at, content_hash, error_code, created_at
      ) VALUES (?, 'source-retention', ?, 'OK', ?, ?, NULL, ?)`,
    )
    .run(id, `request-${id}`, observedAt, 'a'.repeat(64), observedAt);
  if (expiresAt === undefined) return;
  database
    .prepare(
      `INSERT INTO availability_snapshot (
        id, check_run_id, source_id, observed_at, normalized_json, content_hash, expires_at
      ) VALUES (?, ?, 'source-retention', ?, '[]', ?, ?)`,
    )
    .run(`snapshot-${id}`, id, observedAt, 'a'.repeat(64), expiresAt);
}

function insertWatchTask(database: SqliteDatabase, now: number): void {
  database
    .prepare(
      `INSERT INTO watch_task (
        id, hospital_id, campus_id, department_id, match_mode, doctor_name,
        titles_json, date_from, date_to, session, event_types_json,
        remind_before_minutes, enabled, version, created_at, updated_at, deleted_at
      ) VALUES (
        'task-retention', 'hospital-pumch', 'campus-pumch-dongdan',
        'department-pumch-dermatology', 'any_expert', NULL, '[]',
        '2026-07-20', '2026-07-26', 'ANY', '["schedule_released"]',
        5, 1, 1, ?, ?, NULL
      )`,
    )
    .run(now, now);
}

function insertEvent(database: SqliteDatabase, id: string, detectedAt: number): void {
  database
    .prepare(
      `INSERT INTO detected_event (
        id, task_id, source_id, event_type, slot_key, from_state, to_state,
        evidence, detected_at, dedupe_key, payload_json
      ) VALUES (
        ?, 'task-retention', 'source-retention', 'schedule_released', ?,
        'absent', 'present', 'explicit', ?, ?, '{}'
      )`,
    )
    .run(id, `slot-${id}`, detectedAt, `dedupe-${id}`);
}

function insertBatch(
  database: SqliteDatabase,
  id: string,
  state: 'collecting' | 'pending' | 'sending' | 'sent' | 'failed' | 'delivery_unknown',
  updatedAt: number,
  eventIds: string[] = [],
  legacyEventIds = false,
): void {
  const eventIdsJson = legacyEventIds
    ? JSON.stringify(eventIds)
    : JSON.stringify({ eventIds, kind: 'event' });
  database
    .prepare(
      `INSERT INTO notification_batch (
        id, task_id, state, opens_at, closes_at, event_tags_json,
        event_ids_json, official_entry_url, created_at, updated_at
      ) VALUES (
        ?, 'task-retention', ?, ?, ?, '["schedule_released"]', ?,
        'https://pumchapp.pumch.cn/pages/pc/home/index', ?, ?
      )`,
    )
    .run(id, state, updatedAt, updatedAt, eventIdsJson, updatedAt, updatedAt);

  const deliveryState = state === 'collecting' ? 'pending' : state;
  database
    .prepare(
      `INSERT INTO notification_delivery (
        id, batch_id, channel_key, state, attempts, message_id,
        provider_message_id, last_error_code, sent_at, created_at, updated_at
      ) VALUES (?, ?, 'fixture', ?, 1, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(`delivery-${id}`, id, deliveryState, `message-${id}`, updatedAt, updatedAt);
}

function listIds(database: SqliteDatabase, table: string): string[] {
  return (
    database.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>
  ).map(({ id }) => id);
}

describe('SQLite 历史数据 retention', () => {
  let directory: string | undefined;
  let database: SqliteDatabase | undefined;
  let worker: LocalWorker | undefined;

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    database?.close();
    database = undefined;
    vi.useRealTimers();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('按 30/90 天边界事务清理历史，保留活跃通知与当前状态并保持幂等', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    const snapshotCutoff = now - 30 * DAY_MS;
    const historyCutoff = now - 90 * DAY_MS;
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-retention-'));
    database = openDatabase(join(directory, 'data.sqlite3'));

    insertCheckRun(database, 'expired', snapshotCutoff, now);
    insertCheckRun(database, 'retained', snapshotCutoff + 1, now + 1);
    insertCheckRun(database, 'old-orphan', snapshotCutoff);
    insertCheckRun(database, 'recent-orphan', snapshotCutoff + 1);
    insertWatchTask(database, now);
    insertEvent(database, 'event-expired', historyCutoff);
    insertEvent(database, 'event-active', historyCutoff);
    insertEvent(database, 'event-recent', historyCutoff + 1);

    insertBatch(database, 'batch-collecting', 'collecting', historyCutoff, ['event-active'], true);
    insertBatch(database, 'batch-pending', 'pending', historyCutoff);
    insertBatch(database, 'batch-sending', 'sending', historyCutoff);
    insertBatch(database, 'batch-sent', 'sent', historyCutoff);
    insertBatch(database, 'batch-failed', 'failed', historyCutoff);
    insertBatch(database, 'batch-unknown', 'delivery_unknown', historyCutoff);
    insertBatch(database, 'batch-recent-terminal', 'sent', historyCutoff + 1);

    database
      .prepare(
        `INSERT INTO schedule_state (
          source_id, slot_key, schedule_status, observation_json,
          first_seen_at, last_seen_at, version
        ) VALUES ('source-retention', 'slot-current', 'present', '{}', ?, ?, 1)`,
      )
      .run(historyCutoff, historyCutoff);
    database
      .prepare(
        `INSERT INTO availability_state (
          source_id, slot_key, schedule_status, availability, observation_json,
          first_seen_at, last_seen_at, changed_at, version,
          current_availability, last_checked_at
        ) VALUES (
          'source-retention', 'slot-current', 'present', 'unavailable', '{}',
          ?, ?, ?, 1, 'unavailable', ?
        )`,
      )
      .run(historyCutoff, historyCutoff, historyCutoff, historyCutoff);
    database
      .prepare(
        `INSERT INTO monitoring_baseline (source_id, scope_key, established_at)
         VALUES ('source-retention', 'scope-current', ?)`,
      )
      .run(historyCutoff);

    expect(runDataRetention(database, now)).toEqual({
      availabilitySnapshotsDeleted: 1,
      checkRunsDeleted: 2,
      notificationDeliveriesDeleted: 3,
      notificationBatchesDeleted: 3,
      detectedEventsDeleted: 1,
    });
    expect(listIds(database, 'availability_snapshot')).toEqual(['snapshot-retained']);
    expect(listIds(database, 'check_run')).toEqual(['recent-orphan', 'retained']);
    expect(listIds(database, 'detected_event')).toEqual(['event-active', 'event-recent']);
    expect(listIds(database, 'notification_batch')).toEqual([
      'batch-collecting',
      'batch-pending',
      'batch-recent-terminal',
      'batch-sending',
    ]);
    expect(listIds(database, 'notification_delivery')).toEqual([
      'delivery-batch-collecting',
      'delivery-batch-pending',
      'delivery-batch-recent-terminal',
      'delivery-batch-sending',
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM schedule_state').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM availability_state').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM monitoring_baseline').get()).toEqual({ count: 1 });
    expect(database.pragma('foreign_key_check')).toEqual([]);

    expect(runDataRetention(database, now)).toEqual({
      availabilitySnapshotsDeleted: 0,
      checkRunsDeleted: 0,
      notificationDeliveriesDeleted: 0,
      notificationBatchesDeleted: 0,
      detectedEventsDeleted: 0,
    });
  });

  it('LocalWorker 首次 tick 清理，之后最多每 24 小时执行一次', async () => {
    vi.useFakeTimers();
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-retention-worker-'));
    database = openDatabase(join(directory, 'data.sqlite3'));
    insertCheckRun(database, 'worker-first', now - 30 * DAY_MS, now);

    worker = new LocalWorker(database, [], [], 1_000, () => now);
    worker.start();
    await Promise.resolve();
    expect(listIds(database, 'availability_snapshot')).toEqual([]);

    insertCheckRun(database, 'worker-next', now - 30 * DAY_MS, now);
    now += DAY_MS - 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listIds(database, 'availability_snapshot')).toEqual(['snapshot-worker-next']);

    now += 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listIds(database, 'availability_snapshot')).toEqual([]);
  });

  it('LocalWorker retention 失败进入现有 health error 路径', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-retention-health-'));
    database = openDatabase(join(directory, 'data.sqlite3'));
    database.exec('DROP TABLE availability_snapshot');

    worker = new LocalWorker(database, [], [], 60_000, () => now);
    worker.start();
    await Promise.resolve();

    expect(worker.health()).toMatchObject({
      status: 'degraded',
      running: true,
      lastErrorCode: 'WORKER_TICK_FAILED',
    });
  });
});
