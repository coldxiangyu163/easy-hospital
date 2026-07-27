import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { parseAnzhenHeartCenterSchedule } from '../../src/adapters/sources/anzhen-schedule.js';
import {
  ANZHEN_HEART_CENTER_URL,
  createAnzhenHeartCenterScheduleAdapter,
} from '../../src/adapters/sources/anzhen.js';
import { runSourceAdapter, type CheckRequest } from '../../src/core/source-adapter.js';

const fixtureUrl = new URL('../fixtures/anzhen/heart-center-schedule.fragment.html', import.meta.url);
const observedAt = '2026-07-27T00:00:00.000Z';

const request: CheckRequest = {
  requestId: 'anzhen-contract-1',
  sourceId: 'source-anzhen-public-heart-center-schedule',
  hospitalId: 'hospital-anzhen',
  campusId: 'campus-anzhen-chaoyang',
  departmentId: 'department-anzhen-coronary-heart-disease-center',
  dateFrom: '2026-07-27',
  dateTo: '2026-08-02',
  doctorName: null,
  titles: [],
  session: 'ANY',
  deadlineAt: '2026-07-27T00:01:00.000Z',
};

const htmlResponse = (html: string, status = 200, headers: HeadersInit = {}) =>
  new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });

describe('AnzhenHeartCenterScheduleAdapter contract', () => {
  it('从匿名官方 fixture 严格提取朝阳冠心病排班，号源状态始终 unknown', async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), 'utf8');
    const fetchImpl = vi.fn(async () => htmlResponse(html));
    const adapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl,
      now: () => new Date(observedAt),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(adapter.manifest).toMatchObject({
      sourceId: 'source-anzhen-public-heart-center-schedule',
      accessClass: 'A',
      eventTypes: ['schedule_released'],
      stability: 'experimental',
      rateLimitKey: 'official-html:anzhen.org.cn',
      bindings: expect.arrayContaining([
        expect.objectContaining({
          targetId: 'target-anzhen-coronary-heart-disease-center',
          hospitalId: 'hospital-anzhen',
          campusId: 'campus-anzhen-chaoyang',
          departmentId: 'department-anzhen-coronary-heart-disease-center',
          officialEntryUrl: ANZHEN_HEART_CENTER_URL,
        }),
      ]),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('OK');
    expect(result.observations).toEqual([
      expect.objectContaining({
        hospitalId: 'hospital-anzhen',
        campusId: 'campus-anzhen-chaoyang',
        departmentId: 'department-anzhen-coronary-heart-disease-center',
        date: '2026-07-27',
        session: 'AM',
        doctorName: '医生甲',
        title: '知名专家',
        scheduleStatus: 'present',
        availability: 'unknown',
        officialEntryUrl: ANZHEN_HEART_CENTER_URL,
        evidence: 'explicit',
      }),
      expect.objectContaining({
        date: '2026-07-30',
        session: 'PM',
        doctorName: '医生乙',
        title: '主任医师',
      }),
    ]);
    expect(result.observations.some(({ doctorName }) => doctorName === '跨院医生')).toBe(false);
  });

  it('HTML 文本只解码一层 entity，双重编码不能变成标签', async () => {
    const html = (await readFile(fileURLToPath(fixtureUrl), 'utf8')).replace(
      '冠心病中心一区门诊(朝阳)',
      '冠心病中心&amp;lt;script&gt;一区门诊(朝阳)',
    );

    const schedule = parseAnzhenHeartCenterSchedule(html);
    const clinicName = schedule.slots.find(
      ({ department }) => department === 'coronary-heart-disease-center',
    )?.clinicName;
    expect(clinicName).toContain('&lt;script>');
    expect(clinicName).not.toContain('<script>');
  });

  it('HTML 文本提取正确跳过属性引号内含 > 的完整标签', async () => {
    const html = (await readFile(fileURLToPath(fixtureUrl), 'utf8')).replace(
      '冠心病中心一区门诊(朝阳)',
      '冠心病中心<span title="a > b"></span>一区门诊(朝阳)',
    );

    const schedule = parseAnzhenHeartCenterSchedule(html);
    expect(
      schedule.slots.find(
        ({ department }) => department === 'coronary-heart-disease-center',
      )?.clinicName,
    ).toBe('冠心病中心一区门诊(朝阳)');
  });

  it('HTML 文本提取遇到未闭合标签时 fail closed', async () => {
    const html = (await readFile(fileURLToPath(fixtureUrl), 'utf8')).replace(
      '星期日</td>',
      '星期日<span title="broken</td>',
    );

    expect(() => parseAnzhenHeartCenterSchedule(html)).toThrow('HTML 标签未闭合');
  });

  it('同一官方页按 manifest binding 隔离心律失常中心、日期、时段和职称', async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), 'utf8');
    const adapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl: async () => htmlResponse(html),
      now: () => new Date(observedAt),
    });

    const result = await runSourceAdapter(adapter, {
      ...request,
      departmentId: 'department-anzhen-arrhythmia-center',
      dateFrom: '2026-07-29',
      dateTo: '2026-07-31',
      titles: ['副主任医师'],
      session: 'AM',
    });

    expect(result.status).toBe('OK');
    expect(result.observations).toEqual([
      expect.objectContaining({
        departmentId: 'department-anzhen-arrhythmia-center',
        date: '2026-07-29',
        session: 'AM',
        doctorName: '医生丙',
        title: '副主任医师',
        availability: 'unknown',
      }),
    ]);
  });

  it('scope 不属于 binding 时不访问网络且返回 UNSUPPORTED', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse('should not fetch'));
    const adapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl,
      now: () => new Date(observedAt),
    });

    const result = await runSourceAdapter(adapter, {
      ...request,
      campusId: 'campus-anzhen-tongzhou',
    });

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      errorCode: 'ANZHEN_SCOPE_UNSUPPORTED',
      observations: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['空壳加载中', '<html><title>心脏内科医学中心-首都医科大学附属北京安贞医院</title><main>加载中</main></html>'],
    ['跨院内容', '<html><title>其他医院出诊信息</title><table class="clinicDetail"></table></html>'],
    ['DOM 漂移', '<html><title>心脏内科医学中心-首都医科大学附属北京安贞医院</title><div class="new-schedule"></div></html>'],
  ])('%s 返回 SOURCE_CHANGED 且不制造 observation', async (_case, html) => {
    const adapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl: async () => htmlResponse(html),
      now: () => new Date(observedAt),
    });

    await expect(runSourceAdapter(adapter, request)).resolves.toMatchObject({
      status: 'SOURCE_CHANGED',
      errorCode: 'ANZHEN_STRUCTURE_CHANGED',
      observations: [],
    });
  });

  it('403/418/429/验证码均 fail closed，不尝试绕过', async () => {
    for (const response of [
      htmlResponse('denied', 403),
      htmlResponse('blocked', 418),
      htmlResponse('limited', 429),
      htmlResponse('<html>安全验证 验证码</html>'),
    ]) {
      const adapter = createAnzhenHeartCenterScheduleAdapter({
        fetchImpl: async () => response,
        now: () => new Date(observedAt),
      });
      await expect(runSourceAdapter(adapter, request)).resolves.toMatchObject({
        status: 'RATE_LIMITED',
        errorCode: 'ANZHEN_WAF_OR_ACCESS_DENIED',
        observations: [],
      });
    }
  });

  it.each([
    ['delta-seconds', '86400', '2026-07-28T00:00:00.000Z'],
    ['HTTP-date', 'Tue, 28 Jul 2026 12:00:00 GMT', '2026-07-28T12:00:00.000Z'],
    ['非法值', 'tomorrow', '2026-07-27T12:00:00.000Z'],
    ['缺失', undefined, '2026-07-27T12:00:00.000Z'],
  ])('429 Retry-After %s 不早于 12h 与服务端期限', async (_case, retryAfter, expected) => {
    const headers: Record<string, string> = {};
    if (retryAfter !== undefined) headers['retry-after'] = retryAfter;
    const adapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl: async () => htmlResponse('limited', 429, headers),
      now: () => new Date(observedAt),
    });

    await expect(runSourceAdapter(adapter, request)).resolves.toMatchObject({
      status: 'RATE_LIMITED',
      nextAllowedAt: expected,
      errorCode: 'ANZHEN_WAF_OR_ACCESS_DENIED',
      observations: [],
    });
  });

  it('拒绝非 HTML 响应和白名单外重定向', async () => {
    const jsonAdapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl: async () =>
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
      now: () => new Date(observedAt),
    });
    await expect(runSourceAdapter(jsonAdapter, request)).resolves.toMatchObject({
      status: 'SOURCE_CHANGED',
      errorCode: 'ANZHEN_CONTENT_TYPE_CHANGED',
      observations: [],
    });

    const redirectAdapter = createAnzhenHeartCenterScheduleAdapter({
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://untrusted.example/schedule' },
        }),
      now: () => new Date(observedAt),
    });
    await expect(runSourceAdapter(redirectAdapter, request)).resolves.toMatchObject({
      status: 'SOURCE_CHANGED',
      errorCode: 'ANZHEN_REDIRECT_NOT_ALLOWED',
      observations: [],
    });
  });
});
