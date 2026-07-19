import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';

describe('GET /api/health', () => {
  let app: FastifyInstance | undefined;
  let database: SqliteDatabase | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('分别报告 SQLite 与本地 Worker 健康状态', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-health-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'healthy',
      checks: {
        storage: { status: 'healthy' },
        worker: {
          status: 'healthy',
          running: true,
          lastHeartbeatAt: expect.any(String),
        },
      },
    });
  });

  it('tick 顶层捕获意外 SQLite 错误且下一 tick 可恢复', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-health-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({
      databasePath,
      workerPollMs: 5,
      now: () => now,
    });
    database = openDatabase(databasePath);
    const headers = { host: '127.0.0.1' };

    database.exec('ALTER TABLE job RENAME TO job_temporarily_unavailable');
    now += 5;
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/health', headers })
          ).json().checks.worker,
        { timeout: 1_000 },
      )
      .toMatchObject({
        status: 'degraded',
        lastErrorCode: 'WORKER_TICK_FAILED',
        heartbeatGapMs: null,
      });
    expect(
      (await app.inject({ method: 'GET', url: '/api/health', headers })).json().status,
    ).toBe('degraded');

    database.exec('ALTER TABLE job_temporarily_unavailable RENAME TO job');
    now += 5;
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/health', headers })
          ).json().checks.worker,
        { timeout: 1_000 },
      )
      .toMatchObject({
        status: 'healthy',
        lastErrorCode: null,
      });
  });

  it('检测休眠 heartbeat gap，报告 degraded 且下一次正常 tick 自动恢复', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-health-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      workerPollMs: 5,
      now: () => now,
    });
    const headers = { host: '127.0.0.1' };

    now += 60_000;
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/health', headers })
          ).json().checks.worker,
        { timeout: 1_000 },
      )
      .toMatchObject({
        status: 'degraded',
        lastErrorCode: 'WORKER_HEARTBEAT_GAP',
        heartbeatGapMs: 60_000,
      });
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/events', headers })
      ).json().events,
    ).toEqual([]);

    now += 5;
    await expect
      .poll(
        async () =>
          (
            await app!.inject({ method: 'GET', url: '/api/health', headers })
          ).json().checks.worker,
        { timeout: 1_000 },
      )
      .toMatchObject({
        status: 'healthy',
        lastErrorCode: null,
        heartbeatGapMs: null,
      });
  });
});
