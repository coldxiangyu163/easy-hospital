import type { SqliteDatabase } from './database.js';

const BROWSER_AGENT_PRINCIPAL = 'browser-agent-global';
const MIN_INGEST_INTERVAL_MS = 300_000;
const MAX_OBSERVATION_AGE_MS = 10 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

type BrowserAgentRuntimeRow = {
  source_id: string;
  last_ingest_at: number;
  last_seen_at: number;
  last_observed_at: number | null;
};

export type BrowserAgentRuntime = {
  sourceId: string;
  lastIngestAt: number;
  lastSeenAt: number;
  lastObservedAt: number | null;
};

export type BrowserAgentAdmission =
  | { status: 'accepted' }
  | {
      status: 'rejected';
      statusCode: 409 | 422 | 429;
      errorCode: string;
      retryAfterMs?: number;
    };

function toRuntime(row: BrowserAgentRuntimeRow): BrowserAgentRuntime {
  return {
    sourceId: row.source_id,
    lastIngestAt: row.last_ingest_at,
    lastSeenAt: row.last_seen_at,
    lastObservedAt: row.last_observed_at,
  };
}

export function getBrowserAgentRuntime(
  database: SqliteDatabase,
  sourceId = BROWSER_AGENT_PRINCIPAL,
): BrowserAgentRuntime | undefined {
  const row = database
    .prepare('SELECT * FROM browser_agent_runtime WHERE source_id = ?')
    .get(sourceId) as BrowserAgentRuntimeRow | undefined;
  return row ? toRuntime(row) : undefined;
}

export function getLatestBrowserAgentSeenAt(database: SqliteDatabase): number | undefined {
  const row = database
    .prepare('SELECT MAX(last_seen_at) AS last_seen_at FROM browser_agent_runtime')
    .get() as { last_seen_at: number | null };
  return row.last_seen_at ?? undefined;
}

export function browserAgentRetryAfterMs(database: SqliteDatabase, now: number): number {
  const runtime = getBrowserAgentRuntime(database);
  if (!runtime) return 0;
  return Math.max(0, runtime.lastIngestAt + MIN_INGEST_INTERVAL_MS - now);
}

export function assessBrowserAgentIngest(
  database: SqliteDatabase,
  input: { requestId: string; observedAt: number; ingestedAt: number },
): BrowserAgentAdmission {
  const duplicate = database
    .prepare('SELECT 1 FROM browser_agent_request WHERE request_id = ?')
    .get(input.requestId);
  if (duplicate) {
    return {
      status: 'rejected',
      statusCode: 409,
      errorCode: 'BROWSER_AGENT_REQUEST_REPLAY',
    };
  }

  if (input.observedAt < input.ingestedAt - MAX_OBSERVATION_AGE_MS) {
    return {
      status: 'rejected',
      statusCode: 422,
      errorCode: 'BROWSER_AGENT_OBSERVED_AT_TOO_OLD',
    };
  }
  if (input.observedAt > input.ingestedAt + MAX_FUTURE_SKEW_MS) {
    return {
      status: 'rejected',
      statusCode: 422,
      errorCode: 'BROWSER_AGENT_OBSERVED_AT_IN_FUTURE',
    };
  }

  const retryAfterMs = browserAgentRetryAfterMs(database, input.ingestedAt);
  if (retryAfterMs > 0) {
    return {
      status: 'rejected',
      statusCode: 429,
      errorCode: 'BROWSER_AGENT_RATE_LIMITED',
      retryAfterMs,
    };
  }

  const runtime = getBrowserAgentRuntime(database);
  if (runtime?.lastObservedAt !== null && runtime?.lastObservedAt !== undefined) {
    if (input.observedAt <= runtime.lastObservedAt) {
      return {
        status: 'rejected',
        statusCode: 422,
        errorCode: 'BROWSER_AGENT_OBSERVED_AT_NON_MONOTONIC',
      };
    }
  }

  return { status: 'accepted' };
}

export function recordBrowserAgentIngest(
  database: SqliteDatabase,
  input: { requestId: string; sourceId: string; observedAt: number; ingestedAt: number },
): void {
  database
    .prepare(
      `INSERT INTO browser_agent_request (request_id, source_id, observed_at, accepted_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.requestId, input.sourceId, input.observedAt, input.ingestedAt);
  database
    .prepare(
      `INSERT INTO browser_agent_runtime (
         source_id, last_ingest_at, last_seen_at, last_observed_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (source_id) DO UPDATE SET
         last_ingest_at = excluded.last_ingest_at,
         last_seen_at = excluded.last_seen_at,
         last_observed_at = excluded.last_observed_at`,
    )
    .run(
      BROWSER_AGENT_PRINCIPAL,
      input.ingestedAt,
      input.ingestedAt,
      input.observedAt,
    );
}
