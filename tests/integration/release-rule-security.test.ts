import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';
import { openDatabase } from '../../src/storage/database.js';
import { hasOfficialRuleUrls } from '../../src/storage/release-rules.js';

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
    const headers = {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1:3210',
      'x-easy-hospital-client': 'web',
    };
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

  it('同仁种子规则的官方/证据域组合可经 API 维护', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-security-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1:3210',
      'x-easy-hospital-client': 'web',
    };
    const id = 'rule-tongren-rhinology-daily-1500';

    // 原值 PATCH（种子 URL：bjtrhos.cn 官方域 + news.bjd.com.cn 证据域）不再被自家校验卡死
    const sameValues = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${id}`,
      headers,
      payload: {
        officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
        sourceUrl: 'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
      },
    });
    expect(sameValues.statusCode).toBe(200);

    // 同域其他路径可更新
    const otherPath = await app.inject({
      method: 'PATCH',
      url: `/api/release-rules/${id}`,
      headers,
      payload: { officialEntryUrl: 'https://www.trhos.com/Html/News/Articles/1.html' },
    });
    expect(otherPath.statusCode).toBe(200);

    // 证据域也可用于新建规则
    const created = await app.inject({
      method: 'POST',
      url: '/api/release-rules',
      headers,
      payload: {
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        advanceDays: 7,
        releaseTimeLocal: '15:00',
        sameDayPolicy: '以官方页面为准',
        officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
        sourceUrl: 'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
        verifiedAt: '2026-07-19T01:00:00.000Z',
        confidence: 'medium',
        needsReconfirmation: true,
      },
    });
    expect(created.statusCode).toBe(201);
  });

  it('新增医院官方域逐院登记，严格拒绝跨院和 lookalike', async () => {
    const database = openDatabase(':memory:');
    try {
      const cases = [
        ['hospital-pkuph', 'https://www.pkuph.cn/', 'https://pkuph.cn/news'],
        ['hospital-puh3', 'https://www.puh3.net.cn/', 'https://www.puh3.net.cn/news'],
        ['hospital-jishuitan', 'https://www.jst-hosp.com.cn/', 'https://jst-hosp.com.cn/news'],
        ['hospital-fuwai', 'https://www.fuwaihospital.org/', 'https://www.fuwai.com/news'],
        ['hospital-anzhen', 'https://www.anzhen.org/', 'https://anzhen.org/news'],
        ['hospital-pkufh', 'https://www.pkufh.com/', 'https://pkufh.91health.net/news'],
        ['hospital-tiantan', 'https://www.bjtth.org/', 'https://bjtth.org/news'],
        ['hospital-beijing-childrens', 'https://www.bch.com.cn/', 'https://bch.com.cn/news'],
        ['hospital-cicams', 'https://www.cicams.ac.cn/', 'https://cicams.ac.cn/news'],
      ] as const;
      for (const [hospitalId, officialEntryUrl, sourceUrl] of cases) {
        expect(
          hasOfficialRuleUrls(database, { hospitalId, officialEntryUrl, sourceUrl }),
        ).toBe(true);
        expect(
          hasOfficialRuleUrls(database, {
            hospitalId,
            officialEntryUrl: `${officialEntryUrl.slice(0, -1)}.evil.example/`,
            sourceUrl,
          }),
        ).toBe(false);
      }
      expect(
        hasOfficialRuleUrls(database, {
          hospitalId: 'hospital-pkuph',
          officialEntryUrl: 'https://www.puh3.net.cn/',
          sourceUrl: 'https://www.pkuph.cn/news',
        }),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it('同仁 lookalike 域与证据域越位仍被拒绝', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-rule-security-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });
    const headers = {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1:3210',
      'x-easy-hospital-client': 'web',
    };
    const id = 'rule-tongren-rhinology-daily-1500';
    const base = {
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      advanceDays: 7,
      releaseTimeLocal: '15:00',
      sameDayPolicy: '以官方页面为准',
      officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
      sourceUrl: 'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
      verifiedAt: '2026-07-19T01:00:00.000Z',
      confidence: 'medium' as const,
      needsReconfirmation: true,
    };

    const rejectCases: Array<{ patch: Record<string, string>; note: string }> = [
      { patch: { officialEntryUrl: 'https://www.trhos.com.evil.example/x' }, note: 'trhos lookalike' },
      { patch: { officialEntryUrl: 'https://bjtrhos.cn.attacker.example/' }, note: 'bjtrhos lookalike' },
      { patch: { sourceUrl: 'https://news.bjd.com.cn.evil.example/x' }, note: 'bjd lookalike' },
      { patch: { sourceUrl: 'https://bjd.com.cn/x' }, note: '未登记的 bjd 裸域' },
      { patch: { officialEntryUrl: 'https://news.bjd.com.cn/x' }, note: '证据域越位为官方入口' },
      { patch: { officialEntryUrl: 'https://www.pumch.cn/x' }, note: '跨医院官方域' },
    ];
    for (const { patch } of rejectCases) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/release-rules/${id}`,
        headers,
        payload: patch,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'UNOFFICIAL_URL' });

      const created = await app.inject({
        method: 'POST',
        url: '/api/release-rules',
        headers,
        payload: { ...base, ...patch },
      });
      expect(created.statusCode).toBe(400);
      expect(created.json()).toEqual({ error: 'UNOFFICIAL_URL' });
    }
  });
});
