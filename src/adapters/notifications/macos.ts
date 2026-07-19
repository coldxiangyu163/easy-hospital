import { execFile as nodeExecFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

import type {
  NotificationChannel,
  NotificationMessage,
  NotificationSendResult,
} from '../../core/notification-channel.js';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const APPLE_SCRIPT = `on run argv
  set subjectArgument to item 1 of argv
  set bodyArgument to item 2 of argv
  set notificationTitle to text 9 thru -1 of subjectArgument
  set notificationBody to text 6 thru -1 of bodyArgument
  display notification notificationBody with title notificationTitle
end run`;

export type MacOsNotificationExecOptions = {
  timeout: number;
  windowsHide: true;
  signal?: AbortSignal;
};

export type MacOsNotificationExecFile = (
  file: string,
  args: readonly string[],
  options: MacOsNotificationExecOptions,
) => Promise<void>;

export type MacOsNotificationChannelOptions = {
  platform?: NodeJS.Platform;
  isExecutable?: (file: string) => boolean;
  execFile?: MacOsNotificationExecFile;
  timeoutMs?: number;
};

const defaultIsExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultExecFile: MacOsNotificationExecFile = async (file, args, options) =>
  await new Promise<void>((resolve, reject) => {
    nodeExecFile(file, [...args], options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

type ExecErrorShape = { code?: unknown; killed?: unknown };

function classifyExecError(error: unknown): NotificationSendResult {
  const shape = error && typeof error === 'object' ? (error as ExecErrorShape) : {};
  const code = typeof shape.code === 'string' ? shape.code : undefined;

  if (shape.killed === true || code === 'ETIMEDOUT') {
    return { status: 'unknown', errorCode: 'MACOS_TIMEOUT' };
  }
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return {
      status: 'rejected',
      errorCode: 'MACOS_OSASCRIPT_UNAVAILABLE',
      retryable: false,
    };
  }
  if (code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE' || code === 'ENOMEM') {
    return { status: 'rejected', errorCode: 'MACOS_EXEC_TRANSIENT', retryable: true };
  }
  if (typeof shape.code === 'number') {
    return { status: 'rejected', errorCode: 'MACOS_OSASCRIPT_FAILED', retryable: false };
  }
  return { status: 'unknown', errorCode: 'MACOS_DELIVERY_UNKNOWN' };
}

export class MacOsNotificationChannel implements NotificationChannel {
  readonly key = 'macos';
  readonly enabled: boolean;
  readonly disabledReason: 'unsupported_platform' | 'osascript_unavailable' | null;

  readonly #execFile: MacOsNotificationExecFile;
  readonly #timeoutMs: number;

  constructor(options: MacOsNotificationChannelOptions = {}) {
    const platform = options.platform ?? process.platform;
    const isExecutable = options.isExecutable ?? defaultIsExecutable;
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#timeoutMs = options.timeoutMs ?? 10_000;

    let executable = false;
    if (platform === 'darwin') {
      try {
        executable = isExecutable(OSASCRIPT_PATH);
      } catch {
        executable = false;
      }
    }

    this.disabledReason =
      platform !== 'darwin'
        ? 'unsupported_platform'
        : executable
          ? null
          : 'osascript_unavailable';
    this.enabled = this.disabledReason === null;
  }

  async send(
    message: NotificationMessage,
    signal?: AbortSignal,
  ): Promise<NotificationSendResult> {
    if (!this.enabled) {
      return { status: 'rejected', errorCode: 'CHANNEL_DISABLED', retryable: false };
    }
    if (signal?.aborted) {
      return { status: 'rejected', errorCode: 'ABORTED', retryable: false };
    }

    try {
      await this.#execFile(
        OSASCRIPT_PATH,
        [
          '-e',
          APPLE_SCRIPT,
          `subject:${message.subject}`,
          `body:${message.text}\n\n${message.officialEntryUrl}`,
        ],
        { timeout: this.#timeoutMs, windowsHide: true, signal },
      );
      return { status: 'accepted', providerMessageId: null };
    } catch (error) {
      if (signal?.aborted) {
        return { status: 'unknown', errorCode: 'MACOS_ABORTED' };
      }
      return classifyExecError(error);
    }
  }
}
