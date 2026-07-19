import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

describe('事件 Outbox 去重与冷却', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['暂停', 'pause', 'TASK_INACTIVE'],
    ['编辑', 'edit', 'TASK_CHANGED'],
    ['删除', 'delete', 'TASK_DELETED'],
  ] as const)(
    '同一次变化聚合后，任务%s使未发送批次进入诚实终态',
    async (_label, action, expectedReason) => {
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-outbox',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        const available = attempt > 1;
        return {
          status: 'OK',
          observedAt: available ? '2026-07-19T00:05:00.000Z' : '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(String(available)).digest('hex'),
          observations: [
            {
              slotKey: 'slot-outbox',
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

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-outbox-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1' };
    const createdTaskResponse = await app.inject({
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
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: [
          'availability_changed_to_available',
          'cancellation_slot_detected',
        ],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'outbox-1',
      sourceId: 'source-outbox',
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
      url: '/api/source-checks/fixture-outbox',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-outbox',
      headers,
      payload: { ...payload, requestId: 'outbox-2' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notification-batches',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      batches: [
        {
          state: 'collecting',
          opensAt: '2026-07-19T00:05:00.000Z',
          closesAt: '2026-07-19T00:06:00.000Z',
          eventTags: [
            'availability_changed_to_available',
            'cancellation_slot_detected',
          ],
        },
      ],
    });

    const task = createdTaskResponse.json();
    if (action === 'delete') {
      await app.inject({
        method: 'DELETE',
        url: `/api/watch-tasks/${task.id}`,
        headers,
      });
    } else {
      await app.inject({
        method: 'PATCH',
        url: `/api/watch-tasks/${task.id}`,
        headers,
        payload:
          action === 'pause'
            ? { version: task.version, enabled: false }
            : { version: task.version, session: 'PM' },
      });
    }
    await expect
      .poll(
        async () =>
          (
            await app!.inject({
              method: 'GET',
              url: '/api/notification-batches',
              headers,
            })
          ).json().batches[0],
        { timeout: 2_000 },
      )
      .toMatchObject({
        state: 'failed',
        terminalReason: expectedReason,
        deliveries: [],
      });
    },
  );
});
