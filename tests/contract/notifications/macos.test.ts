import { describe, expect, it, vi } from 'vitest';

import {
  MacOsNotificationChannel,
  type MacOsNotificationExecFile,
} from '../../../src/adapters/notifications/macos.js';
import { sendNotification, type NotificationMessage } from '../../../src/core/notification-channel.js';

const message: NotificationMessage = {
  messageId: 'delivery-20260719-001',
  subject: '规则提醒',
  text: '北京同仁医院鼻科将在 5 分钟后放号',
  officialEntryUrl: 'https://www.example-hospital.cn/appoint?department=nose',
  eventTags: ['schedule_released'],
  detectedAt: '2026-07-19T00:32:18.000Z',
};

describe('MacOsNotificationChannel 通知契约', () => {
  it('在 darwin 且 osascript 可执行时通过固定程序和 argv 发送 Notification Center 通知', async () => {
    const execFile = vi.fn<MacOsNotificationExecFile>(async () => undefined);
    const isExecutable = vi.fn(() => true);
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable,
      execFile,
      timeoutMs: 100,
    });

    expect(channel.enabled).toBe(true);
    expect(isExecutable).toHaveBeenCalledWith('/usr/bin/osascript');
    await expect(sendNotification(channel, message)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: null,
    });
    expect(execFile).toHaveBeenCalledTimes(1);

    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe('/usr/bin/osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('display notification notificationBody with title notificationTitle');
    expect(args[1]).not.toContain(message.subject);
    expect(args[1]).not.toContain(message.text);
    expect(args).toContain(`subject:${message.subject}`);
    expect(args).toContain(`body:${message.text}\n\n${message.officialEntryUrl}`);
    expect(options).toMatchObject({ timeout: 100, windowsHide: true });
  });

  it('引号、换行和 AppleScript 文本只作为 argv 数据，不进入固定脚本或 shell', async () => {
    const hostileMessage: NotificationMessage = {
      ...message,
      subject: '-e\n规则提醒 "quoted"',
      text: '第一行\n第二行 " & do shell script "touch /tmp/injected" & "',
      officialEntryUrl: 'https://hospital.example.test/appoint?from="notification"',
    };
    const execFile = vi.fn<MacOsNotificationExecFile>(async () => undefined);
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => true,
      execFile,
    });

    await expect(channel.send(hostileMessage)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: null,
    });

    const [, args, options] = execFile.mock.calls[0]!;
    const script = args[1]!;
    const body = `${hostileMessage.text}\n\n${hostileMessage.officialEntryUrl}`;
    expect(args).toEqual([
      '-e',
      script,
      `subject:${hostileMessage.subject}`,
      `body:${body}`,
    ]);
    expect(script).not.toContain(hostileMessage.subject);
    expect(script).not.toContain(hostileMessage.text);
    expect(script).not.toContain(hostileMessage.officialEntryUrl);
    expect(script).not.toMatch(/do shell script|open location|open application/i);
    expect(args.filter((argument) => argument.includes(hostileMessage.officialEntryUrl))).toEqual([
      `body:${body}`,
    ]);
    expect(options).not.toHaveProperty('shell');
  });

  it('不会根据事件标签自行添加“有号”等文案，官方 URL 只追加到正文', async () => {
    const neutralMessage: NotificationMessage = {
      ...message,
      subject: '规则提醒',
      text: '请查看最新规则',
      eventTags: ['availability_changed_to_available'],
    };
    const execFile = vi.fn<MacOsNotificationExecFile>(async () => undefined);
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => true,
      execFile,
    });

    await channel.send(neutralMessage);

    const args = execFile.mock.calls[0]![1];
    expect(args[2]).toBe(`subject:${neutralMessage.subject}`);
    expect(args[3]).toBe(`body:${neutralMessage.text}\n\n${neutralMessage.officialEntryUrl}`);
    expect(args.join('\n')).not.toContain('有号');
  });

  it.each([
    ['linux', true, 'unsupported_platform'],
    ['win32', true, 'unsupported_platform'],
    ['darwin', false, 'osascript_unavailable'],
  ] as const)('platform=%s、executable=%s 时禁用：%s', async (platform, executable, reason) => {
    const isExecutable = vi.fn(() => executable);
    const execFile = vi.fn<MacOsNotificationExecFile>();
    const channel = new MacOsNotificationChannel({ platform, isExecutable, execFile });

    expect(channel.enabled).toBe(false);
    expect(channel.disabledReason).toBe(reason);
    if (platform === 'darwin') expect(isExecutable).toHaveBeenCalledWith('/usr/bin/osascript');
    else expect(isExecutable).not.toHaveBeenCalled();
    await expect(channel.send(message)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'CHANNEL_DISABLED',
      retryable: false,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('可执行检查抛错时安全禁用', () => {
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => {
        throw new Error('permission check failed');
      },
      execFile: vi.fn<MacOsNotificationExecFile>(),
    });

    expect(channel.enabled).toBe(false);
    expect(channel.disabledReason).toBe('osascript_unavailable');
  });

  it('调用前 AbortSignal 已中止时明确拒绝且不执行 osascript', async () => {
    const controller = new AbortController();
    controller.abort();
    const execFile = vi.fn<MacOsNotificationExecFile>();
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => true,
      execFile,
    });

    await expect(channel.send(message, controller.signal)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'ABORTED',
      retryable: false,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('execFile 启动后调用方中止时将送达状态标记为 unknown', async () => {
    const controller = new AbortController();
    const execFile = vi.fn<MacOsNotificationExecFile>(
      async (_file, _args, options) =>
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })),
            { once: true },
          );
        }),
    );
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => true,
      execFile,
    });

    const sending = channel.send(message, controller.signal);
    controller.abort();

    await expect(sending).resolves.toEqual({
      status: 'unknown',
      errorCode: 'MACOS_ABORTED',
    });
    expect(execFile.mock.calls[0]?.[2].signal).toBe(controller.signal);
  });

  it('execFile 超时被终止后将送达状态标记为 unknown', async () => {
    const execFile = vi.fn<MacOsNotificationExecFile>(async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    });
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => true,
      execFile,
      timeoutMs: 25,
    });

    await expect(channel.send(message)).resolves.toEqual({
      status: 'unknown',
      errorCode: 'MACOS_TIMEOUT',
    });
    expect(execFile.mock.calls[0]?.[2].timeout).toBe(25);
  });

  it.each([
    ['EAGAIN', { status: 'rejected', errorCode: 'MACOS_EXEC_TRANSIENT', retryable: true }],
    ['EMFILE', { status: 'rejected', errorCode: 'MACOS_EXEC_TRANSIENT', retryable: true }],
    ['ENFILE', { status: 'rejected', errorCode: 'MACOS_EXEC_TRANSIENT', retryable: true }],
    ['ENOMEM', { status: 'rejected', errorCode: 'MACOS_EXEC_TRANSIENT', retryable: true }],
    ['ENOENT', { status: 'rejected', errorCode: 'MACOS_OSASCRIPT_UNAVAILABLE', retryable: false }],
    ['EACCES', { status: 'rejected', errorCode: 'MACOS_OSASCRIPT_UNAVAILABLE', retryable: false }],
    ['EPERM', { status: 'rejected', errorCode: 'MACOS_OSASCRIPT_UNAVAILABLE', retryable: false }],
  ] as const)('将 execFile 错误 %s 分类为明确结果', async (code, expected) => {
    const execFile = vi.fn<MacOsNotificationExecFile>(async () => {
      throw Object.assign(new Error('exec failed'), { code });
    });
    const channel = new MacOsNotificationChannel({
      platform: 'darwin',
      isExecutable: () => true,
      execFile,
    });

    await expect(channel.send(message)).resolves.toEqual(expected);
  });

  it('AppleScript 明确失败时不可重试，无法分类时标记送达未知', async () => {
    const execute = async (error: unknown) => {
      const channel = new MacOsNotificationChannel({
        platform: 'darwin',
        isExecutable: () => true,
        execFile: async () => {
          throw error;
        },
      });
      return await channel.send(message);
    };

    await expect(execute(Object.assign(new Error('script failed'), { code: 1 }))).resolves.toEqual({
      status: 'rejected',
      errorCode: 'MACOS_OSASCRIPT_FAILED',
      retryable: false,
    });
    await expect(execute(new Error('unexpected'))).resolves.toEqual({
      status: 'unknown',
      errorCode: 'MACOS_DELIVERY_UNKNOWN',
    });
  });
});
