import type { SqliteDatabase } from './database.js';

const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type RetentionResult = {
  availabilitySnapshotsDeleted: number;
  checkRunsDeleted: number;
  notificationDeliveriesDeleted: number;
  notificationBatchesDeleted: number;
  detectedEventsDeleted: number;
};

export function runDataRetention(
  database: SqliteDatabase,
  now: number,
): RetentionResult {
  const checkRunCutoff = now - SNAPSHOT_RETENTION_MS;
  const historyCutoff = now - HISTORY_RETENTION_MS;

  return database.transaction(() => {
    const availabilitySnapshotsDeleted = database
      .prepare('DELETE FROM availability_snapshot WHERE expires_at <= ?')
      .run(now).changes;

    const checkRunsDeleted = database
      .prepare(
        `DELETE FROM check_run
         WHERE observed_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM availability_snapshot
             WHERE availability_snapshot.check_run_id = check_run.id
           )`,
      )
      .run(checkRunCutoff).changes;

    const terminalBatchFilter = `
      batch_id IN (
        SELECT id FROM notification_batch
        WHERE state IN ('sent', 'failed', 'delivery_unknown')
          AND updated_at <= ?
      )`;
    const notificationDeliveriesDeleted = database
      .prepare(`DELETE FROM notification_delivery WHERE ${terminalBatchFilter}`)
      .run(historyCutoff).changes;
    const notificationBatchesDeleted = database
      .prepare(
        `DELETE FROM notification_batch
         WHERE state IN ('sent', 'failed', 'delivery_unknown')
           AND updated_at <= ?`,
      )
      .run(historyCutoff).changes;

    const detectedEventsDeleted = database
      .prepare(
        `DELETE FROM detected_event
         WHERE detected_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM notification_batch AS active_batch
             WHERE active_batch.state IN ('collecting', 'pending', 'sending')
               AND EXISTS (
                 SELECT 1
                 FROM json_each(
                   CASE json_type(active_batch.event_ids_json)
                     WHEN 'array' THEN active_batch.event_ids_json
                     WHEN 'object' THEN json_extract(active_batch.event_ids_json, '$.eventIds')
                     ELSE NULL
                   END
                 ) AS active_event
                 WHERE active_event.value = detected_event.id
               )
           )`,
      )
      .run(historyCutoff).changes;

    return {
      availabilitySnapshotsDeleted,
      checkRunsDeleted,
      notificationDeliveriesDeleted,
      notificationBatchesDeleted,
      detectedEventsDeleted,
    };
  })();
}
