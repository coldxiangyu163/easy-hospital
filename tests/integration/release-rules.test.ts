import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('ReleaseRule HTTP /api seam', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('首次 migration seed 同仁鼻科可编辑的待核验真实规则', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rules-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'GET',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rules).toHaveLength(1);
    expect(response.json()).toMatchObject({
      rules: [
        expect.objectContaining({
          id: 'rule-tongren-rhinology-daily-1500',
          hospitalId: 'hospital-tongren',
          campusId: 'campus-tongren-chongwenmen',
          departmentId: 'department-tongren-rhinology',
          advanceDays: 7,
          releaseTimeLocal: '15:00',
          confidence: 'medium',
          needsReconfirmation: true,
          sourceUrl: 'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
        }),
      ],
    });
  });

  it('创建规则后可从列表读回规范化结果', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rules-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        advanceDays: 7,
        releaseTimeLocal: '07:00',
        sameDayPolicy: '以官方页面为准',
        officialEntryUrl: 'https://www.pumch.cn/',
        sourceUrl: 'https://www.pumch.cn/detail/appointment.html',
        verifiedAt: '2026-07-18T01:00:00.000Z',
        confidence: 'high',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created).toMatchObject({
      hospitalId: 'hospital-pumch',
      releaseTimeLocal: '07:00',
      confidence: 'high',
      enabled: true,
    });
    expect(created.id).toEqual(expect.any(String));

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().rules).toContainEqual(created);
  });

  it('可编辑并删除规则', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rules-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1' };
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/release-rules',
        headers,
        payload: {
          hospitalId: 'hospital-tongren',
          campusId: 'campus-tongren-chongwenmen',
          departmentId: 'department-tongren-rhinology',
          advanceDays: 7,
          releaseTimeLocal: '07:00',
          sameDayPolicy: '以官方页面为准',
          officialEntryUrl: 'https://www.trhos.com/',
          sourceUrl: 'https://www.trhos.com/',
          verifiedAt: '2026-07-18T01:00:00.000Z',
          confidence: 'high',
        },
      })
    ).json();

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${created.id}`,
      headers,
      payload: { advanceDays: 14, enabled: false },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      advanceDays: 14,
      enabled: false,
    });

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/release-rules/${created.id}`,
      headers,
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/release-rules',
      headers,
    });
    expect(listResponse.json().rules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
  });

  it('PATCH 未显式传 needsReconfirmation 时保留原值，显式传才可改写', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rules-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1' };

    // seed 的同仁规则 needsReconfirmation=true；只更新核验日期不得清除复核标记
    const patchVerified = await app.inject({
      method: 'PATCH',
      url: '/api/release-rules/rule-tongren-rhinology-daily-1500',
      headers,
      payload: { verifiedAt: '2026-07-19T05:00:00.000Z' },
    });
    expect(patchVerified.statusCode).toBe(200);
    expect(patchVerified.json()).toMatchObject({
      verifiedAt: '2026-07-19T05:00:00.000Z',
      needsReconfirmation: true,
    });

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/release-rules',
      headers,
    });
    expect(listAfter.json().rules).toContainEqual(
      expect.objectContaining({
        id: 'rule-tongren-rhinology-daily-1500',
        needsReconfirmation: true,
      }),
    );

    // 其他字段的 PATCH 同样不得顺带清除
    const patchPolicy = await app.inject({
      method: 'PATCH',
      url: '/api/release-rules/rule-tongren-rhinology-daily-1500',
      headers,
      payload: { sameDayPolicy: '复核后的新口径' },
    });
    expect(patchPolicy.statusCode).toBe(200);
    expect(patchPolicy.json()).toMatchObject({ needsReconfirmation: true });

    // 显式传值仍可正常改写
    const explicit = await app.inject({
      method: 'PATCH',
      url: '/api/release-rules/rule-tongren-rhinology-daily-1500',
      headers,
      payload: { needsReconfirmation: false },
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toMatchObject({ needsReconfirmation: false });
  });

  it('拒绝医院官方域名之外的规则入口', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rules-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        advanceDays: 7,
        releaseTimeLocal: '07:00',
        sameDayPolicy: '以官方页面为准',
        officialEntryUrl: 'https://evil.example/appointment',
        sourceUrl: 'https://evil.example/source',
        verifiedAt: '2026-07-18T01:00:00.000Z',
        confidence: 'high',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'UNOFFICIAL_URL' });
  });
});
