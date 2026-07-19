import { randomUUID } from 'node:crypto';

import type { CheckResult, Observation } from '../core/source-adapter.js';
import type { WatchTask } from '../core/watch-task.js';
import type { SqliteDatabase } from './database.js';
import { addEventToNotificationBatch } from './notification-outbox.js';
import { listWatchTasks } from './watch-tasks.js';

type ScheduleStateRow = {
  source_id: string;
  slot_key: string;
  schedule_status: 'absent' | 'present';
  observation_json: string;
  first_seen_at: number;
  last_seen_at: number;
  version: number;
};

type AvailabilityStateRow = {
  source_id: string;
  slot_key: string;
  schedule_status: Observation['scheduleStatus'];
  availability: 'available' | 'unavailable';
  observation_json: string;
  first_seen_at: number;
  last_seen_at: number;
  changed_at: number;
  version: number;
  current_availability: Observation['availability'];
  last_checked_at: number;
};

export type DetectedEvent = {
  id: string;
  taskId: string;
  sourceId: string;
  eventType:
    | 'schedule_released'
    | 'availability_changed_to_available'
    | 'cancellation_slot_detected';
  slotKey: string;
  fromState: string | null;
  toState: string;
  evidence: 'explicit' | 'inferred';
  detectedAt: string;
  payload: Observation;
};

type DetectedEventRow = {
  id: string;
  task_id: string;
  source_id: string;
  event_type: DetectedEvent['eventType'];
  slot_key: string;
  from_state: string | null;
  to_state: string;
  evidence: DetectedEvent['evidence'];
  detected_at: number;
  payload_json: string;
};

function toEvent(row: DetectedEventRow): DetectedEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceId: row.source_id,
    eventType: row.event_type,
    slotKey: row.slot_key,
    fromState: row.from_state,
    toState: row.to_state,
    evidence: row.evidence,
    detectedAt: new Date(row.detected_at).toISOString(),
    payload: JSON.parse(row.payload_json) as Observation,
  };
}

function matches(task: WatchTask, observation: Observation): boolean {
  if (!task.enabled) return false;
  if (task.hospitalId !== observation.hospitalId) return false;
  if (task.campusId && task.campusId !== observation.campusId) return false;
  if (task.departmentId !== observation.departmentId) return false;
  if (observation.date < task.dateFrom || observation.date > task.dateTo) return false;
  if (task.session !== 'ANY' && task.session !== observation.session) return false;
  if (task.matchMode === 'doctor' && task.doctorName !== observation.doctorName) return false;
  if (task.matchMode === 'title' && (!observation.title || !task.titles.includes(observation.title))) {
    return false;
  }
  if (task.matchMode === 'any_expert' && !observation.doctorName) return false;
  return true;
}

