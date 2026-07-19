import { randomUUID } from 'node:crypto';

import {
  watchTaskInputSchema,
  type EventType,
  type WatchTask,
  type WatchTaskInput,
  type WatchTaskPatch,
} from '../core/watch-task.js';
import type { SqliteDatabase } from './database.js';

type WatchTaskRow = {
  id: string;
  hospital_id: string;
  campus_id: string | null;
  department_id: string;
  match_mode: WatchTask['matchMode'];
  doctor_name: string | null;
  titles_json: string;
  date_from: string;
  date_to: string;
  session: WatchTask['session'];
  event_types_json: string;
  remind_before_minutes: number | null;
  enabled: 0 | 1;
  version: number;
  created_at: number;
  updated_at: number;
};

function toWatchTask(row: WatchTaskRow): WatchTask {
  return {
    id: row.id,
    hospitalId: row.hospital_id,
    campusId: row.campus_id,
    departmentId: row.department_id,
    matchMode: row.match_mode,
    doctorName: row.doctor_name,
    titles: JSON.parse(row.titles_json) as string[],
    dateFrom: row.date_from,
    dateTo: row.date_to,
    session: row.session,
    eventTypes: JSON.parse(row.event_types_json) as EventType[],
    remindBeforeMinutes: row.remind_before_minutes,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createWatchTask(database: SqliteDatabase, input: WatchTaskInput): WatchTask {
  const id = randomUUID();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO watch_task (
        id, hospital_id, campus_id, department_id, match_mode, doctor_name,
        titles_json, date_from, date_to, session, event_types_json,
        remind_before_minutes, enabled, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      id,
      input.hospitalId,
      input.campusId,
      input.departmentId,
      input.matchMode,
      input.doctorName,
      JSON.stringify(input.titles),
      input.dateFrom,
      input.dateTo,
      input.session,
      JSON.stringify([...new Set(input.eventTypes)]),
      input.remindBeforeMinutes,
      now,
      now,
    );

  return getWatchTask(database, id)!;
}

export function getWatchTask(database: SqliteDatabase, id: string): WatchTask | undefined {
  const row = database
    .prepare('SELECT * FROM watch_task WHERE id = ? AND deleted_at IS NULL')
    .get(id) as WatchTaskRow | undefined;
  return row ? toWatchTask(row) : undefined;
}

export function listWatchTasks(database: SqliteDatabase): WatchTask[] {
  return (
    database
      .prepare('SELECT * FROM watch_task WHERE deleted_at IS NULL ORDER BY created_at, id')
      .all() as WatchTaskRow[]
  ).map(toWatchTask);
}

export type WatchTaskUpdateResult =
  | { status: 'updated'; task: WatchTask }
  | { status: 'not_found' }
  | { status: 'version_conflict'; currentVersion: number };

export function updateWatchTask(
  database: SqliteDatabase,
  id: string,
  patch: WatchTaskPatch,
): WatchTaskUpdateResult {
  const current = getWatchTask(database, id);
  if (!current) return { status: 'not_found' };
  if (current.version !== patch.version) {
    return { status: 'version_conflict', currentVersion: current.version };
  }

  const enabled = patch.enabled;
  const changes = { ...patch } as Partial<WatchTaskInput> & {
    version?: number;
    enabled?: boolean;
  };
  delete changes.version;
  delete changes.enabled;
  const nextInput = watchTaskInputSchema.parse({ ...current, ...changes });
  const result = database
    .prepare(
      `UPDATE watch_task SET
        hospital_id = ?, campus_id = ?, department_id = ?, match_mode = ?, doctor_name = ?,
        titles_json = ?, date_from = ?, date_to = ?, session = ?, event_types_json = ?,
        remind_before_minutes = ?, enabled = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .run(
      nextInput.hospitalId,
      nextInput.campusId,
      nextInput.departmentId,
      nextInput.matchMode,
      nextInput.doctorName,
      JSON.stringify(nextInput.titles),
      nextInput.dateFrom,
      nextInput.dateTo,
      nextInput.session,
      JSON.stringify([...new Set(nextInput.eventTypes)]),
      nextInput.remindBeforeMinutes,
      (enabled ?? current.enabled) ? 1 : 0,
      Date.now(),
      id,
      patch.version,
    );

  if (result.changes !== 1) return { status: 'version_conflict', currentVersion: current.version };
  return { status: 'updated', task: getWatchTask(database, id)! };
}

export function deleteWatchTask(database: SqliteDatabase, id: string): boolean {
  return (
    database
      .prepare('UPDATE watch_task SET deleted_at = ?, enabled = 0, version = version + 1 WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id).changes === 1
  );
}
