import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';

describe('Browser Agent challenge proof', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('对受限 nonce 返回 HMAC-SHA256 配对证明且不回传 token', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-challenge-'));
    const token = 'paired-secret-must-not-leak';
    const nonce = 'AbCdEf0123456789_-nonce';
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: token,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/browser-agent/challenge?nonce=${nonce}`,
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      algorithm: 'HMAC-SHA256',
      nonce,
      proof: createHmac('sha256', token).update(nonce).digest('hex'),
    });
    expect(response.body).not.toContain(token);
  });

  it.each([
    ['过短', 'short'],
    ['过长', 'a'.repeat(129)],
    ['含空格', 'valid-length nonce'],
    ['含非 base64url 字符', 'valid-length-nonce!'],
  ])('拒绝%s nonce', async (_label, nonce) => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-challenge-'));
    app = await buildApp({
      databasePath: join(directory, 'data.sqlite3'),
      browserAgentToken: 'paired-secret',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/browser-agent/challenge?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
    app = undefined;
  });

  it('未配置配对 token 时不生成证明', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-agent-challenge-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'GET',
      url: '/api/browser-agent/challenge?nonce=AbCdEf0123456789',
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'BROWSER_AGENT_NOT_CONFIGURED' });
  });
});
