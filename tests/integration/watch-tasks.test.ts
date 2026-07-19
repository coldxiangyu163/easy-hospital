import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('WatchTask HTTP /api seam', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('创建关注任务后可从列表读回全部筛选条件', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-tasks-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1' };

    const createResponse = await app.inject({
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
        eventTypes: [
          'schedule_released',
          'availability_changed_to_available',
          'cancellation_slot_detected',
        ],
        remindBeforeMinutes: 5,
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created).toMatchObject({
      hospitalId: 'hospital-tongren',
      matchMode: 'any_expert',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      session: 'AM',
      enabled: true,
      version: 1,
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/watch-tasks',
      headers,
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({ tasks: [created] });
  });

  it('按版本编辑、读取并软删除关注任务', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-tasks-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1' };
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/watch-tasks',
        headers,
        payload: {
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          matchMode: 'title',
          doctorName: null,
          titles: ['主任医师'],
          dateFrom: '2026-07-20',
          dateTo: '2026-07-26',
          session: 'ANY',
          eventTypes: ['availability_changed_to_available'],
          remindBeforeMinutes: 5,
        },
      })
    ).json();

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${created.id}`,
      headers,
      payload: { version: 1, enabled: false, session: 'PM' },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      enabled: false,
      session: 'PM',
      version: 2,
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/watch-tasks/${created.id}`,
      headers,
    });
    expect(getResponse.json()).toEqual(updateResponse.json());

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/watch-tasks/${created.id}`,
      headers,
    });
    expect(deleteResponse.statusCode).toBe(204);

    const missingResponse = await app.inject({
      method: 'GET',
      url: `/api/watch-tasks/${created.id}`,
      headers,
    });
    expect(missingResponse.statusCode).toBe(404);
  });

  it('拒绝超过连续 14 天的关注范围', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-tasks-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-08-04',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
  });
});
