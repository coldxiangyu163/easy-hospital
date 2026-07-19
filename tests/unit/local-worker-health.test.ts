import { describe, expect, it } from 'vitest';

import { LocalWorker } from '../../src/server/local-worker.js';
import type { SqliteDatabase } from '../../src/storage/database.js';

describe('LocalWorker tick resilience', () => {
  it('捕获 SQLITE_BUSY 并映射为稳定 health error code，不产生 rejected activeTick', async () => {
    const busy = Object.assign(new Error('database is busy'), {
      code: 'SQLITE_BUSY_TIMEOUT',
    });
    const database = {
      prepare() {
        throw busy;
      },
    } as unknown as SqliteDatabase;
    const worker = new LocalWorker(
      database,
      [],
      [],
      60_000,
      () => Date.parse('2026-07-19T00:00:00.000Z'),
    );

    worker.start();
    expect(worker.health()).toMatchObject({
      status: 'degraded',
      running: true,
      lastErrorCode: 'SQLITE_BUSY',
      heartbeatGapMs: null,
    });
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
