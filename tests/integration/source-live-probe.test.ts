import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

describe('SourceAdapter live probe', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('执行真实契约路径并持久遵守 Adapter minIntervalMs', async () => {
    let calls = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-live',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        calls += 1;
        const observedAt = new Date().toISOString();
        return {
          status: 'OK',
          observedAt,
          nextAllowedAt: new Date(Date.now() + 300_000).toISOString(),
          contentHash: createHash('sha256').update(String(calls)).digest('hex'),
          observations: [],
        };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-live-probe-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = {
      databasePath,
      sourceAdapters: [adapter],
      enforceSourceRateLimit: true,
    };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1' };
    const payload = {
      requestId: 'live-probe-1',
      sourceId: 'fixture-live-source',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'ANY',
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/fixture-live/live-probe',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'OK', eventsCreated: 0 });
    expect(calls).toBe(1);

    const sourceStatus = await app.inject({
      method: 'GET',
      url: '/api/source-adapters',
      headers,
    });
    expect(sourceStatus.json().adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'fixture-live',
          runtime: expect.objectContaining({
            lastAttemptAt: expect.any(String),
            lastSuccessAt: expect.any(String),
            lastStatus: 'OK',
            lastErrorCode: null,
          }),
        }),
      ]),
    );

    const legacyEndpointIsAlsoLimited = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-live',
      headers,
      payload: { ...payload, requestId: 'live-probe-legacy' },
    });
    expect(legacyEndpointIsAlsoLimited.statusCode).toBe(429);
    expect(calls).toBe(1);

    const limited = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/fixture-live/live-probe',
      headers,
      payload: { ...payload, requestId: 'live-probe-2' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: 'SOURCE_RATE_LIMITED',
      retryAfterMs: expect.any(Number),
    });
    expect(calls).toBe(1);

    await app.close();
    app = await buildApp(options);
    const afterRestart = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/fixture-live/live-probe',
      headers,
      payload: { ...payload, requestId: 'live-probe-3' },
    });
    expect(afterRestart.statusCode).toBe(429);
    expect(calls).toBe(1);
  });

  it('任意 binding-aware adapter 的默认 live probe 均从 manifest 生成请求', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    let receivedRequest: unknown;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-binding-live',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
        minIntervalMs: 7_200_000,
        sourceId: 'source-fixture-binding-live',
        rateLimitKey: 'official-html:fixture-binding-live',
        eventTypes: ['schedule_released'],
        stability: 'stable',
        bindings: [
          {
            targetId: 'target-pumch-dermatology',
            hospitalId: 'hospital-pumch',
            campusId: 'campus-pumch-dongdan',
            departmentId: 'department-pumch-dermatology',
            officialEntryUrl: 'https://pumchapp.pumch.cn/pages/pc/home/index',
          },
        ],
      },
      async check(request) {
        receivedRequest = request;
        return {
          status: 'OK',
          observedAt: new Date(now).toISOString(),
          nextAllowedAt: new Date(now + 7_200_000).toISOString(),
          contentHash: 'c'.repeat(64),
          observations: [],
        };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-live-probe-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      enforceSourceRateLimit: true,
      now: () => now,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/fixture-binding-live/live-probe',
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(receivedRequest).toMatchObject({
      sourceId: 'source-fixture-binding-live',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-19',
      dateTo: '2026-07-26',
      session: 'ANY',
      deadlineAt: '2026-07-19T00:00:30.000Z',
    });
  });
});
