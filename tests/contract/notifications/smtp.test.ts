import { describe, expect, it, vi } from 'vitest';

import {
  createSmtpChannelFromEnv,
  SmtpChannel,
  type SmtpTransporter,
  type SmtpTransportFactory,
} from '../../../src/adapters/notifications/smtp.js';
import { sendNotification, type NotificationMessage } from '../../../src/core/notification-channel.js';

const message: NotificationMessage = {
  messageId: 'delivery-20260719-001',
  subject: '检测到可用号源',
  text: '北京同仁医院鼻科发现可预约号源',
  officialEntryUrl: 'https://www.example-hospital.cn/appoint?department=nose',
  eventTags: ['availability_changed_to_available'],
  detectedAt: '2026-07-19T00:32:18.000Z',
};

describe('SmtpChannel 通知契约', () => {
  it('使用注入的 nodemailer transporter 发送并返回 provider message ID', async () => {
    const sendMail = vi.fn(async () => ({
      messageId: '<provider-42@example.test>',
      accepted: ['recipient@example.test'],
      rejected: [],
      pending: [],
      response: '250 queued',
    }));
    const channel = new SmtpChannel({
      transporter: { sendMail } as SmtpTransporter,
      from: 'radar@example.test',
      to: 'recipient@example.test',
      timeoutMs: 100,
    });

    await expect(sendNotification(channel, message)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: '<provider-42@example.test>',
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: 'radar@example.test',
      to: 'recipient@example.test',
      subject: message.subject,
      text: `${message.text}\n\n官方入口：${message.officialEntryUrl}`,
    });
    expect(sendMail.mock.calls[0]?.[0].messageId).toMatch(
      /^<[a-f0-9]{64}@easy-hospital\.local>$/,
    );
  });

  it.each([
    [{ code: 'EAUTH' }, { status: 'rejected', errorCode: 'SMTP_AUTH', retryable: false }],
    [
      { code: 'EENVELOPE' },
      { status: 'rejected', errorCode: 'SMTP_MESSAGE_REJECTED', retryable: false },
    ],
    [
      { responseCode: 550 },
      { status: 'rejected', errorCode: 'SMTP_PERMANENT', retryable: false },
    ],
    [
      { responseCode: 450 },
      { status: 'rejected', errorCode: 'SMTP_TEMPORARY', retryable: true },
    ],
    [
      { code: 'ETIMEDOUT' },
      { status: 'rejected', errorCode: 'SMTP_NETWORK', retryable: true },
    ],
    [
      { code: 'ETIMEDOUT', command: 'DATA' },
      { status: 'unknown', errorCode: 'SMTP_DELIVERY_UNKNOWN' },
    ],
    [{ code: 'ECONNRESET' }, { status: 'unknown', errorCode: 'SMTP_DELIVERY_UNKNOWN' }],
  ] as const)('安全分类 SMTP 错误 %#', async (shape, expected) => {
    const password = 'smtp-password-do-not-leak';
    const sendMail = vi.fn(async () => {
      throw Object.assign(new Error(`SMTP failed with ${password}`), shape);
    });
    const channel = new SmtpChannel({
      transporter: { sendMail } as SmtpTransporter,
      from: 'radar@example.test',
      to: 'recipient@example.test',
    });

    const result = await channel.send(message);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it('生产工厂从 env 创建 nodemailer transporter', async () => {
    const sendMail = vi.fn(async () => ({
      messageId: '<env-provider@example.test>',
      accepted: ['recipient@example.test'],
      rejected: [],
    }));
    const createTransport = vi.fn<SmtpTransportFactory>(() => ({ sendMail } as SmtpTransporter));
    const channel = createSmtpChannelFromEnv(
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'local-user',
        SMTP_PASSWORD: 'smtp-password-do-not-log',
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
        SMTP_TIMEOUT_MS: '4321',
      },
      createTransport,
    );

    expect(channel.enabled).toBe(true);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'local-user', pass: 'smtp-password-do-not-log' },
      connectionTimeout: 4321,
      greetingTimeout: 4321,
      socketTimeout: 4321,
    });
    await expect(channel.send(message)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: '<env-provider@example.test>',
    });
  });

  it('secure=false 时强制 requireTLS，拒绝明文 SMTP 降级', () => {
    const createTransport = vi.fn<SmtpTransportFactory>(() => ({
      sendMail: vi.fn(),
    } as SmtpTransporter));

    const channel = createSmtpChannelFromEnv(
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        SMTP_USER: 'local-user',
        SMTP_PASSWORD: 'smtp-password-do-not-log',
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
      },
      createTransport,
    );

    expect(channel.enabled).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: false,
        requireTLS: true,
      }),
    );
  });

  it.each([
    ['缺少必填配置', {}],
    [
      '认证用户名缺少密码',
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
        SMTP_USER: 'local-user',
      },
    ],
    [
      '认证密码缺少用户名',
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
        SMTP_PASSWORD: 'private-password',
      },
    ],
    [
      '超时配置无效',
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
        SMTP_TIMEOUT_MS: 'invalid',
      },
    ],
    [
      'secure 配置无效',
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
        SMTP_SECURE: 'yes',
      },
    ],
  ])('env %s 时保持 disabled，且不创建 transporter', async (_label, env) => {
    const createTransport = vi.fn<SmtpTransportFactory>();

    const channel = createSmtpChannelFromEnv(env, createTransport);

    expect(channel.enabled).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
    await expect(channel.send(message)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'CHANNEL_DISABLED',
      retryable: false,
    });
  });

  it('创建 transporter 失败时安全禁用，不抛出包含密钥的错误', async () => {
    const password = 'smtp-password-do-not-leak';
    const createTransport = vi.fn<SmtpTransportFactory>(() => {
      throw new Error(`cannot create transporter with ${password}`);
    });

    const channel = createSmtpChannelFromEnv(
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_USER: 'local-user',
        SMTP_PASSWORD: password,
        SMTP_FROM: 'radar@example.test',
        SMTP_TO: 'recipient@example.test',
      },
      createTransport,
    );

    expect(channel.enabled).toBe(false);
    const result = await channel.send(message);
    expect(result).toEqual({
      status: 'rejected',
      errorCode: 'CHANNEL_DISABLED',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it('transporter 明确拒绝全部收件人时返回不可重试错误', async () => {
    const sendMail = vi.fn(async () => ({
      messageId: '<provider-42@example.test>',
      accepted: [],
      rejected: ['recipient@example.test'],
      pending: [],
      response: '550 mailbox unavailable',
    }));
    const channel = new SmtpChannel({
      transporter: { sendMail } as SmtpTransporter,
      from: 'radar@example.test',
      to: 'recipient@example.test',
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'SMTP_RECIPIENT_REJECTED',
      retryable: false,
    });
  });

  it('发送超时后标记送达状态未知', async () => {
    const sendMail = vi.fn(
      async () =>
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                messageId: '<late@example.test>',
                accepted: ['recipient@example.test'],
                rejected: [],
              }),
            50,
          ),
        ),
    );
    const channel = new SmtpChannel({
      transporter: { sendMail } as SmtpTransporter,
      from: 'radar@example.test',
      to: 'recipient@example.test',
      timeoutMs: 5,
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'unknown',
      errorCode: 'SMTP_TIMEOUT',
    });
  });

  it('尊重调用方已中止的 AbortSignal，且不会调用 transporter', async () => {
    const controller = new AbortController();
    controller.abort();
    const sendMail = vi.fn();
    const channel = new SmtpChannel({
      transporter: { sendMail } as SmtpTransporter,
      from: 'radar@example.test',
      to: 'recipient@example.test',
    });

    await expect(channel.send(message, controller.signal)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'ABORTED',
      retryable: false,
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('transporter 开始后被中止时标记送达状态未知', async () => {
    const controller = new AbortController();
    const sendMail = vi.fn(async () => await new Promise(() => undefined));
    const channel = new SmtpChannel({
      transporter: { sendMail } as SmtpTransporter,
      from: 'radar@example.test',
      to: 'recipient@example.test',
      timeoutMs: 50,
    });

    const sending = channel.send(message, controller.signal);
    controller.abort();

    await expect(sending).resolves.toEqual({
      status: 'unknown',
      errorCode: 'SMTP_ABORTED',
    });
  });

  it.each([
    ['transporter', { from: 'radar@example.test', to: 'recipient@example.test' }],
    ['from', { transporter: { sendMail: vi.fn() }, to: 'recipient@example.test' }],
    ['to', { transporter: { sendMail: vi.fn() }, from: 'radar@example.test' }],
  ])('缺少 %s 配置时明确禁用', async (_field, options) => {
    const channel = new SmtpChannel(options);

    expect(channel.enabled).toBe(false);
    await expect(sendNotification(channel, message)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'CHANNEL_DISABLED',
      retryable: false,
    });
  });
});
