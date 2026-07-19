import type { CheckResult } from '../core/source-adapter.js';
import type { SqliteDatabase } from './database.js';

const PUMCH_ADAPTER_KEY = 'pumch-public-dermatology-schedule';
const PUMCH_GLOBAL_INTERVAL_MS = 2 * 60 * 60 * 1_000;

export function sourceMinimumIntervalMs(
  adapterKey: string,
  adapterMinimumMs: number,
): number {
  return adapterKey === PUMCH_ADAPTER_KEY
    ? Math.max(adapterMinimumMs, PUMCH_GLOBAL_INTERVAL_MS)
    : adapterMinimumMs;
}

type SourceRuntimeRow = {
  adapter_key: string;
  last_attempt_at: number | null;
  last_success_at: number | null;
  next_allowed_at: number;
  last_status: string | null;
  last_error_code: string | null;
};

export type SourceRuntime = {
  adapterKey: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAllowedAt: number;
  lastStatus: string | null;
  lastErrorCode: string | null;
};

function toRuntime(row: SourceRuntimeRow): SourceRuntime {
  return {
    adapterKey: row.adapter_key,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    nextAllowedAt: row.next_allowed_at,
    lastStatus: row.last_status,
    lastErrorCode: row.last_error_code,
  };
}

export function getSourceRuntime(
  database: SqliteDatabase,
  adapterKey: string,
): SourceRuntime | undefined {
  const row = database
    .prepare('SELECT * FROM source_runtime WHERE adapter_key = ?')
    .get(adapterKey) as SourceRuntimeRow | undefined;
  return row ? toRuntime(row) : undefined;
}

export function sourceRetryAfterMs(
  database: SqliteDatabase,
  adapterKey: string,
  now: number,
): number {
  const runtime = getSourceRuntime(database, adapterKey);
  return runtime ? Math.max(0, runtime.nextAllowedAt - now) : 0;
}

export function recordSourceAttempt(
  database: SqliteDatabase,
  adapterKey: string,
  now: number,
  minIntervalMs: number,
): void {
  database
    .prepare(
      `INSERT INTO source_runtime (
        adapter_key, last_attempt_at, next_allowed_at, last_status
      ) VALUES (?, ?, ?, 'RUNNING')
      ON CONFLICT (adapter_key) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        next_allowed_at = MAX(source_runtime.next_allowed_at, excluded.next_allowed_at),
        last_status = 'RUNNING',
        last_error_code = NULL`,
    )
    .run(adapterKey, now, now + minIntervalMs);
}

export function recordSourceFailure(
  database: SqliteDatabase,
  adapterKey: string,
  errorCode: string,
  nextAllowedAt: number,
): void {
  database
    .prepare(
      `UPDATE source_runtime SET
        next_allowed_at = MAX(next_allowed_at, ?),
        last_status = 'TEMPORARY_FAILURE',
        last_error_code = ?
      WHERE adapter_key = ?`,
    )
    .run(nextAllowedAt, errorCode, adapterKey);
}

export function recordSourceResult(
  database: SqliteDatabase,
  adapterKey: string,
  result: CheckResult,
  minNextAllowedAt: number,
): void {
  const resultNextAllowedAt = result.nextAllowedAt ? Date.parse(result.nextAllowedAt) : 0;
  const nextAllowedAt = Math.max(minNextAllowedAt, resultNextAllowedAt || 0);
  const success = result.status === 'OK' || result.status === 'PARTIAL';
  database
    .prepare(
      `UPDATE source_runtime SET
        last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
        next_allowed_at = MAX(next_allowed_at, ?),
        last_status = ?,
        last_error_code = ?
      WHERE adapter_key = ?`,
    )
    .run(
      success ? 1 : 0,
      success ? Date.parse(result.observedAt) : null,
      nextAllowedAt,
      result.status,
      result.errorCode ?? null,
      adapterKey,
    );
}
