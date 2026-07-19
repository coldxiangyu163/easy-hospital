import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('B 级本机 Browser Agent ingest seam', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const slotKey =
    'browser-agent:hospital-pumch:campus-pumch-dongdan:department-pumch-dermatology:2026-07-20:AM:%E7%A4%BA%E4%BE%8B%E5%8C%BB%E7%94%9F:%E4%B8%BB%E4%BB%BB%E5%8C%BB%E5%B8%88';
  const payload = {
    sourceId: 'browser-agent-hospital-pumch',
    requestId: 'browser-request-1',
    observedAt: '2026-07-19T01:00:00.000Z',
    observations: [
      {
        slotKey,
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        date: '2026-07-20',
        session: 'AM',
        doctorName: '示例医生',
        title: '主任医师',
        scheduleStatus: 'present',
        availability: 'unavailable',
        officialEntryUrl: 'https://pumchapp.pumch.cn/',
        evidence: 'explicit',
      },
    ],
  };

  it('要求 Bearer 配对令牌，成功后持久化脱敏 Observation 与 lastSeen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-browser-agent-'));
    const token = 'paired-browser-agent-secret';
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: token,
      now: () => Date.parse(payload.observedAt),
    });
    const headers = { host: '127.0.0.1' };

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers,
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ status: 'accepted', eventsCreated: 0 });

    const states = await app.inject({
      method: 'GET',
      url: '/api/availability-states?sourceId=browser-agent-hospital-pumch',
      headers,
    });
    expect(states.json()).toMatchObject({
      states: [
        {
          slotKey,
          availability: 'unavailable',
          currentAvailability: 'unavailable',
        },
      ],
    });

    const runtime = await app.inject({ method: 'GET', url: '/api/runtime-status', headers });
    expect(runtime.json()).toMatchObject({
      browserAgent: { configured: true, lastSeenAt: expect.any(String) },
    });
    expect(runtime.body).not.toContain(token);

    const limited = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: { ...payload, requestId: 'browser-request-2' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: 'BROWSER_AGENT_RATE_LIMITED',
      retryAfterMs: expect.any(Number),
    });
  });

  it('strict payload 拒绝 HTML、header、cookie 和 token 字段且不回显内容', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-browser-agent-'));
    const token = 'privacy-pairing-secret';
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: token,
      now: () => Date.parse(payload.observedAt),
    });

    for (const forbidden of ['html', 'headers', 'cookie', 'token'] as const) {
      const secret = `${forbidden}-private-value`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/browser-agent/observations',
        headers: {
          host: '127.0.0.1',
          authorization: `Bearer ${token}`,
        },
        payload: { ...payload, requestId: `privacy-${forbidden}`, [forbidden]: secret },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(token);
    }
  });
});
