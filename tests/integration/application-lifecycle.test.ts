import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startApplication,
  startApplicationFromEnvironment,
  type RunningApplication,
} from '../../src/server/runtime.js';

describe('应用启动与优雅退出', () => {
  let running: RunningApplication | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await running?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('在回环随机端口启动，退出后可用同一数据目录重新启动', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-'));
    const databasePath = join(directory, 'data.sqlite3');
    running = await startApplication({
      host: '127.0.0.1',
      port: 0,
      databasePath,
    });

    const response = await fetch(`${running.url}/api/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'healthy' });

    await running.close();
    running = await startApplication({
      host: '127.0.0.1',
      port: 0,
      databasePath,
    });
    expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
  });

  it('同一数据目录已有实例时拒绝第二次启动', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-'));
    const databasePath = join(directory, 'data.sqlite3');
    running = await startApplication({ host: '127.0.0.1', port: 0, databasePath });

    await expect(
      startApplication({ host: '127.0.0.1', port: 0, databasePath }),
    ).rejects.toThrow('数据目录已有 easy-hospital 实例运行');
  });

  it('SIGKILL 遗留锁在 owner PID 已死亡时回收', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-'));
    const databasePath = join(directory, 'data.sqlite3');
    const lockPath = `${databasePath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, startedAt: '2026-07-19T00:00:00.000Z' }),
    );

    running = await startApplication({ host: '127.0.0.1', port: 0, databasePath });
    expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
  });

  it('仍存活 PID 的锁继续拒绝第二实例', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-'));
    const databasePath = join(directory, 'data.sqlite3');
    const lockPath = `${databasePath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    await expect(
      startApplication({ host: '127.0.0.1', port: 0, databasePath }),
    ).rejects.toThrow('数据目录已有 easy-hospital 实例运行');
  });

  it('从环境配置固定回环监听与本地数据目录', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-runtime-'));
    running = await startApplicationFromEnvironment({
      EASY_HOSPITAL_HOST: '127.0.0.1',
      EASY_HOSPITAL_PORT: '0',
      EASY_HOSPITAL_DATA_DIR: directory,
    });

    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
  });
});
