import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('Observation 到事件的 HTTP /api 纵向切片', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('同一号源从明确无号变为有号时生成一次事件', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-public',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const available = attempt === 2;
        return {
          status: 'OK',
          observedAt: available ? '2026-07-19T00:31:00.000Z' : '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: hash(String(available)),
          observations: [
            {
              slotKey: 'slot-1',
              hospitalId: 'hospital-tongren',
              campusId: 'campus-tongren-chongwenmen',
              departmentId: 'department-tongren-rhinology',
              date: '2026-07-20',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present',
              availability: available ? 'available' : 'unavailable',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };

    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'AM',
        eventTypes: ['availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });

    const checkPayload = {
      requestId: 'request-1',
      sourceId: 'source-1',
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T00:40:00.000Z',
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-public',
      headers,
      payload: checkPayload,
    });
    const secondCheck = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-public',
      headers,
      payload: { ...checkPayload, requestId: 'request-2' },
    });
    expect(secondCheck.statusCode).toBe(200);
    expect(secondCheck.json()).toMatchObject({ status: 'OK', eventsCreated: 1 });

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/events',
      headers,
    });
    expect(eventsResponse.json()).toMatchObject({
      events: [
        {
          eventType: 'availability_changed_to_available',
          slotKey: 'slot-1',
          fromState: 'unavailable',
          toState: 'available',
        },
      ],
    });
  });

  it('unknown 作为当前结果可见，但不覆盖最后明确状态', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-unknown',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const unknown = attempt === 2;
        return {
          status: 'OK',
          observedAt: unknown ? '2026-07-19T00:05:00.000Z' : '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: hash(String(unknown)),
          observations: [
            {
              slotKey: 'slot-unknown',
              hospitalId: 'hospital-tongren',
              campusId: 'campus-tongren-chongwenmen',
              departmentId: 'department-tongren-rhinology',
              date: '2026-07-20',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: unknown ? 'unknown' : 'present',
              availability: unknown ? 'unknown' : 'unavailable',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    const payload = {
      requestId: 'unknown-1',
      sourceId: 'source-unknown',
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T00:10:00.000Z',
    };

    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-unknown',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-unknown',
      headers,
      payload: { ...payload, requestId: 'unknown-2' },
    });

    const statesResponse = await app.inject({
      method: 'GET',
      url: '/api/availability-states?sourceId=source-unknown',
      headers,
    });
    expect(statesResponse.statusCode).toBe(200);
    expect(statesResponse.json()).toEqual({
      states: [
        {
          sourceId: 'source-unknown',
          slotKey: 'slot-unknown',
          availability: 'unavailable',
          currentAvailability: 'unknown',
          lastExplicitAt: '2026-07-19T00:00:00.000Z',
          lastObservedAt: '2026-07-19T00:05:00.000Z',
        },
      ],
    });
  });

  it('首次 all-unknown 不建可解释基线，明确恢复只建基线，后续明确变化才产事件', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-all-unknown-baseline',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const states = [
          { scheduleStatus: 'unknown', availability: 'unknown' },
          { scheduleStatus: 'present', availability: 'available' },
          { scheduleStatus: 'unknown', availability: 'unknown' },
          { scheduleStatus: 'present', availability: 'unavailable' },
          { scheduleStatus: 'present', availability: 'available' },
        ] as const;
        const state = states[attempt - 1]!;
        const observations = [
          {
            slotKey: 'recovered-slot',
            hospitalId: 'hospital-pumch',
            campusId: 'campus-pumch-dongdan',
            departmentId: 'department-pumch-dermatology',
            date: '2026-07-20',
            session: 'AM' as const,
            doctorName: '医生甲',
            title: '主任医师',
            scheduleStatus: state.scheduleStatus,
            availability: state.availability,
            officialEntryUrl: 'https://hospital.example/appointment',
            evidence: 'explicit' as const,
          },
        ];
        if (attempt === 5) {
          observations.push({
            slotKey: 'later-new-slot',
            hospitalId: 'hospital-pumch',
            campusId: 'campus-pumch-dongdan',
            departmentId: 'department-pumch-dermatology',
            date: '2026-07-21',
            session: 'AM',
            doctorName: '医生乙',
            title: '副主任医师',
            scheduleStatus: 'present',
            availability: 'unknown',
            officialEntryUrl: 'https://hospital.example/appointment',
            evidence: 'explicit',
          });
        }
        return {
          status: 'OK',
          observedAt: new Date(Date.UTC(2026, 6, 19, 0, attempt * 5)).toISOString(),
          nextAllowedAt: null,
          contentHash: hash(`all-unknown-baseline-${attempt}`),
          observations,
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
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
        eventTypes: ['schedule_released', 'availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'all-unknown-baseline-1',
      sourceId: 'source-all-unknown-baseline',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T01:00:00.000Z',
    };

    const eventCounts: number[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/source-checks/fixture-all-unknown-baseline',
        headers,
        payload: { ...payload, requestId: `all-unknown-baseline-${index}` },
      });
      expect(response.statusCode).toBe(200);
      eventCounts.push(response.json().eventsCreated);
    }

    expect(eventCounts).toEqual([0, 0, 0, 0, 2]);
    const events = (
      await app.inject({ method: 'GET', url: '/api/events', headers })
    ).json().events;
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'availability_changed_to_available',
          slotKey: 'recovered-slot',
          fromState: 'unavailable',
          toState: 'available',
        }),
        expect.objectContaining({
          eventType: 'schedule_released',
          slotKey: 'later-new-slot',
          fromState: 'absent',
          toState: 'present',
        }),
      ]),
    );
  });

  it('基线建立后首次出现的新排班生成 schedule_released', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-schedule',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const observations =
          attempt === 1
            ? []
            : [
                {
                  slotKey: 'new-schedule',
                  hospitalId: 'hospital-pumch',
                  campusId: 'campus-pumch-dongdan',
                  departmentId: 'department-pumch-dermatology',
                  date: '2026-07-22',
                  session: 'PM' as const,
                  doctorName: '示例医生',
                  title: '副主任医师',
                  scheduleStatus: 'present' as const,
                  availability: 'unavailable' as const,
                  officialEntryUrl: 'https://hospital.example/appointment',
                  evidence: 'explicit' as const,
                },
              ];
        return {
          status: 'OK' as const,
          observedAt: attempt === 1 ? '2026-07-19T00:00:00.000Z' : '2026-07-19T00:05:00.000Z',
          nextAllowedAt: null,
          contentHash: hash(String(attempt)),
          observations,
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'PM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'schedule-1',
      sourceId: 'source-schedule',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'PM',
      deadlineAt: '2026-07-19T00:10:00.000Z',
    };

    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-schedule',
      headers,
      payload,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-schedule',
      headers,
      payload: { ...payload, requestId: 'schedule-2' },
    });

    expect(response.json()).toMatchObject({ eventsCreated: 1 });
    const events = (
      await app.inject({ method: 'GET', url: '/api/events', headers })
    ).json().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'schedule_released',
      slotKey: 'new-schedule',
      fromState: 'absent',
      toState: 'present',
    });
  });

  it('PARTIAL 空结果不建立基线，恢复后的 OK 全量先静默建基线再报新增', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-partial-baseline',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        if (attempt === 1) {
          return {
            status: 'PARTIAL' as const,
            observedAt: '2026-07-19T00:00:00.000Z',
            nextAllowedAt: null,
            contentHash: hash('partial-empty'),
            observations: [],
          };
        }
        const slotA = {
          slotKey: 'partial-slot-a',
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          date: '2026-07-20',
          session: 'AM' as const,
          doctorName: '医生甲',
          title: null,
          scheduleStatus: 'present' as const,
          availability: 'unknown' as const,
          officialEntryUrl: 'https://hospital.example/appointment',
          evidence: 'explicit' as const,
        };
        const slotB = {
          ...slotA,
          slotKey: 'partial-slot-b',
          doctorName: '医生乙',
        };
        return {
          status: 'OK' as const,
          observedAt: `2026-07-19T00:0${attempt}:00.000Z`,
          nextAllowedAt: null,
          contentHash: hash(`partial-ok-${attempt}`),
          observations: attempt === 2 ? [slotA] : [slotA, slotB],
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
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
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'partial-1',
      sourceId: 'source-partial-baseline',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T00:10:00.000Z',
    };

    const eventCounts: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/source-checks/fixture-partial-baseline',
        headers,
        payload: { ...payload, requestId: `partial-${index}` },
      });
      expect(response.statusCode).toBe(200);
      eventCounts.push(response.json().eventsCreated);
    }

    // PARTIAL 空轮不建基线 → OK 全量轮只静默建基线(slotA 不报) → 后续仅新增 slotB 报一次
    expect(eventCounts).toEqual([0, 0, 1]);
    const events = (
      await app.inject({ method: 'GET', url: '/api/events', headers })
    ).json().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'schedule_released',
      slotKey: 'partial-slot-b',
      fromState: 'absent',
      toState: 'present',
    });
  });

  it('最近 30 分钟明确无号后变为有号时生成疑似退号事件', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-cancellation',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const available = attempt === 2;
        return {
          status: 'OK',
          observedAt: available ? '2026-07-19T00:05:00.000Z' : '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: hash(`cancellation-${attempt}`),
          observations: [
            {
              slotKey: 'return-slot',
              hospitalId: 'hospital-pumch',
              campusId: 'campus-pumch-dongdan',
              departmentId: 'department-pumch-dermatology',
              date: '2026-07-22',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present',
              availability: available ? 'available' : 'unavailable',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
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
        eventTypes: ['cancellation_slot_detected'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'cancellation-1',
      sourceId: 'source-cancellation',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T00:10:00.000Z',
    };

    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-cancellation',
      headers,
      payload,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-cancellation',
      headers,
      payload: { ...payload, requestId: 'cancellation-2' },
    });

    expect(response.json()).toMatchObject({ eventsCreated: 1 });
    const events = (
      await app.inject({ method: 'GET', url: '/api/events', headers })
    ).json().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'cancellation_slot_detected',
      evidence: 'inferred',
      fromState: 'unavailable',
      toState: 'available',
    });
  });

  it('availability unknown 仍持久化排班基线，重复排班不误报而新增 slot 才报发布', async () => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-pumch-unknown-schedule',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const slotKeys = attempt < 3 ? ['published-a'] : ['published-a', 'published-b'];
        return {
          status: 'OK',
          observedAt: new Date(Date.UTC(2026, 6, 19, 0, attempt * 5)).toISOString(),
          nextAllowedAt: null,
          contentHash: hash(`pumch-unknown-${attempt}`),
          observations: slotKeys.map((slotKey, index) => ({
            slotKey,
            hospitalId: 'hospital-pumch',
            campusId: 'campus-pumch-dongdan',
            departmentId: 'department-pumch-dermatology',
            date: index === 0 ? '2026-07-20' : '2026-07-21',
            session: 'AM' as const,
            doctorName: index === 0 ? '医生甲' : '医生乙',
            title: null,
            scheduleStatus: 'present' as const,
            availability: 'unknown' as const,
            officialEntryUrl: 'https://hospital.example/appointment',
            evidence: 'explicit' as const,
          })),
        };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-monitoring-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
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
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'pumch-unknown-1',
      sourceId: 'source-pumch-unknown',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T01:00:00.000Z',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-pumch-unknown-schedule',
      headers,
      payload,
    });
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-pumch-unknown-schedule',
      headers,
      payload: { ...payload, requestId: 'pumch-unknown-2' },
    });
    const added = await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-pumch-unknown-schedule',
      headers,
      payload: { ...payload, requestId: 'pumch-unknown-3' },
    });

    expect(first.json()).toMatchObject({ eventsCreated: 0 });
    expect(repeated.json()).toMatchObject({ eventsCreated: 0 });
    expect(added.json()).toMatchObject({ eventsCreated: 1 });
    const events = (
      await app.inject({ method: 'GET', url: '/api/events', headers })
    ).json().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'schedule_released',
      slotKey: 'published-b',
    });
  });
});
