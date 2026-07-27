import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pumchDermatologyScheduleManifest } from '../../src/adapters/sources/pumch.js';
import type { NotificationChannel } from '../../src/core/notification-channel.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import { buildApp } from '../../src/server/app.js';

describe('写 API Origin 边界', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('外部 http(s) Origin 无法触发通知自检或 live probe 副作用', async () => {
    const send = vi.fn<NotificationChannel['send']>(async () => ({
      status: 'accepted',
      providerMessageId: 'provider-id',
    }));
    const check = vi.fn<SourceAdapter['check']>(async () => ({
      status: 'OK',
      observedAt: '2026-07-19T00:00:00.000Z',
      nextAllowedAt: null,
      contentHash: 'a'.repeat(64),
      observations: [],
    }));
    const channel: NotificationChannel = { key: 'origin-capture', send };
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn'],
        minIntervalMs: 300_000,
      },
      check,
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-origin-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      notificationChannelStatuses: [{ key: channel.key, enabled: true, reason: null }],
      sourceAdapters: [adapter],
    });
    const headers = { host: '127.0.0.1', origin: 'https://attacker.example' };

    const notification = await app.inject({
      method: 'POST',
      url: `/api/notifications/${channel.key}/test`,
      headers,
    });
    const liveProbe = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/pumch-public-dermatology-schedule/live-probe',
      headers,
    });

    expect(notification.statusCode).toBe(403);
    expect(liveProbe.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    const persisted = await app.inject({
      method: 'GET',
      url: `/api/notifications/${channel.key}/test-result`,
      headers: { host: '127.0.0.1' },
    });
    expect(persisted.statusCode).toBe(404);
  });

  it('带 Origin 的管理写请求只接受 loopback origin', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-origin-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [
        {
          manifest: pumchDermatologyScheduleManifest,
          async check() {
            throw new Error('Origin seam 测试不应运行来源请求');
          },
        },
      ],
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
      dateTo: '2026-07-20',
      session: 'AM',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: 5,
    };

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1', origin: 'http://attacker.example' },
      payload,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: {
        host: '127.0.0.1',
        origin: 'http://localhost:5173',
        'x-easy-hospital-client': 'web',
      },
      payload,
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(201);
    const tasks = await app.inject({
      method: 'GET',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
    });
    expect(tasks.json().tasks).toHaveLength(1);
  });

  it('浏览器简单请求（loopback Origin、无 client 头）写请求一律 403 且无副作用', async () => {
    const send = vi.fn<NotificationChannel['send']>(async () => ({
      status: 'accepted',
      providerMessageId: 'provider-id',
    }));
    const check = vi.fn<SourceAdapter['check']>(async () => ({
      status: 'OK',
      observedAt: '2026-07-19T00:00:00.000Z',
      nextAllowedAt: null,
      contentHash: 'a'.repeat(64),
      observations: [],
    }));
    const channel: NotificationChannel = { key: 'csrf-capture', send };
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'pumch-public-dermatology-schedule',
        contractVersion: 1,
        version: '1.0.0-test',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['www.pumch.cn'],
        minIntervalMs: 300_000,
      },
      check,
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-csrf-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      notificationChannelStatuses: [{ key: channel.key, enabled: true, reason: null }],
      sourceAdapters: [adapter],
    });
    // 简单请求特征：无自定义头、无 body 或 text/plain，浏览器必然带 Origin
    const headers = { host: '127.0.0.1', origin: 'http://localhost:3000' };

    const notification = await app.inject({
      method: 'POST',
      url: `/api/notifications/${channel.key}/test`,
      headers,
    });
    const liveProbe = await app.inject({
      method: 'POST',
      url: '/api/source-adapters/pumch-public-dermatology-schedule/live-probe',
      headers,
    });
    const createTask = await app.inject({
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
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });

    for (const response of [notification, liveProbe, createTask]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'CLIENT_HEADER_REQUIRED',
        message: '带 Origin 的写请求必须携带 x-easy-hospital-client: web',
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    const tasks = await app.inject({
      method: 'GET',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
    });
    expect(tasks.json().tasks).toHaveLength(0);
  });

  it('携带 x-easy-hospital-client: web 的 loopback Origin 无 body 写请求正常工作', async () => {
    const send = vi.fn<NotificationChannel['send']>(async () => ({
      status: 'accepted',
      providerMessageId: 'provider-id',
    }));
    const channel: NotificationChannel = { key: 'csrf-ok', send };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-csrf-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      notificationChannelStatuses: [{ key: channel.key, enabled: true, reason: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/notifications/${channel.key}/test`,
      headers: {
        host: '127.0.0.1',
        origin: 'http://localhost:3000',
        'x-easy-hospital-client': 'web',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('Browser Agent observation 豁免 client 头，仍由 Bearer + 扩展 Origin 把关', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-csrf-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: 'a'.repeat(32),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/browser-agent/observations',
      headers: {
        host: '127.0.0.1',
        origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'content-type': 'application/json',
      },
      payload: {},
    });
    // 未被 client 头规则拦截（403 CLIENT_HEADER_REQUIRED），而是走到既有 Bearer 校验
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'BROWSER_AGENT_UNAUTHORIZED' });
  });
});
