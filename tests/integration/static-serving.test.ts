import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('生产静态资源与 SPA fallback', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('提供 dist/public 资源，并把非 /api GET 回退到 index.html', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-static-'));
    const publicDirectory = join(directory, 'public');
    await mkdir(join(publicDirectory, 'assets'), { recursive: true });
    await writeFile(join(publicDirectory, 'index.html'), '<html><body>easy-hospital</body></html>');
    await writeFile(join(publicDirectory, 'assets', 'app.js'), 'window.__APP__ = true;');
    app = await buildApp({ publicDirectory, serveStatic: true });
    const headers = { host: '127.0.0.1' };

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('window.__APP__');

    const spa = await app.inject({ method: 'GET', url: '/tasks/task-1', headers });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['content-type']).toContain('text/html');
    expect(spa.body).toContain('easy-hospital');

    const missingApi = await app.inject({ method: 'GET', url: '/api/missing', headers });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers['content-type']).toContain('application/json');
  });

  it('生产模式静态构建缺失时拒绝伪装成可运行', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-static-'));
    await expect(
      buildApp({ publicDirectory: join(directory, 'missing'), serveStatic: true }),
    ).rejects.toThrow('STATIC_PUBLIC_DIRECTORY_MISSING');
  });

  it('开发模式下静态目录不存在也能启动 API', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-static-'));
    app = await buildApp({ publicDirectory: join(directory, 'missing'), serveStatic: false });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1' },
    });
    expect(response.statusCode).toBe(200);
  });
});
