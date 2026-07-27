import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { pumchDermatologyScheduleManifest } from '../../src/adapters/sources/pumch.js';
import type { NotificationChannel, NotificationMessage } from '../../src/core/notification-channel.js';
import type { SourceAdapter } from '../../src/core/source-adapter.js';
import {
  buildApp as buildBaseApp,
  type BuildAppOptions,
} from '../../src/server/app.js';

const pumchAdmissionAdapter: SourceAdapter = {
  manifest: pumchDermatologyScheduleManifest,
  async check() {
    throw new Error('通知 seam 测试不应运行准入 Adapter');
  },
};

const buildApp = (options: BuildAppOptions) =>
  buildBaseApp({
    ...options,
    sourceAdapters: [...(options.sourceAdapters ?? []), pumchAdmissionAdapter],
    browserAgentToken: 'notification-delivery-browser-agent-token',
  });

describe('Outbox 到 NotificationChannel 的纵向切片', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('冷却结束后投递包含首项与项数的聚合通知 golden', async () => {
    const now = Date.parse('2026-07-19T00:15:00.000Z');
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-notification',
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
          observedAt: new Date(available ? now - 5 * 60_000 : now - 10 * 60_000).toISOString(),
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(`notify-${attempt}`).digest('hex'),
          observations: [
            {
              slotKey: 'slot-notification',
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
    const received: NotificationMessage[] = [];
    const channel: NotificationChannel = {
      key: 'capture',
      async send(message) {
        received.push(message);
        return { status: 'accepted', providerMessageId: 'provider-1' };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-delivery-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
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
      requestId: 'delivery-1',
      sourceId: 'source-notification',
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: new Date(now + 60_000).toISOString(),
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-notification',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-notification',
      headers,
      payload: { ...payload, requestId: 'delivery-2' },
    });

    await expect.poll(() => received.length, { timeout: 1_000 }).toBe(1);
    expect(received[0]).toEqual({
      messageId: expect.any(String),
      subject: '疑似退号回流',
      text: [
        '北京同仁医院 · 崇文门院区 · 鼻科',
        '检测到疑似退号回流，请以官方渠道实时状态为准。',
        '首项：就诊日期 2026-07-20 · 上午 · 示例医生 · 主任医师',
        '检测时间（北京时间）：2026-07-19 08:10:00',
        '证据：包含状态推断；来源：医院官方公开来源',
        '本批次共 2 项',
        '本工具不代替人工预约，请前往官方渠道自行确认并完成预约。',
      ].join('\n'),
      officialEntryUrl: 'https://hospital.example/appointment',
      eventTags: [
        'availability_changed_to_available',
        'cancellation_slot_detected',
      ],
      detectedAt: '2026-07-19T00:10:00.000Z',
    });

    const batches = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ state: 'sent' });
  });

  it('公开排班通知正文包含首项上下文、北京时间、证据来源与批次项数', async () => {
    const now = Date.parse('2026-07-19T00:10:00.000Z');
    let attempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-schedule-copy',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        attempt += 1;
        return {
          status: 'OK',
          observedAt: new Date(now - 5 * 60_000).toISOString(),
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(`schedule-copy-${attempt}`).digest('hex'),
          observations:
            attempt === 1
              ? []
              : [
                  {
                    slotKey: 'schedule-copy-slot',
                    hospitalId: 'hospital-pumch',
                    campusId: 'campus-pumch-dongdan',
                    departmentId: 'department-pumch-dermatology',
                    date: '2026-07-20',
                    session: 'AM' as const,
                    doctorName: '示例医生',
                    title: '主任医师',
                    scheduleStatus: 'present' as const,
                    availability: 'unknown' as const,
                    officialEntryUrl: 'https://hospital.example/appointment',
                    evidence: 'explicit' as const,
                  },
                ],
        };
      },
    };
    const received: NotificationMessage[] = [];
    const channel: NotificationChannel = {
      key: 'capture-schedule',
      async send(message) {
        received.push(message);
        return { status: 'accepted', providerMessageId: 'schedule-provider' };
      },
    };

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-delivery-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
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
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'schedule-copy-1',
      sourceId: 'source-schedule-copy',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: new Date(now + 60_000).toISOString(),
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-schedule-copy',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-schedule-copy',
      headers,
      payload: { ...payload, requestId: 'schedule-copy-2' },
    });

    await expect.poll(() => received.length, { timeout: 1_000 }).toBe(1);
    expect(received[0]).toEqual({
      messageId: expect.any(String),
      subject: '新排班已发布',
      text: [
        '北京协和医院 · 东单院区 · 皮肤科',
        '检测到新的公开排班；排班信息不代表可预约状态。',
        '首项：就诊日期 2026-07-20 · 上午 · 示例医生 · 主任医师',
        '检测时间（北京时间）：2026-07-19 08:05:00',
        '证据：官方来源明确观测；来源：医院官方公开来源',
        '本批次共 1 项',
        '本工具不代替人工预约，请前往官方渠道自行确认并完成预约。',
      ].join('\n'),
      officialEntryUrl: 'https://hospital.example/appointment',
      eventTags: ['schedule_released'],
      detectedAt: '2026-07-19T00:05:00.000Z',
    });
    expect(received[0]?.text).not.toContain('可用号源');
  });

  it('C 级规则提醒使用放号前文案，不声称排班或可用号源', async () => {
    let now = Date.parse('2026-07-19T00:00:00.000Z');
    const reminderAt = Date.parse('2026-07-19T06:55:00.000Z');
    const received: NotificationMessage[] = [];
    const channel: NotificationChannel = {
      key: 'capture-rule-reminder',
      async send(message) {
        received.push(message);
        return { status: 'accepted', providerMessageId: 'rule-reminder-provider' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-delivery-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      workerPollMs: 5,
      now: () => now,
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
        dateFrom: '2026-07-26',
        dateTo: '2026-07-26',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });

    now = reminderAt;
    await expect.poll(() => received.length, { timeout: 1_000 }).toBe(1);
    expect(received[0]).toMatchObject({
      subject: '放号前规则提醒',
      officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
    });
    expect(received[0]?.text).toContain('15:00');
    expect(received[0]?.text).toContain('需要重新核验');
    expect(received[0]?.text).not.toContain('可用号源');
    expect(received[0]?.text).not.toContain('排班已发布');
  });

  it('多渠道聚合状态与完成顺序无关，读模型暴露每渠道终态', async () => {
    const now = Date.now();
    let sourceAttempt = 0;
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-multi-channel',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        sourceAttempt += 1;
        const available = sourceAttempt > 1;
        return {
          status: 'OK',
          observedAt: new Date(available ? now - 5 * 60_000 : now - 10 * 60_000).toISOString(),
          nextAllowedAt: null,
          contentHash: createHash('sha256').update(`multi-${sourceAttempt}`).digest('hex'),
          observations: [
            {
              slotKey: 'multi-slot',
              hospitalId: 'hospital-pumch',
              campusId: 'campus-pumch-dongdan',
              departmentId: 'department-pumch-dermatology',
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
    let deliveryOrder = 0;
    const makeChannel = (key: string): NotificationChannel => ({
      key,
      async send() {
        deliveryOrder += 1;
        return deliveryOrder === 1
          ? { status: 'unknown', errorCode: 'DELIVERY_AMBIGUOUS' }
          : { status: 'accepted', providerMessageId: `${key}-accepted` };
      },
    });

    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-multi-channel-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      sourceAdapters: [adapter],
      notificationChannels: [makeChannel('channel-a'), makeChannel('channel-b')],
      workerPollMs: 5,
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
        dateTo: '2026-07-20',
        session: 'AM',
        eventTypes: ['availability_changed_to_available'],
        remindBeforeMinutes: 5,
      },
    });
    const payload = {
      requestId: 'multi-1',
      sourceId: 'source-multi',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-20',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: new Date(now + 60_000).toISOString(),
    };
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-multi-channel',
      headers,
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/source-checks/fixture-multi-channel',
      headers,
      payload: { ...payload, requestId: 'multi-2' },
    });

    await expect.poll(() => deliveryOrder, { timeout: 1_000 }).toBe(2);
    const batch = (
      await app.inject({ method: 'GET', url: '/api/notification-batches', headers })
    ).json().batches[0];
    expect(batch).toMatchObject({
      state: 'delivery_unknown',
      deliveries: expect.arrayContaining([
        expect.objectContaining({ state: 'delivery_unknown', attempts: 1 }),
        expect.objectContaining({ state: 'sent', attempts: 1 }),
      ]),
    });
  });
});
