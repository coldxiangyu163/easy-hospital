import type { CheckResult } from '../core/source-adapter.js';
import type { SqliteDatabase } from './database.js';

export function sourceMinimumIntervalMs(adapterMinimumMs: number): number {
  return Math.max(adapterMinimumMs, 300_000);
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
  rateLimitKey: string,
): SourceRuntime | undefined {
  const row = database
    .prepare('SELECT * FROM source_runtime WHERE adapter_key = ?')
    .get(rateLimitKey) as SourceRuntimeRow | undefined;
  return row ? toRuntime(row) : undefined;
}

export function sourceRetryAfterMs(
  database: SqliteDatabase,
  rateLimitKey: string,
  now: number,
): number {
  const runtime = getSourceRuntime(database, rateLimitKey);
  return runtime ? Math.max(0, runtime.nextAllowedAt - now) : 0;
}

export function recordSourceAttempt(
  database: SqliteDatabase,
  rateLimitKey: string,
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
    .run(rateLimitKey, now, now + minIntervalMs);
}

export function recordSourceFailure(
  database: SqliteDatabase,
  rateLimitKey: string,
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
    .run(nextAllowedAt, errorCode, rateLimitKey);
}

export function recordSourceResult(
  database: SqliteDatabase,
  rateLimitKey: string,
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
      rateLimitKey,
    );
}

export function getSourceScopeLastAttemptAt(
  database: SqliteDatabase,
  scopeKey: string,
): number | null {
  const row = database
    .prepare('SELECT last_attempt_at FROM source_scope_runtime WHERE scope_key = ?')
    .get(scopeKey) as { last_attempt_at: number } | undefined;
  return row?.last_attempt_at ?? null;
}

export function sourceScopeNeedsRebaseline(
  database: SqliteDatabase,
  scopeKey: string,
  now: number,
  intervalMs: number,
): boolean {
  const lastAttemptAt = getSourceScopeLastAttemptAt(database, scopeKey);
  return lastAttemptAt !== null && now - lastAttemptAt > intervalMs * 2;
}

export function recordSourceScopeAttempt(
  database: SqliteDatabase,
  input: { scopeKey: string; adapterKey: string; sourceId: string; now: number },
): void {
  database
    .prepare(
      `INSERT INTO source_scope_runtime (
        scope_key, adapter_key, source_id, last_attempt_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET
        adapter_key = excluded.adapter_key,
        source_id = excluded.source_id,
        last_attempt_at = excluded.last_attempt_at`,
    )
    .run(input.scopeKey, input.adapterKey, input.sourceId, input.now);
}
