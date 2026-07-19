import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('Fastify SQLITE_BUSY mapping', () => {
  let app: FastifyInstance | undefined;
  let lockDatabase: Database.Database | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (lockDatabase?.inTransaction) lockDatabase.exec('ROLLBACK');
    lockDatabase?.close();
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('稳定返回 503 且不泄露 SQLite 内部，释放锁后可安全重试', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-sqlite-busy-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({ databasePath, workerPollMs: 60_000 });
    lockDatabase = new Database(databasePath);
    lockDatabase.exec('BEGIN IMMEDIATE');
    const request = {
      method: 'POST' as const,
      url: '/api/watch-tasks',
      headers: {
        host: '127.0.0.1',
        origin: 'http://127.0.0.1:3210',
        'x-easy-hospital-client': 'web',
      },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    };

    const busy = await app.inject(request);
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({
      error: 'STORAGE_BUSY',
      message: '本地数据正忙，请稍后重试',
    });
    expect(busy.body).not.toMatch(/SQLITE|database|locked|INSERT|watch_task/i);

    lockDatabase.exec('ROLLBACK');
    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(201);
  }, 10_000);
});
