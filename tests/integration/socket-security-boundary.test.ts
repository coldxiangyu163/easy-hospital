// 真实 127.0.0.1 socket 安全边界测试。
//
// 与 inject 级测试（loopback.test.ts / origin-security.test.ts）互补：本文件通过真实
// TCP 监听、node:http 客户端与 node:net 原始报文固定 Host、Origin、转发头与自定义头的
// 边界行为，落实 docs/test-strategy.md「安全边界证据必须监听真实 loopback 端口」的要求。
//
// 注意：个别断言记录的是当前实现契约（含 WHATWG URL 规范化与 absolute-form 等 quirk）。
// 安全加固改动落地后，应按新契约同步调整这些断言。

import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startApplication,
  type RunningApplication,
} from '../../src/server/runtime.js';

type HttpResult = { status: number; body: string };

describe('真实 socket 安全边界', () => {
  let running: RunningApplication;
  let directory: string;
  let port: number;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-socket-boundary-'));
    running = await startApplication({
      host: '127.0.0.1',
      port: 0,
      databasePath: join(directory, 'data.sqlite3'),
      workerPollMs: 60_000,
    });
    port = Number(new URL(running.url).port);
    expect(port).toBeGreaterThan(0);
  }, 30_000);

  afterAll(async () => {
    await running?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function httpRequest(options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: options.path ?? '/api/health',
          method: options.method ?? 'GET',
          headers: options.headers,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  }

  function rawRequest(raw: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(raw);
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('error', reject);
      socket.on('close', () => {
        const match = data.match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
        resolve({ status: match ? Number(match[1]) : 0, body: data });
      });
      socket.setTimeout(10_000, () => socket.destroy(new Error('原始报文请求超时')));
    });
  }

  describe('Host 边界', () => {
    it('经真实 socket 接受默认 loopback Host', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'healthy' });
    });

    it('接受 localhost 与 [::1] 等价 loopback Host', async () => {
      const localhost = await httpRequest({ headers: { host: `localhost:${port}` } });
      expect(localhost.status).toBe(200);
      const ipv6 = await httpRequest({ headers: { host: `[::1]:${port}` } });
      expect(ipv6.status).toBe(200);
    });

    it('拒绝伪装为 loopback 子域或外部域名的 Host', async () => {
      const subdomain = await httpRequest({ headers: { host: '127.0.0.1.evil.example' } });
      expect(subdomain.status).toBe(403);
      expect(subdomain.body).toContain('LOCAL_ACCESS_ONLY');

      const external = await httpRequest({ headers: { host: 'evil.example' } });
      expect(external.status).toBe(403);
      expect(external.body).toContain('LOCAL_ACCESS_ONLY');
    });

    it('拒绝带 userinfo 伪装的 Host', async () => {
      // URL 解析后 hostname 为 evil.example，不能因含 127.0.0.1 字样而放行。
      const result = await httpRequest({ headers: { host: '127.0.0.1@evil.example' } });
      expect(result.status).toBe(403);
      expect(result.body).toContain('LOCAL_ACCESS_ONLY');
    });

    it('按 WHATWG URL 规范化接受 loopback 等价写法（当前契约）', async () => {
      // 127.1、2130706433（127.0.0.1 的十进制）与 127.0.0.1.（尾点）经 URL 规范化后
      // 都落在 loopback；安全加固若改为精确字符串匹配，需同步调整本断言。
      for (const host of ['127.1', '2130706433', '127.0.0.1.']) {
        const result = await httpRequest({ headers: { host } });
        expect(result.status, `Host: ${host} 应被 URL 规范化为 loopback`).toBe(200);
      }
    });

    it('重复 Host 头以第一个为准，不容歧义', async () => {
      const loopbackFirst = await rawRequest(
        `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
      );
      expect(loopbackFirst.status).toBe(200);

      const evilFirst = await rawRequest(
        `GET /api/health HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      expect(evilFirst.status).toBe(403);
      expect(evilFirst.body).toContain('LOCAL_ACCESS_ONLY');
    });

    it('HTTP/1.0 缺失 Host 头被拒绝', async () => {
      const result = await rawRequest('GET /api/health HTTP/1.0\r\n\r\n');
      expect(result.status).toBe(403);
      expect(result.body).toContain('LOCAL_ACCESS_ONLY');
    });

    it('absolute-form 请求目标不绕过 Host 校验（当前契约）', async () => {
      // 当前行为：absolute-form 指向外部域名、Host 为 loopback 时仍按 Host 放行并路由；
      // 反向组合（目标为 loopback、Host 为外部域名）依然 403。若安全加固改为直接拒绝
      // absolute-form，两条断言都需同步调整。
      const proxied = await rawRequest(
        `GET http://evil.example/api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      expect(proxied.status).toBe(200);

      const hostile = await rawRequest(
        `GET http://127.0.0.1/api/health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
      );
      expect(hostile.status).toBe(403);
    });
  });

  describe('转发与自定义头不被信任', () => {
    it('X-Forwarded-Host / Forwarded / X-Real-IP 不影响 loopback 判定', async () => {
      const xfh = await httpRequest({ headers: { 'x-forwarded-host': 'evil.example' } });
      expect(xfh.status).toBe(200);

      const forwarded = await httpRequest({ headers: { forwarded: 'host=evil.example' } });
      expect(forwarded.status).toBe(200);

      const realIp = await httpRequest({ headers: { 'x-real-ip': '203.0.113.9' } });
      expect(realIp.status).toBe(200);
    });

    it('不能用转发头把非 loopback Host 洗成 loopback', async () => {
      const result = await httpRequest({
        headers: { host: 'evil.example', 'x-forwarded-host': `127.0.0.1:${port}` },
      });
      expect(result.status).toBe(403);
      expect(result.body).toContain('LOCAL_ACCESS_ONLY');
    });
  });

  describe('Origin 边界（写请求）', () => {
    const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

    it('拒绝带外部 Origin 的写请求', async () => {
      const result = await httpRequest({
        method: 'POST',
        path: '/api/watch-tasks',
        headers: { ...jsonHeaders, origin: 'https://attacker.example' },
        body: '{}',
      });
      expect(result.status).toBe(403);
      expect(result.body).toContain('LOCAL_ORIGIN_REQUIRED');
    });

    it('接受带 client 头的 loopback Origin 写请求并进入业务校验', async () => {
      // 400（空 body 业务校验失败）证明已穿过 Origin 检查，而不是 403。
      const result = await httpRequest({
        method: 'POST',
        path: '/api/watch-tasks',
        headers: {
          ...jsonHeaders,
          origin: `http://127.0.0.1:${port}`,
          'x-easy-hospital-client': 'web',
        },
        body: '{}',
      });
      expect(result.status).toBe(400);
      expect(result.body).not.toContain('LOCAL_ORIGIN_REQUIRED');
    });

    it('带 loopback Origin 但缺 client 头的写请求被拒绝（简单请求 CSRF 防护）', async () => {
      // 浏览器“简单请求”无法携带自定义头；缺少 x-easy-hospital-client 一律 403，
      // 且不进入业务校验（不会返回 400 VALIDATION_ERROR）。
      const result = await httpRequest({
        method: 'POST',
        path: '/api/watch-tasks',
        headers: { ...jsonHeaders, origin: `http://127.0.0.1:${port}` },
        body: '{}',
      });
      expect(result.status).toBe(403);
      expect(result.body).toContain('CLIENT_HEADER_REQUIRED');
      expect(result.body).not.toContain('VALIDATION_ERROR');
    });

    it('无 Origin 的写请求按本机非浏览器客户端放行（当前契约）', async () => {
      // 记录当前契约：curl 等本机客户端不带 Origin 仍可用；若安全加固改为强制 Origin，
      // 本断言需同步调整。
      const result = await httpRequest({
        method: 'POST',
        path: '/api/watch-tasks',
        headers: jsonHeaders,
        body: '{}',
      });
      expect(result.status).toBe(400);
      expect(result.body).not.toContain('LOCAL_ORIGIN_REQUIRED');
    });

    it('GET 读请求不受 Origin 限制', async () => {
      const result = await httpRequest({ headers: { origin: 'https://attacker.example' } });
      expect(result.status).toBe(200);
    });

    it('Browser Agent 端点只接受 chrome-extension Origin', async () => {
      const webOrigin = await httpRequest({
        method: 'POST',
        path: '/api/browser-agent/observations',
        headers: { ...jsonHeaders, origin: 'https://attacker.example' },
        body: '{}',
      });
      expect(webOrigin.status).toBe(403);
      expect(webOrigin.body).toContain('BROWSER_AGENT_ORIGIN_FORBIDDEN');

      // 合法的扩展 Origin 穿过边界检查后，因未配置配对 token 而 fail closed（503）。
      const extensionOrigin = await httpRequest({
        method: 'POST',
        path: '/api/browser-agent/observations',
        headers: { ...jsonHeaders, origin: 'chrome-extension://abcdefgh' },
        body: '{}',
      });
      expect(extensionOrigin.status).toBe(503);
      expect(extensionOrigin.body).toContain('BROWSER_AGENT_NOT_CONFIGURED');
    });
  });
});