export function applyCheckResult(
  database: SqliteDatabase,
  input: { sourceId: string; scopeKey: string; requestId: string; result: CheckResult },
): number {
  const observedAt = Date.parse(input.result.observedAt);

  return database.transaction(() => {
    const checkRunId = randomUUID();
    database
      .prepare(
        `INSERT INTO check_run (
          id, source_id, request_id, status, observed_at, content_hash, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkRunId,
        input.sourceId,
        input.requestId,
        input.result.status,
        observedAt,
        input.result.contentHash,
        input.result.errorCode ?? null,
        Date.now(),
      );

    database
      .prepare(
        `INSERT INTO availability_snapshot (
          id, check_run_id, source_id, observed_at, normalized_json, content_hash, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        checkRunId,
        input.sourceId,
        observedAt,
        JSON.stringify(input.result.observations),
        input.result.contentHash,
        observedAt + 30 * 24 * 60 * 60 * 1_000,
      );

    if (input.result.status !== 'OK' && input.result.status !== 'PARTIAL') return 0;

    const tasks = listWatchTasks(database);
    const hasBaseline = Boolean(
      database
        .prepare('SELECT 1 FROM monitoring_baseline WHERE source_id = ? AND scope_key = ?')
        .get(input.sourceId, input.scopeKey),
    );
    const canEstablishBaseline =
      input.result.observations.length === 0 ||
      input.result.observations.some(
        (observation) =>
          observation.scheduleStatus !== 'unknown' || observation.availability !== 'unknown',
      );
    let eventsCreated = 0;

    for (const observation of input.result.observations) {
      const schedulePrevious = database
        .prepare('SELECT * FROM schedule_state WHERE source_id = ? AND slot_key = ?')
        .get(input.sourceId, observation.slotKey) as ScheduleStateRow | undefined;
      const previous = database
        .prepare('SELECT * FROM availability_state WHERE source_id = ? AND slot_key = ?')
        .get(input.sourceId, observation.slotKey) as AvailabilityStateRow | undefined;

      if (!schedulePrevious && hasBaseline && observation.scheduleStatus === 'present') {
        for (const task of tasks) {
          if (!matches(task, observation)) continue;
          if (!task.eventTypes.includes('schedule_released')) continue;

          const eventId = randomUUID();
          const result = database
            .prepare(
              `INSERT INTO detected_event (
                id, task_id, source_id, event_type, slot_key, from_state, to_state,
                evidence, detected_at, dedupe_key, payload_json
              ) VALUES (?, ?, ?, 'schedule_released', ?, 'absent', 'present', ?, ?, ?, ?)
              ON CONFLICT (dedupe_key) DO NOTHING`,
            )
            .run(
              eventId,
              task.id,
              input.sourceId,
              observation.slotKey,
              observation.evidence,
              observedAt,
              `${task.id}:schedule_released:${input.sourceId}:${input.scopeKey}:${observation.slotKey}`,
              JSON.stringify(observation),
            );
          eventsCreated += result.changes;
          if (result.changes === 1) {
            addEventToNotificationBatch(database, {
              taskId: task.id,
              eventId,
              eventType: 'schedule_released',
              detectedAt: observedAt,
              officialEntryUrl: observation.officialEntryUrl,
            });
          }
        }
      }

      if (observation.scheduleStatus !== 'unknown') {
        database
          .prepare(
            `INSERT INTO schedule_state (
              source_id, slot_key, schedule_status, observation_json,
              first_seen_at, last_seen_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT (source_id, slot_key) DO UPDATE SET
              schedule_status = excluded.schedule_status,
              observation_json = excluded.observation_json,
              last_seen_at = excluded.last_seen_at,
              version = schedule_state.version + 1`,
          )
          .run(
            input.sourceId,
            observation.slotKey,
            observation.scheduleStatus,
            JSON.stringify(observation),
            schedulePrevious?.first_seen_at ?? observedAt,
            observedAt,
          );
      }

      if (observation.availability === 'unknown') {
        if (previous) {
          database
            .prepare(
              `UPDATE availability_state
               SET current_availability = 'unknown', last_checked_at = ?
               WHERE source_id = ? AND slot_key = ?`,
            )
            .run(observedAt, input.sourceId, observation.slotKey);
        }
        continue;
      }

      const version = (previous?.version ?? 0) + 1;
      const scheduleStatus =
        observation.scheduleStatus === 'unknown'
          ? (previous?.schedule_status ?? 'unknown')
          : observation.scheduleStatus;

      if (
        previous?.availability === 'unavailable' &&
        observation.availability === 'available'
      ) {
        for (const task of tasks) {
          if (!matches(task, observation)) continue;
          if (!task.eventTypes.includes('availability_changed_to_available')) continue;

          const eventId = randomUUID();
          const result = database
            .prepare(
              `INSERT INTO detected_event (
                id, task_id, source_id, event_type, slot_key, from_state, to_state,
                evidence, detected_at, dedupe_key, payload_json
              ) VALUES (?, ?, ?, 'availability_changed_to_available', ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (dedupe_key) DO NOTHING`,
            )
            .run(
              eventId,
              task.id,
              input.sourceId,
              observation.slotKey,
              previous.availability,
              observation.availability,
              observation.evidence,
              observedAt,
              `${task.id}:availability_changed_to_available:${input.sourceId}:${observation.slotKey}:${version}`,
              JSON.stringify(observation),
            );
          eventsCreated += result.changes;
          if (result.changes === 1) {
            addEventToNotificationBatch(database, {
              taskId: task.id,
              eventId,
              eventType: 'availability_changed_to_available',
              detectedAt: observedAt,
              officialEntryUrl: observation.officialEntryUrl,
            });
          }
        }

        if (observedAt - previous.last_seen_at <= 30 * 60 * 1_000) {
          for (const task of tasks) {
            if (!matches(task, observation)) continue;
            if (!task.eventTypes.includes('cancellation_slot_detected')) continue;

            const eventId = randomUUID();
            const result = database
              .prepare(
                `INSERT INTO detected_event (
                  id, task_id, source_id, event_type, slot_key, from_state, to_state,
                  evidence, detected_at, dedupe_key, payload_json
                ) VALUES (?, ?, ?, 'cancellation_slot_detected', ?, ?, ?, 'inferred', ?, ?, ?)
                ON CONFLICT (dedupe_key) DO NOTHING`,
              )
              .run(
                eventId,
                task.id,
                input.sourceId,
                observation.slotKey,
                previous.availability,
                observation.availability,
                observedAt,
                `${task.id}:cancellation_slot_detected:${input.sourceId}:${observation.slotKey}:${version}`,
                JSON.stringify(observation),
              );
            eventsCreated += result.changes;
            if (result.changes === 1) {
              addEventToNotificationBatch(database, {
                taskId: task.id,
                eventId,
                eventType: 'cancellation_slot_detected',
                detectedAt: observedAt,
                officialEntryUrl: observation.officialEntryUrl,
              });
            }
          }
        }
      }

      database
        .prepare(
          `INSERT INTO availability_state (
            source_id, slot_key, schedule_status, availability, observation_json,
            first_seen_at, last_seen_at, changed_at, version,
            current_availability, last_checked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source_id, slot_key) DO UPDATE SET
            schedule_status = excluded.schedule_status,
            availability = excluded.availability,
            observation_json = excluded.observation_json,
            last_seen_at = excluded.last_seen_at,
            current_availability = excluded.current_availability,
            last_checked_at = excluded.last_checked_at,
            changed_at = CASE
              WHEN availability_state.availability <> excluded.availability
                OR availability_state.schedule_status <> excluded.schedule_status
              THEN excluded.last_seen_at
              ELSE availability_state.changed_at
            END,
            version = excluded.version`,
        )
        .run(
          input.sourceId,
          observation.slotKey,
          scheduleStatus,
          observation.availability,
          JSON.stringify(observation),
          previous?.first_seen_at ?? observedAt,
          observedAt,
          previous &&
          previous.availability === observation.availability &&
          previous.schedule_status === scheduleStatus
            ? previous.changed_at
            : observedAt,
          version,
          observation.availability,
          observedAt,
        );
    }

    if (canEstablishBaseline) {
      database
        .prepare(
          `INSERT INTO monitoring_baseline (source_id, scope_key, established_at)
           VALUES (?, ?, ?)
           ON CONFLICT (source_id, scope_key) DO NOTHING`,
        )
        .run(input.sourceId, input.scopeKey, observedAt);
    }

    return eventsCreated;
  })();
}

export function listDetectedEvents(database: SqliteDatabase): DetectedEvent[] {
  return (
    database.prepare('SELECT * FROM detected_event ORDER BY detected_at, id').all() as DetectedEventRow[]
  ).map(toEvent);
}

export type AvailabilityStateView = {
  sourceId: string;
  slotKey: string;
  availability: 'available' | 'unavailable';
  currentAvailability: Observation['availability'];
  lastExplicitAt: string;
  lastObservedAt: string;
};

export function listAvailabilityStates(
  database: SqliteDatabase,
  sourceId: string,
): AvailabilityStateView[] {
  return (
    database
      .prepare('SELECT * FROM availability_state WHERE source_id = ? ORDER BY slot_key')
      .all(sourceId) as AvailabilityStateRow[]
  ).map((row) => ({
    sourceId: row.source_id,
    slotKey: row.slot_key,
    availability: row.availability,
    currentAvailability: row.current_availability,
    lastExplicitAt: new Date(row.last_seen_at).toISOString(),
    lastObservedAt: new Date(row.last_checked_at).toISOString(),
  }));
}
