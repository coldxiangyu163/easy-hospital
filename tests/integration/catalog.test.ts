import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('GET /api/catalog', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('首次启动 migration 后返回真实目标的 seed 目录', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-catalog-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      hospitals: [
        {
          id: 'hospital-pumch',
          name: '北京协和医院',
          campuses: [
            {
              id: 'campus-pumch-dongdan',
              name: '东单院区',
              departments: [{ id: 'department-pumch-dermatology', name: '皮肤科' }],
            },
          ],
        },
        {
          id: 'hospital-tongren',
          name: '北京同仁医院',
          campuses: [
            {
              id: 'campus-tongren-chongwenmen',
              name: '崇文门院区',
              departments: [{ id: 'department-tongren-rhinology', name: '鼻科' }],
            },
          ],
        },
      ],
    });
  });
});
