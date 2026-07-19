import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { claimPumchLiveProbeCooldown } from '../../src/adapters/sources/pumch-live-probe.js';
import { openDatabase } from '../../src/storage/database.js';

describe('PUMCH live probe persistent cooldown', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('persists the two-hour claim across database reopen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'pumch-live-probe-cooldown-'));
    const databasePath = join(directory, 'data.sqlite3');
    const now = Date.parse('2026-07-19T00:00:00.000Z');

    const firstDatabase = openDatabase(databasePath);
    expect(claimPumchLiveProbeCooldown(firstDatabase, now)).toEqual({
      claimed: true,
      retryAfterMs: 0,
    });
    firstDatabase.close();

    const reopenedDatabase = openDatabase(databasePath);
    expect(claimPumchLiveProbeCooldown(reopenedDatabase, now + 1)).toEqual({
      claimed: false,
      retryAfterMs: 7_199_999,
    });
    reopenedDatabase.close();
  });
});
