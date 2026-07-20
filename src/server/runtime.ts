import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { createBarkChannelFromEnv } from '../adapters/notifications/bark.js';
import { MacOsNotificationChannel } from '../adapters/notifications/macos.js';
import { createSmtpChannelFromEnv } from '../adapters/notifications/smtp.js';
import { createPumchDermatologyScheduleAdapter } from '../adapters/sources/pumch.js';
import { loadRuntimeConfig } from '../core/config.js';
import type { NotificationChannel } from '../core/notification-channel.js';
import {
  acquireDatabaseLock,
  type DatabaseLock,
  DatabaseLockUnavailableError,
} from '../storage/database-lock.js';
import {
  buildApp,
  type BuildAppOptions,
  type NotificationChannelStatus,
} from './app.js';

export type StartApplicationOptions = BuildAppOptions & {
  port?: number;
};

export type RunningApplication = {
  url: string;
  close(): Promise<void>;
};

// 收紧本机秘密文件权限；跨平台容错：不支持 POSIX 权限位的平台返回 false 而不中断启动。
export async function restrictPathPermissions(path: string, mode: number): Promise<boolean> {
  try {
    await chmod(path, mode);
    return true;
  } catch {
    return false;
  }
}

export async function startApplicationFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): Promise<RunningApplication> {
  const config = loadRuntimeConfig(env);
  await mkdir(config.dataDirectory, { recursive: true });
  await restrictPathPermissions(config.dataDirectory, 0o700);
  if (env.NODE_ENV === 'production') {
    const envFile = resolve(process.cwd(), '.env');
    if (existsSync(envFile)) await restrictPathPermissions(envFile, 0o600);
  }

  const candidates = [
    new MacOsNotificationChannel(),
    createBarkChannelFromEnv(env),
    createSmtpChannelFromEnv(env),
  ];
  const statuses: NotificationChannelStatus[] = candidates.map((channel) => ({
    key: channel.key,
    enabled: channel.enabled,
    reason: channel.disabledReason,
  }));
  const enabledChannels = candidates.filter(
    (channel): channel is typeof channel & NotificationChannel => channel.enabled,
  );
  const browserAgentToken = env.EASY_HOSPITAL_BROWSER_AGENT_TOKEN?.trim() || undefined;
  if (browserAgentToken && Buffer.byteLength(browserAgentToken, 'utf8') < 32) {
    throw new Error('EASY_HOSPITAL_BROWSER_AGENT_TOKEN 至少需要 32 字节随机值');
  }
  const sourceAdapters =
    env.EASY_HOSPITAL_DISABLE_LIVE_SOURCES === '1'
      ? []
      : [createPumchDermatologyScheduleAdapter()];

  return startApplication({
    ...config,
    sourceAdapters,
    notificationChannels: enabledChannels,
    notificationChannelStatuses: statuses,
    browserAgentToken,
    serveStatic: env.NODE_ENV === 'production',
  });
}

export async function startApplication(
  options: StartApplicationOptions = {},
): Promise<RunningApplication> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3210;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('RADAR_PORT 必须是有效端口');
  }

  let databaseLock: DatabaseLock | undefined;
  if (options.databasePath) {
    try {
      databaseLock = acquireDatabaseLock(options.databasePath);
    } catch (error) {
      if (error instanceof DatabaseLockUnavailableError) {
        throw new Error('数据目录已有 easy-hospital 实例运行', { cause: error });
      }
      throw error;
    }
  }

  try {
    const app = await buildApp(options);
    await app.listen({ host, port });
    const address = app.server.address() as AddressInfo;
    let closed = false;

    return {
      url: `http://${host}:${address.port}`,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await app.close();
        } finally {
          databaseLock?.release();
        }
      },
    };
  } catch (error) {
    databaseLock?.release();
    throw error;
  }
}
