import { describe, expect, it, vi } from 'vitest';

import {
  BarkChannel,
  createBarkChannelFromEnv,
} from '../../../src/adapters/notifications/bark.js';
import { sendNotification, type NotificationMessage } from '../../../src/core/notification-channel.js';

const message: NotificationMessage = {
  messageId: 'delivery-20260719-001',
  subject: '检测到可用号源',
  text: '北京同仁医院鼻科发现可预约号源',
  officialEntryUrl: 'https://www.example-hospital.cn/appoint?department=鼻科&session=上午',
  eventTags: ['availability_changed_to_available'],
  detectedAt: '2026-07-19T00:32:18.000Z',
};

describe('BarkChannel 通知契约', () => {
  it('通过 HTTPS Bark base URL 发送，并正确编码设备 key 与官方入口', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 200, id: 'bark-provider-42' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const channel = new BarkChannel({
      baseUrl: 'https://push.example.test/bark/',
      deviceKey: 'device/key +中文',
      fetch: fetchMock,
      timeoutMs: 100,
    });

    await expect(sendNotification(channel, message)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: 'bark-provider-42',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://push.example.test/bark/device%2Fkey%20%2B%E4%B8%AD%E6%96%87',
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      title: message.subject,
      body: message.text,
      url: message.officialEntryUrl,
      id: message.messageId,
    });
  });

  it('生产工厂从 env 创建 Bark channel，并默认使用官方 HTTPS base URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 200 }), { status: 200 }),
    );
    const channel = createBarkChannelFromEnv(
      { BARK_DEVICE_KEY: 'device/key', BARK_TIMEOUT_MS: '3210' },
      fetchMock,
    );

    expect(channel.enabled).toBe(true);
    await expect(channel.send(message)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: null,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.day.app/device%2Fkey');
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [429, true],
    [503, true],
  ])('将 Bark HTTP %i 分类为 retryable=%s', async (status, retryable) => {
    const channel = new BarkChannel({
      baseUrl: 'https://api.day.app',
      deviceKey: 'private-device-key',
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ code: status, message: 'provider rejected' }), { status }),
      ),
    });

    const result = await sendNotification(channel, message);

    expect(result).toEqual({
      status: 'rejected',
      errorCode: `BARK_HTTP_${status}`,
      retryable,
    });
    expect(JSON.stringify(result)).not.toContain('private-device-key');
  });

  it('超时会中止请求并标记送达状态未知', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(JSON.stringify({ code: 200 }), { status: 200 })),
            50,
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const channel = new BarkChannel({
      deviceKey: 'private-device-key',
      fetch: fetchMock,
      timeoutMs: 5,
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'unknown',
      errorCode: 'BARK_TIMEOUT',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('读取 Bark 响应体超时时也标记送达状态未知', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      ({
        ok: true,
        status: 200,
        json: async () =>
          await new Promise((resolve) =>
            setTimeout(() => resolve({ code: 200, id: 'late-provider-id' }), 50),
          ),
      }) as Response,
    );
    const channel = new BarkChannel({
      deviceKey: 'private-device-key',
      fetch: fetchMock,
      timeoutMs: 5,
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'unknown',
      errorCode: 'BARK_TIMEOUT',
    });
  });

  it('尊重调用方已中止的 AbortSignal，且不会发起请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>();
    const channel = new BarkChannel({ deviceKey: 'private-device-key', fetch: fetchMock });

    await expect(channel.send(message, controller.signal)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'ABORTED',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求开始后被调用方中止时返回送达状态未知', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    const channel = new BarkChannel({ deviceKey: 'private-device-key', fetch: fetchMock });

    const sending = channel.send(message, controller.signal);
    controller.abort();

    await expect(sending).resolves.toEqual({
      status: 'unknown',
      errorCode: 'BARK_ABORTED',
    });
  });

  it.each([
    ['ENOTFOUND', { status: 'rejected', errorCode: 'BARK_NETWORK', retryable: true }],
    ['ECONNREFUSED', { status: 'rejected', errorCode: 'BARK_NETWORK', retryable: true }],
    ['ECONNRESET', { status: 'unknown', errorCode: 'BARK_DELIVERY_UNKNOWN' }],
  ] as const)('安全分类 Bark 网络错误 %s', async (code, expected) => {
    const privateKey = 'private-device-key-do-not-leak';
    const error = Object.assign(new TypeError(`fetch failed for ${privateKey}`), {
      cause: { code },
    });
    const channel = new BarkChannel({
      deviceKey: privateKey,
      fetch: vi.fn<typeof fetch>(async () => {
        throw error;
      }),
    });

    const result = await channel.send(message);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it.each([
    [400, false],
    [429, true],
    [503, true],
  ])('将 HTTP 200 中的 Bark code %i 分类为 retryable=%s', async (code, retryable) => {
    const channel = new BarkChannel({
      deviceKey: 'private-device-key',
      fetch: vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ code, message: 'provider rejected' }), { status: 200 }),
      ),
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'rejected',
      errorCode: `BARK_CODE_${code}`,
      retryable,
    });
  });

  it('Bark 返回无法解析的成功响应时标记送达状态未知', async () => {
    const channel = new BarkChannel({
      deviceKey: 'private-device-key',
      fetch: vi.fn<typeof fetch>(async () => new Response('not-json', { status: 200 })),
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'unknown',
      errorCode: 'BARK_INVALID_RESPONSE',
    });
  });

  it.each([
    ['缺少设备 key', { baseUrl: 'https://api.day.app', deviceKey: '' }],
    ['使用非 HTTPS base URL', { baseUrl: 'http://api.day.app', deviceKey: 'secret-device-key' }],
    ['base URL 包含凭据', { baseUrl: 'https://user:pass@api.day.app', deviceKey: 'secret-device-key' }],
    ['base URL 包含 query', { baseUrl: 'https://api.day.app?token=secret', deviceKey: 'secret-device-key' }],
    ['base URL 包含 hash', { baseUrl: 'https://api.day.app#fragment', deviceKey: 'secret-device-key' }],
    ['超时配置无效', { baseUrl: 'https://api.day.app', deviceKey: 'secret-device-key', timeoutMs: Number.NaN }],
  ])('%s 时明确禁用且不会发送', async (_label, options) => {
    const fetchMock = vi.fn<typeof fetch>();
    const channel = new BarkChannel({ ...options, fetch: fetchMock });

    expect(channel.enabled).toBe(false);
    await expect(sendNotification(channel, message)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'CHANNEL_DISABLED',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await channel.send(message))).not.toContain('secret-device-key');
  });
});
