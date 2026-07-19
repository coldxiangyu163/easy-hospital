import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

const INTERNAL_MARKER = 'SECRET_MARKER_internal_detail_do_not_leak';

// 返回垃圾数据的 adapter：runSourceAdapter 内部 zod 校验抛错，驱动一次真实 5xx
const garbageAdapter: SourceAdapter = {
  manifest: {
    adapterKey: 'pumch-public-dermatology-schedule',
    contractVersion: 1,
    version: '1.0.0-test',
    accessClass: 'A',
    transport: 'fetch',
    allowedHosts: ['www.pumch.cn'],
    minIntervalMs: 300_000,
  },
  async check() {
    return { garbage: true, marker: INTERNAL_MARKER } as never;
  },
};

const validTaskPayload = {
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
};

describe('5xx 脱敏与 catalog 写入预校验', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('内部 5xx 统一返回 INTERNAL_ERROR，不泄露 code/message/内部细节', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-error-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [garbageAdapter],
      workerPollMs: 60_000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/pumch-public-dermatology-schedule/live-probe',
      headers: { host: '127.0.0.1' },
      payload: null,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'INTERNAL_ERROR' });
    expect(response.body).not.toMatch(
      /SECRET_MARKER|message|statusCode|SQLITE|zod|invalid_|\/Users\/|node_modules/i,
    );
  });

  it('watch-task 创建时非法 catalog 范围在写入前返回 400 稳定错误', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-error-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    for (const patch of [
      { hospitalId: 'hospital-ghost' },
      { campusId: 'campus-ghost' },
      { departmentId: 'department-ghost' },
      { campusId: 'campus-tongren-chongwenmen' }, // 跨医院 campus
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/watch-tasks',
        headers: { host: '127.0.0.1' },
        payload: { ...validTaskPayload, ...patch },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });
    }

    const tasks = await app.inject({
      method: 'GET',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
    });
    expect(tasks.json().tasks).toHaveLength(0);
  });

  it('watch-task PATCH 合并后非法 catalog 范围返回 400，合法 campusId=null 仍可用', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-error-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const created = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: { ...validTaskPayload, campusId: null },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${task.id}`,
      headers: { host: '127.0.0.1' },
      payload: { version: task.version, departmentId: 'department-ghost' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });

    const valid = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${task.id}`,
      headers: { host: '127.0.0.1' },
      payload: { version: task.version, campusId: null },
    });
    expect(valid.statusCode).toBe(200);
  });

  it('release-rule 写入前校验 catalog 范围，且先于 UNOFFICIAL_URL 报错', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-error-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const base = {
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      advanceDays: 7,
      releaseTimeLocal: '15:00',
      sameDayPolicy: '以官方页面为准',
      officialEntryUrl: 'https://www.pumch.cn/a.html',
      sourceUrl: 'https://www.pumch.cn/b.html',
      verifiedAt: '2026-07-19T01:00:00.000Z',
      confidence: 'high',
    };

    const ghostCampus = await app.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
      payload: { ...base, campusId: 'campus-ghost' },
    });
    expect(ghostCampus.statusCode).toBe(400);
    expect(ghostCampus.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });

    const ghostHospital = await app.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
      payload: { ...base, hospitalId: 'hospital-ghost' },
    });
    expect(ghostHospital.statusCode).toBe(400);
    expect(ghostHospital.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });

    const patchGhost = await app.inject({
      method: 'PATCH',
      url: '/api/release-rules/rule-tongren-rhinology-daily-1500',
      headers: { host: '127.0.0.1' },
      payload: { departmentId: 'department-ghost' },
    });
    expect(patchGhost.statusCode).toBe(400);
    expect(patchGhost.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });
  });
});
