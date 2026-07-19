import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('ReleaseRule PATCH 官方 URL 边界', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('对现有规则与 patch 合并后重新校验全部官方 URL', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-security-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3210' };
    const id = 'rule-tongren-rhinology-daily-1500';

    const malicious = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${id}`,
      headers,
      payload: { officialEntryUrl: 'https://attacker.example/phishing' },
    });
    expect(malicious.statusCode).toBe(400);
    expect(malicious.json()).toEqual({ error: 'UNOFFICIAL_URL' });

    const rulesAfterReject = await app.inject({
      method: 'GET',
      url: '/api/release-rules',
      headers: { host: '127.0.0.1' },
    });
    expect(rulesAfterReject.json().rules).toContainEqual(
      expect.objectContaining({
        id,
        officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
      }),
    );
  });
});
