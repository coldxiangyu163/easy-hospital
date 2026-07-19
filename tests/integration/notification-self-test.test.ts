import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { NotificationChannel, NotificationMessage } from '../../src/core/notification-channel.js';
import { buildApp } from '../../src/server/app.js';

describe('通知渠道真实自检', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('通过 NotificationChannel 发送并持久化自检结果', async () => {
    const messages: NotificationMessage[] = [];
    const channel: NotificationChannel = {
      key: 'capture-test',
      async send(message) {
        messages.push(message);
        return { status: 'accepted', providerMessageId: 'self-test-provider' };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-self-test-'));
    const databasePath = join(directory, 'data.sqlite3');
    const options = {
      databasePath,
      notificationChannels: [channel],
      notificationChannelStatuses: [
        { key: 'capture-test', enabled: true, reason: null },
        { key: 'disabled-test', enabled: false, reason: 'missing_config' },
      ],
    };
    app = await buildApp(options);
    const headers = { host: '127.0.0.1' };

    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/capture-test/test',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      channel: 'capture-test',
      status: 'accepted',
      providerMessageId: 'self-test-provider',
      testedAt: expect.any(String),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ subject: '北京挂号雷达测试通知' });

    await app.close();
    app = await buildApp(options);
    const persisted = await app.inject({
      method: 'GET',
      url: '/api/notifications/capture-test/test-result',
      headers,
    });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toMatchObject({
      channel: 'capture-test',
      status: 'accepted',
      providerMessageId: 'self-test-provider',
    });

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/notifications/disabled-test/test',
      headers,
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({
      error: 'NOTIFICATION_CHANNEL_DISABLED',
      reason: 'missing_config',
    });
  });

  it('连续自检时每个响应都是本次发送自己的回执', async () => {
    let sequence = 0;
    const channel: NotificationChannel = {
      key: 'capture-sequence',
      async send() {
        sequence += 1;
        return { status: 'accepted', providerMessageId: `provider-${sequence}` };
      },
    };
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-self-test-seq-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      notificationChannels: [channel],
      notificationChannelStatuses: [{ key: 'capture-sequence', enabled: true, reason: null }],
    });
    const headers = { host: '127.0.0.1' };

    const first = await app.inject({
      method: 'POST',
      url: '/api/notifications/capture-sequence/test',
      headers,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/notifications/capture-sequence/test',
      headers,
    });
    expect(first.json()).toMatchObject({ providerMessageId: 'provider-1' });
    expect(second.json()).toMatchObject({ providerMessageId: 'provider-2' });
    expect(first.json().id).not.toBe(second.json().id);
  });
});
