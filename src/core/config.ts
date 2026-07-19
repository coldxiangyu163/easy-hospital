import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const hostSchema = z.literal('127.0.0.1');
const portSchema = z.coerce.number().int().min(0).max(65_535);
const timezoneSchema = z.literal('Asia/Shanghai');

export type RuntimeConfig = {
  host: '127.0.0.1';
  port: number;
  timezone: 'Asia/Shanghai';
  dataDirectory: string;
  databasePath: string;
};

function defaultDataDirectory(env: Record<string, string | undefined>): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'easy-hospital');
  }
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? homedir(), 'easy-hospital');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'easy-hospital');
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  // RADAR_* 是公开配置的规范前缀；EASY_HOSPITAL_* 只作为旧版本兼容别名。
  const host = hostSchema.parse(env.RADAR_HOST ?? env.EASY_HOSPITAL_HOST ?? '127.0.0.1');
  const port = portSchema.parse(env.RADAR_PORT ?? env.EASY_HOSPITAL_PORT ?? '3210');
  const timezone = timezoneSchema.parse(env.RADAR_TIMEZONE ?? 'Asia/Shanghai');
  const dataDirectory =
    env.RADAR_DATA_DIR ??
    env.EASY_HOSPITAL_DATA_DIR ??
    defaultDataDirectory(env);
  if (!dataDirectory.trim()) throw new Error('RADAR_DATA_DIR 不能为空');

  return {
    host,
    port,
    timezone,
    dataDirectory,
    databasePath: join(dataDirectory, 'data.sqlite3'),
  };
}
