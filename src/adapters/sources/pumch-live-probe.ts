import type { CheckResult } from '../../core/source-adapter.js';
import type { SqliteDatabase } from '../../storage/database.js';
import {
  recordSourceAttempt,
  recordSourceResult,
  sourceRetryAfterMs,
} from '../../storage/source-runtime.js';
import { pumchDermatologyScheduleManifest } from './pumch.js';

export type PumchLiveProbeCooldownClaim =
  | { claimed: true; retryAfterMs: 0 }
  | { claimed: false; retryAfterMs: number };

export function claimPumchLiveProbeCooldown(
  database: SqliteDatabase,
  now: number,
): PumchLiveProbeCooldownClaim {
  return database.transaction((): PumchLiveProbeCooldownClaim => {
    const retryAfterMs = sourceRetryAfterMs(
      database,
      pumchDermatologyScheduleManifest.adapterKey,
      now,
    );
    if (retryAfterMs > 0) return { claimed: false, retryAfterMs };

    recordSourceAttempt(
      database,
      pumchDermatologyScheduleManifest.adapterKey,
      now,
      pumchDermatologyScheduleManifest.minIntervalMs,
    );
    return { claimed: true, retryAfterMs: 0 };
  })();
}

export function finishPumchLiveProbeCooldown(
  database: SqliteDatabase,
  result: CheckResult,
  attemptedAt: number,
): void {
  recordSourceResult(
    database,
    pumchDermatologyScheduleManifest.adapterKey,
    result,
    attemptedAt + pumchDermatologyScheduleManifest.minIntervalMs,
  );
}
