import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server/app.js';

describe('HTTP /api loopback 边界', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('拒绝配置非回环监听地址', async () => {
    await expect(buildApp({ host: '0.0.0.0' })).rejects.toThrow(
      'RADAR_HOST 只允许 127.0.0.1',
    );
  });

  it('拒绝伪造为非本机地址的 Host', async () => {
    app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'LOCAL_ACCESS_ONLY',
      message: '此服务仅允许本机访问',
    });
  });
});
