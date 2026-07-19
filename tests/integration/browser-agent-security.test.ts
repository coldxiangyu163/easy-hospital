import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

type Scope = 'pumch' | 'tongren';

const scopes = {
  pumch: {
    sourceId: 'browser-agent-hospital-pumch',
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
    officialEntryUrl: 'https://pumchapp.pumch.cn/',
  },
  tongren: {
    sourceId: 'browser-agent-hospital-tongren',
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
    officialEntryUrl: 'https://www.bjtrhos.cn/',
  },
} as const;

function payload(scopeName: Scope, requestId: string, observedAt: string) {
  const scope = scopes[scopeName];
  return {
    sourceId: scope.sourceId,
    requestId,
    observedAt,
    observations: [
      {
        slotKey: `browser-agent:${scope.hospitalId}:${scope.campusId}:${scope.departmentId}:2026-07-20:AM:*:*`,
        hospitalId: scope.hospitalId,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        date: '2026-07-20',
        session: 'AM',
        doctorName: null,
        title: null,
        scheduleStatus: 'present',
        availability: 'unavailable',
        officialEntryUrl: scope.officialEntryUrl,
        evidence: 'explicit',
      },
    ],
  };
}

describe('Browser Agent admission security', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('observation 拒绝外部 web Origin 且无副作用，允许 chrome-extension 或无 Origin', async () => {
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-security-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: 'paired-token',
      now: () => now,
    });
    const input = payload('pumch', 'origin-request', new Date(now).toISOString());
    const baseHeaders = { host: '127.0.0.1', authorization: 'Bearer paired-token' };

    for (const origin of ['https://attacker.example', 'http://127.0.0.1:3210']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/browser-agent/observations',
        headers: { ...baseHeaders, origin },
        payload: input,
      });
      expect(rejected.statusCode).toBe(403);
    }

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers: {
        ...baseHeaders,
        origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      payload: input,
    });
    expect(accepted.statusCode).toBe(202);

    await app.close();
    app = undefined;
    const path = join(directory, 'second.sqlite3');
    app = await buildApp({ databasePath: path, browserAgentToken: 'paired-token', now: () => now });
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers: baseHeaders,
      payload: payload('pumch', 'no-origin-request', new Date(now).toISOString()),
    });
    expect(noOrigin.statusCode).toBe(202);
  });

  it('requestId 持久去重，且两个合法 sourceId 共享全局主体限流', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-security-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = { databasePath, browserAgentToken: 'paired-token', now: () => now };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1', authorization: 'Bearer paired-token' };
    const firstPayload = payload('pumch', 'persistent-request', new Date(now).toISOString());

    const first = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: firstPayload,
    });
    expect(first.statusCode).toBe(202);

    const otherScope = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: payload('tongren', 'other-scope-request', new Date(now).toISOString()),
    });
    expect(otherScope.statusCode).toBe(429);

    await app.close();
    app = undefined;
    now += 300_001;
    app = await buildApp(options);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: firstPayload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: 'BROWSER_AGENT_REQUEST_REPLAY' });
  });

  it('拒绝过旧、未来和非单调 observedAt，reject 不写请求或状态', async () => {
    let now = Date.parse('2026-07-19T00:10:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-security-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({ databasePath, browserAgentToken: 'paired-token', now: () => now });
    const headers = { host: '127.0.0.1', authorization: 'Bearer paired-token' };

    const stale = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: payload('pumch', 'reusable-request', '2026-07-18T23:59:59.999Z'),
    });
    const future = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: payload('pumch', 'future-request', '2026-07-19T00:11:00.001Z'),
    });
    expect(stale.statusCode).toBe(422);
    expect(future.statusCode).toBe(422);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: payload('pumch', 'reusable-request', new Date(now).toISOString()),
    });
    expect(accepted.statusCode).toBe(202);

    now += 300_001;
    const nonMonotonic = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload: payload('pumch', 'non-monotonic-request', '2026-07-19T00:09:59.000Z'),
    });
    expect(nonMonotonic.statusCode).toBe(422);
    expect(nonMonotonic.json()).toEqual({ error: 'BROWSER_AGENT_OBSERVED_AT_NON_MONOTONIC' });

    await app.close();
    app = undefined;
    const database = new Database(databasePath, { readonly: true });
    expect(
      database.prepare('SELECT request_id FROM browser_agent_request ORDER BY request_id').all(),
    ).toEqual([{ request_id: 'reusable-request' }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM check_run').get()).toEqual({ count: 1 });
    database.close();
  });
});
