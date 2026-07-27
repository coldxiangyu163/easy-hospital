import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { anzhenHeartCenterScheduleManifest } from '../../src/adapters/sources/anzhen.js';
import { pumchDermatologyScheduleManifest } from '../../src/adapters/sources/pumch.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';
import { openDatabase } from '../../src/storage/database.js';

const manifestOnlyAdapter = (manifest: SourceAdapter['manifest']): SourceAdapter => ({
  manifest,
  async check() {
    throw new Error('准入测试不应运行来源请求');
  },
});

const wrongTargetPumchManifest: SourceAdapter['manifest'] = {
  ...pumchDermatologyScheduleManifest,
  bindings: pumchDermatologyScheduleManifest.bindings.map((binding) => ({
    ...binding,
    targetId: 'target-wrong-pumch-dermatology',
  })),
};

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
        session: 'ANY',
        eventTypes: ['schedule_released'],
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
      session: 'ANY',
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

  it('public-source 没有当前 runtime 精确 binding 时拒绝创建且不持久化', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-binding-required-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-27',
        dateTo: '2026-08-02',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: null,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'SOURCE_BINDING_NOT_AVAILABLE' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/watch-tasks',
          headers: { host: '127.0.0.1' },
        })
      ).json().tasks,
    ).toEqual([]);
  });

  it('public-source manifest 物理 scope 相同但 targetId 错误时 POST 拒绝且不持久化', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-target-binding-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [manifestOnlyAdapter(wrongTargetPumchManifest)],
      workerPollMs: 60_000,
    });
    const headers = { host: '127.0.0.1' };
    const response = await app.inject({
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
        dateFrom: '2026-07-27',
        dateTo: '2026-08-02',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: null,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'SOURCE_BINDING_NOT_AVAILABLE' });
    expect(
      (await app.inject({ method: 'GET', url: '/api/watch-tasks', headers })).json().tasks,
    ).toEqual([]);
  });

  it('public-source targetId 失配时 PATCH 原子拒绝并保留原任务', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-target-patch-'));
    const databasePath = join(directory, 'data.sqlite3');
    const headers = { host: '127.0.0.1' };
    app = await buildApp({
      databasePath,
      sourceAdapters: [manifestOnlyAdapter(pumchDermatologyScheduleManifest)],
      workerPollMs: 60_000,
    });
    const created = await app.inject({
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
        dateFrom: '2026-07-27',
        dateTo: '2026-08-02',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: null,
      },
    });
    expect(created.statusCode).toBe(201);
    await app.close();
    app = await buildApp({
      databasePath,
      sourceAdapters: [manifestOnlyAdapter(wrongTargetPumchManifest)],
      workerPollMs: 60_000,
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${created.json().id}`,
      headers,
      payload: { version: created.json().version, session: 'PM' },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toEqual({ error: 'SOURCE_BINDING_NOT_AVAILABLE' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/watch-tasks/${created.json().id}`,
          headers,
        })
      ).json(),
    ).toMatchObject({ session: 'ANY', enabled: true, version: 1 });
  });

  it('enabled public-source 创建与 PATCH 均要求具体院区，拒绝后保持原任务', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-campus-required-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [manifestOnlyAdapter(pumchDermatologyScheduleManifest)],
      workerPollMs: 60_000,
    });
    const headers = { host: '127.0.0.1' };
    const payload = {
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      dateFrom: '2026-07-27',
      dateTo: '2026-08-02',
      session: 'ANY',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: null,
    };

    const missingCampus = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: { ...payload, campusId: null },
    });
    expect(missingCampus.statusCode).toBe(400);
    expect(missingCampus.json()).toEqual({ error: 'WATCH_TASK_CAMPUS_REQUIRED' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    const rejectedPatch = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${created.json().id}`,
      headers,
      payload: { version: created.json().version, campusId: null },
    });
    expect(rejectedPatch.statusCode).toBe(400);
    expect(rejectedPatch.json()).toEqual({ error: 'WATCH_TASK_CAMPUS_REQUIRED' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/watch-tasks/${created.json().id}`,
          headers,
        })
      ).json(),
    ).toMatchObject({ campusId: 'campus-pumch-dongdan', enabled: true, version: 1 });
  });

  it('rules-only 规则停用后拒绝新任务且不持久化', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-rule-required-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1' };
    const disabled = await app.inject({
      method: 'PATCH',
      url: '/api/release-rules/rule-tongren-rhinology-daily-1500',
      headers,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    const response = await app.inject({
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
        dateFrom: '2026-07-27',
        dateTo: '2026-08-02',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'RELEASE_RULE_NOT_AVAILABLE' });
    expect(
      (await app.inject({ method: 'GET', url: '/api/watch-tasks', headers })).json().tasks,
    ).toEqual([]);
  });

  it('rules-only 规则删除后拒绝重新启用已有任务并保留禁用版本', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-rule-reenable-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1' };
    const created = await app.inject({
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
        dateFrom: '2026-07-27',
        dateTo: '2026-08-02',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${created.json().id}`,
      headers,
      payload: { version: created.json().version, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/release-rules/rule-tongren-rhinology-daily-1500',
          headers,
        })
      ).statusCode,
    ).toBe(204);

    const reenabled = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${created.json().id}`,
      headers,
      payload: { version: disabled.json().version, enabled: true },
    });
    expect(reenabled.statusCode).toBe(400);
    expect(reenabled.json()).toEqual({ error: 'RELEASE_RULE_NOT_AVAILABLE' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/watch-tasks/${created.json().id}`,
          headers,
        })
      ).json(),
    ).toMatchObject({ enabled: false, version: disabled.json().version });
  });

  it('Browser Agent B 级事件只授予精确 allowlist scope，不扩散到安贞', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-browser-scope-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [
        manifestOnlyAdapter(pumchDermatologyScheduleManifest),
        manifestOnlyAdapter(anzhenHeartCenterScheduleManifest),
      ],
      browserAgentToken: 'browser-agent-token',
      workerPollMs: 60_000,
    });
    const headers = { host: '127.0.0.1' };
    const base = {
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      dateFrom: '2026-07-27',
      dateTo: '2026-08-02',
      session: 'ANY',
      eventTypes: ['availability_changed_to_available', 'cancellation_slot_detected'],
      remindBeforeMinutes: null,
    };

    const pumch = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        ...base,
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
      },
    });
    expect(pumch.statusCode).toBe(201);

    const anzhen = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: {
        ...base,
        hospitalId: 'hospital-anzhen',
        campusId: 'campus-anzhen-chaoyang',
        departmentId: 'department-anzhen-coronary-heart-disease-center',
      },
    });
    expect(anzhen.statusCode).toBe(400);
    expect(anzhen.json()).toEqual({ error: 'SOURCE_EVENT_TYPE_NOT_AVAILABLE' });
  });

  it('同仁 C 级 API 拒绝医生、时段与实时号源事件条件', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-policy-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      enforceWatchTaskPolicy: true,
    });
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
        dateTo: '2026-07-26',
        session: 'AM',
        eventTypes: ['schedule_released', 'availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'SOURCE_POLICY_VIOLATION' });
  });

  it('C 级限制由目标 supportMode 驱动，不依赖同仁医院 ID', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-policy-generic-'));
    const databasePath = join(directory, 'data.sqlite3');
    const database = openDatabase(databasePath);
    database
      .prepare(
        "UPDATE department SET support_mode = 'rules-only' WHERE id = 'department-pumch-dermatology'",
      )
      .run();
    database.close();
    app = await buildApp({ databasePath, enforceWatchTaskPolicy: true });

    const response = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'doctor',
        doctorName: '测试医生',
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'AM',
        eventTypes: ['availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'SOURCE_POLICY_VIOLATION' });
  });

  it('scope 从 department→campus→hospital 推导并拒绝跨院组合', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-derived-scope-'));
    const databasePath = join(directory, 'data.sqlite3');
    const database = openDatabase(databasePath);
    database
      .prepare(
        "UPDATE department SET hospital_id = 'hospital-tongren' WHERE id = 'department-pumch-dermatology'",
      )
      .run();
    database.close();
    app = await buildApp({
      databasePath,
      sourceAdapters: [manifestOnlyAdapter(pumchDermatologyScheduleManifest)],
      workerPollMs: 60_000,
    });
    const payload = {
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      session: 'ANY',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: 5,
    };

    const derived = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload,
    });
    expect(derived.statusCode).toBe(201);

    const crossHospital = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: { ...payload, hospitalId: 'hospital-tongren' },
    });
    expect(crossHospital.statusCode).toBe(400);
    expect(crossHospital.json()).toEqual({ error: 'CATALOG_SCOPE_NOT_FOUND' });
  });

  it('仅目录目标拒绝创建不会运行的假任务', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-directory-task-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      enforceWatchTaskPolicy: true,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pkuph',
        campusId: 'campus-pkuph-xizhimen',
        departmentId: 'department-pkuph-hematology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'SOURCE_POLICY_VIOLATION' });
  });

  it('按版本编辑、读取并软删除关注任务', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-tasks-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [manifestOnlyAdapter(pumchDermatologyScheduleManifest)],
      workerPollMs: 60_000,
    });
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
          eventTypes: ['schedule_released'],
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

  it('生产日期窗口拒绝过去日期与北京时间今天加 14 天以外的创建和编辑', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-task-window-'));
    const now = Date.parse('2026-07-19T00:00:00.000Z');
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      now: () => now,
      enforceTaskDateWindow: true,
      sourceAdapters: [manifestOnlyAdapter(pumchDermatologyScheduleManifest)],
      workerPollMs: 60_000,
    });
    const headers = { host: '127.0.0.1' };
    const base = {
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      session: 'ANY',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: null,
    };

    const past = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: { ...base, dateFrom: '2026-07-18', dateTo: '2026-07-20' },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ error: 'VALIDATION_ERROR' });

    const tooFar = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: { ...base, dateFrom: '2026-07-29', dateTo: '2026-08-03' },
    });
    expect(tooFar.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers,
      payload: { ...base, dateFrom: '2026-07-20', dateTo: '2026-07-26' },
    });
    expect(valid.statusCode).toBe(201);

    const invalidPatch = await app.inject({
      method: 'PATCH',
      url: `/api/watch-tasks/${valid.json().id}`,
      headers,
      payload: { version: valid.json().version, dateFrom: '2026-07-29', dateTo: '2026-08-03' },
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
  });
});
