import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { SqliteJobRunner } from '../../src/storage/job-runner.js';

describe('SQLite 持久 Job Runner seam', () => {
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('只领取到期 Job，并持久化完成状态', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-jobs-'));
    database = openDatabase(join(directory, 'data.sqlite3'));
    const runner = new SqliteJobRunner(database);

    const enqueued = runner.enqueue({
      type: 'source-check',
      payload: { sourceId: 'source-public-demo' },
      runAt: 1_000,
      dedupeKey: 'check:source-public-demo:1000',
      maxAttempts: 3,
    });

    expect(runner.claimNext({ now: 999, leaseMs: 5_000 })).toBeUndefined();

    const claimed = runner.claimNext({ now: 1_000, leaseMs: 5_000 });
    expect(claimed).toMatchObject({
      id: enqueued.id,
      state: 'running',
      attempts: 1,
      leaseUntil: 6_000,
      payload: { sourceId: 'source-public-demo' },
    });

    runner.complete(enqueued.id, 1_001);
    expect(runner.get(enqueued.id)).toMatchObject({
      state: 'succeeded',
      completedAt: 1_001,
    });
  });

  it('重启后重新领取租约已过期的 running Job', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-jobs-'));
    const path = join(directory, 'data.sqlite3');
    database = openDatabase(path);
    let runner = new SqliteJobRunner(database);
    const enqueued = runner.enqueue({
      type: 'notification',
      payload: { deliveryId: 'delivery-1' },
      runAt: 1_000,
      dedupeKey: 'notify:delivery-1',
      maxAttempts: 3,
    });
    runner.claimNext({ now: 1_000, leaseMs: 50 });
    database.close();

    database = openDatabase(path);
    runner = new SqliteJobRunner(database);
    const reclaimed = runner.claimNext({ now: 1_051, leaseMs: 50 });

    expect(reclaimed).toMatchObject({
      id: enqueued.id,
      state: 'running',
      attempts: 2,
      leaseUntil: 1_101,
    });
  });

  it('失败 Job 按 retryAt 重排，达到上限后进入终态', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-jobs-'));
    database = openDatabase(join(directory, 'data.sqlite3'));
    const runner = new SqliteJobRunner(database);
    const job = runner.enqueue({
      type: 'source-check',
      payload: {},
      runAt: 1_000,
      dedupeKey: 'check:retry',
      maxAttempts: 2,
    });

    runner.claimNext({ now: 1_000, leaseMs: 50 });
    runner.fail(job.id, { now: 1_001, errorCode: 'TEMPORARY_FAILURE', retryAt: 2_000 });
    expect(runner.get(job.id)).toMatchObject({
      state: 'pending',
      runAt: 2_000,
      lastErrorCode: 'TEMPORARY_FAILURE',
    });

    runner.claimNext({ now: 2_000, leaseMs: 50 });
    runner.fail(job.id, { now: 2_001, errorCode: 'TEMPORARY_FAILURE', retryAt: 3_000 });
    expect(runner.get(job.id)).toMatchObject({
      state: 'failed',
      attempts: 2,
      lastErrorCode: 'TEMPORARY_FAILURE',
      completedAt: 2_001,
    });
  });
});
