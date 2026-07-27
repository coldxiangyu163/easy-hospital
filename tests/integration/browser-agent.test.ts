import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { pumchDermatologyScheduleManifest } from '../../src/adapters/sources/pumch.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

const pumchManifestOnlyAdapter: SourceAdapter = {
  manifest: pumchDermatologyScheduleManifest,
  async check() {
    throw new Error('Browser Agent 准入测试不应运行公开来源请求');
  },
};

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
        scheduleStatus: 'unknown',
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

  it('拒绝任何 scheduleStatus=present 的 observation(排班不得由号源推导)', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-browser-agent-'));
    const token = 'schedule-inference-secret';
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: token,
      now: () => Date.parse(payload.observedAt),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
      payload: {
        ...payload,
        requestId: 'schedule-inference-1',
        observations: [{ ...payload.observations[0], scheduleStatus: 'present' }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('只产生 availability/cancellation 事件，永不产生 schedule_released', async () => {
    let tick = Date.parse('2026-07-19T01:00:00.000Z');
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-browser-agent-'));
    const token = 'availability-events-secret';
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: token,
      sourceAdapters: [pumchManifestOnlyAdapter],
      workerPollMs: 60_000,
      now: () => tick,
    });
    const uiHeaders = {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1:3210',
      'x-easy-hospital-client': 'web',
    };
    const createdTask = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: uiHeaders,
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'AM',
        eventTypes: [
          'schedule_released',
          'availability_changed_to_available',
          'cancellation_slot_detected',
        ],
        remindBeforeMinutes: null,
      },
    });
    expect(createdTask.statusCode).toBe(201);

    const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
    const makeObservation = (doctor: string, availability: 'available' | 'unavailable') => ({
      slotKey: `browser-agent:hospital-pumch:campus-pumch-dongdan:department-pumch-dermatology:2026-07-20:AM:${encodeURIComponent(doctor)}:*`,
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      date: '2026-07-20',
      session: 'AM',
      doctorName: doctor,
      title: null,
      scheduleStatus: 'unknown',
      availability,
      officialEntryUrl: 'https://pumchapp.pumch.cn/',
      evidence: 'explicit',
    });
    const submit = async (
      requestId: string,
      observations: Array<ReturnType<typeof makeObservation>>,
    ) =>
      app!.inject({
        method: 'POST',
        url: '/api/browser-agent/observations',
        headers,
        payload: {
          sourceId: 'browser-agent-hospital-pumch',
          requestId,
          observedAt: new Date(tick).toISOString(),
          observations,
        },
      });

    // 第一轮：明确无号(建立基线与明确状态)
    const first = await submit('avail-1', [makeObservation('医生甲', 'unavailable')]);
    expect(first.statusCode).toBe(202);
    expect(first.json().eventsCreated).toBe(0);

    // 第二轮(5 分钟后)：同一 slot 变为有号 → availability + 疑似退号,绝无 schedule_released
    tick += 300_001;
    const second = await submit('avail-2', [makeObservation('医生甲', 'available')]);
    expect(second.statusCode).toBe(202);
    expect(second.json().eventsCreated).toBe(2);

    // 第三轮(再 5 分钟后)：新医生 slot 直接有号 → 不推导排班发布，不产任何事件
    tick += 300_001;
    const third = await submit('avail-3', [makeObservation('医生乙', 'available')]);
    expect(third.statusCode).toBe(202);
    expect(third.json().eventsCreated).toBe(0);

    const events = (
      await app!.inject({ method: 'GET', url: '/api/events', headers: { host: '127.0.0.1' } })
    ).json().events;
    expect(events).toHaveLength(2);
    expect(events.map((event: { eventType: string }) => event.eventType).sort()).toEqual([
      'availability_changed_to_available',
      'cancellation_slot_detected',
    ]);
    expect(
      events.some((event: { eventType: string }) => event.eventType === 'schedule_released'),
    ).toBe(false);
  });
});
