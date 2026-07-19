import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './database.js';

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type PersistentJob = {
  id: string;
  type: string;
  payload: unknown;
  runAt: number;
  state: JobState;
  leaseUntil: number | null;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string;
  lastErrorCode: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type EnqueueJob = {
  type: string;
  payload: unknown;
  runAt: number;
  dedupeKey: string;
  maxAttempts: number;
};

type JobRow = {
  id: string;
  type: string;
  payload_json: string;
  run_at: number;
  state: JobState;
  lease_until: number | null;
  attempts: number;
  max_attempts: number;
  dedupe_key: string;
  last_error_code: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

function toJob(row: JobRow): PersistentJob {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    runAt: row.run_at,
    state: row.state,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    dedupeKey: row.dedupe_key,
    lastErrorCode: row.last_error_code,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteJobRunner {
  constructor(private readonly database: SqliteDatabase) {}

  enqueue(input: EnqueueJob): PersistentJob {
    const id = randomUUID();
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO job (
          id, type, payload_json, run_at, state, lease_until, attempts,
          max_attempts, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, 0, ?, ?, ?, ?)
        ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        input.type,
        JSON.stringify(input.payload),
        input.runAt,
        input.maxAttempts,
        input.dedupeKey,
        now,
        now,
      );

    return this.getByDedupeKey(input.dedupeKey)!;
  }

  claimNext(options: { now: number; leaseMs: number }): PersistentJob | undefined {
    const claim = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE job
           SET state = 'failed', lease_until = NULL, last_error_code = 'LEASE_EXPIRED', updated_at = ?
           WHERE state = 'running' AND lease_until < ? AND attempts >= max_attempts`,
        )
        .run(options.now, options.now);
      this.database
        .prepare(
          `UPDATE job
           SET state = 'pending', lease_until = NULL, run_at = ?, last_error_code = 'LEASE_EXPIRED', updated_at = ?
           WHERE state = 'running' AND lease_until < ? AND attempts < max_attempts`,
        )
        .run(options.now, options.now, options.now);

      const row = this.database
        .prepare(
          `SELECT id FROM job
           WHERE state = 'pending' AND run_at <= ?
           ORDER BY run_at, created_at, id
           LIMIT 1`,
        )
        .get(options.now) as { id: string } | undefined;
      if (!row) return undefined;

      const updated = this.database
        .prepare(
          `UPDATE job
           SET state = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(options.now + options.leaseMs, options.now, row.id);
      if (updated.changes !== 1) return undefined;
      return this.get(row.id);
    });

    return claim.immediate();
  }

  complete(id: string, now: number): void {
    this.database
      .prepare(
        `UPDATE job
         SET state = 'succeeded', lease_until = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(now, now, id);
  }

  fail(
    id: string,
    options: { now: number; errorCode: string; retryAt: number },
  ): void {
    const job = this.get(id);
    if (!job || job.state !== 'running') return;

    if (job.attempts >= job.maxAttempts) {
      this.database
        .prepare(
          `UPDATE job
           SET state = 'failed', lease_until = NULL, last_error_code = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(options.errorCode, options.now, options.now, id);
      return;
    }

    this.database
      .prepare(
        `UPDATE job
         SET state = 'pending', run_at = ?, lease_until = NULL, last_error_code = ?, updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(options.retryAt, options.errorCode, options.now, id);
  }

  get(id: string): PersistentJob | undefined {
    const row = this.database.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  hasActiveSourceScopeJob(scopeKey: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM job
           WHERE type = 'source-check'
             AND state IN ('pending', 'running')
             AND json_extract(payload_json, '$.scopeKey') = ?
           LIMIT 1`,
        )
        .get(scopeKey),
    );
  }

  hasActiveTaskJob(type: string, taskId: string, taskVersion: number): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM job
           WHERE type = ?
             AND state IN ('pending', 'running')
             AND json_extract(payload_json, '$.taskId') = ?
             AND json_extract(payload_json, '$.taskVersion') = ?
           LIMIT 1`,
        )
        .get(type, taskId, taskVersion),
    );
  }

  private getByDedupeKey(dedupeKey: string): PersistentJob | undefined {
    const row = this.database.prepare('SELECT * FROM job WHERE dedupe_key = ?').get(dedupeKey) as
      | JobRow
      | undefined;
    return row ? toJob(row) : undefined;
  }
}
