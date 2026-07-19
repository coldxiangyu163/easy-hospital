import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { runSourceAdapter, type CheckRequest } from '../../src/core/source-adapter.js';
import {
  createPumchDermatologyScheduleAdapter,
  PUMCH_MAX_RESPONSE_BYTES,
} from '../../src/adapters/sources/pumch.js';

const fixtureUrl = new URL('../fixtures/pumch/skin-schedule.fragment.html', import.meta.url);

const request: CheckRequest = {
  requestId: 'pumch-contract-1',
  sourceId: 'source-pumch-public-schedule',
  hospitalId: 'hospital-pumch',
  campusId: 'campus-pumch-dongdan',
  departmentId: 'department-pumch-dermatology',
  dateFrom: '2026-07-20',
  dateTo: '2026-07-21',
  doctorName: null,
  titles: [],
  session: 'ANY',
  deadlineAt: '2026-07-19T00:01:00.000Z',
};

describe('PumchDermatologyScheduleAdapter contract', () => {
  it('publishes explicit schedule observations while availability stays unknown', async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), 'utf8');
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const renderPage = vi.fn(async () => {
      throw new Error('fixture fetch should not require rendering');
    });
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(adapter.manifest).toMatchObject({
      accessClass: 'A',
      transport: 'fetch',
      allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
      minIntervalMs: 7_200_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(renderPage).not.toHaveBeenCalled();
    expect(result.status).toBe('OK');
    expect(result.errorCode).toBeUndefined();
    expect(result.observations).toHaveLength(4);
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: '2026-07-20',
          session: 'AM',
          doctorName: '医生甲',
          scheduleStatus: 'present',
          availability: 'unknown',
          evidence: 'explicit',
        }),
        expect.objectContaining({
          date: '2026-07-21',
          session: 'PM',
          doctorName: '医生丁',
          scheduleStatus: 'present',
          availability: 'unknown',
          evidence: 'explicit',
        }),
      ]),
    );
    expect(result.observations.every((item) => item.availability === 'unknown')).toBe(true);
    expect(result.observations.every((item) => item.scheduleStatus === 'present')).toBe(true);
  });

  it('tries fetch first and renders only the recognized dynamic schedule shell', async () => {
    const renderedHtml = await readFile(fileURLToPath(fixtureUrl), 'utf8');
    const shellHtml = `
      <html>
        <div id="docker-visit"></div>
        <script>var _url = "/newdsearchs/dockerinfo/3/皮肤科/1/1.html";</script>
      </html>
    `;
    const fetchImpl = vi.fn(async () => new Response(shellHtml, { status: 200 }));
    const renderPage = vi.fn(async () => renderedHtml);
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(
      'https://www.pumch.cn/expert_chuzhen_week/%E7%9A%AE%E8%82%A4%E7%A7%91/3/1.html?linkage=990473',
      request.deadlineAt,
    );
    expect(result.status).toBe('OK');
    expect(result.observations).toHaveLength(4);
  });

  it('returns a diagnosable unknown result when the public DOM structure changes', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html><main>新版出诊页面</main></html>', { status: 200 }),
    );
    const renderPage = vi.fn(async () => {
      throw new Error('an unrecognized page must not be treated as a rendering shell');
    });
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'SOURCE_CHANGED',
      errorCode: 'PUMCH_STRUCTURE_CHANGED',
      observations: [],
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('returns AUTH_REQUIRED for a login wall without trying to bypass it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html><title>用户登录</title><form>请登录后查看出诊信息</form></html>', {
        status: 200,
      }),
    );
    const renderPage = vi.fn(async () => '<html>should not render</html>');
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'AUTH_REQUIRED',
      errorCode: 'PUMCH_AUTH_REQUIRED',
      observations: [],
    });
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('returns RATE_LIMITED for a WAF denial without retrying or rendering around it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html><title>Access denied</title><p>WAF challenge</p></html>', {
        status: 403,
      }),
    );
    const renderPage = vi.fn(async () => '<html>should not render</html>');
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'RATE_LIMITED',
      errorCode: 'PUMCH_WAF_OR_ACCESS_DENIED',
      observations: [],
    });
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('rejects non-PUMCH dermatology scope before making a network request', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html></html>', { status: 200 }));
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, {
      ...request,
      departmentId: 'department-pumch-cardiology',
    });

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      errorCode: 'PUMCH_SCOPE_UNSUPPORTED',
      observations: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns TEMPORARY_FAILURE when the single fetch cannot complete', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('simulated network failure with no sensitive details');
    });
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'TEMPORARY_FAILURE',
      errorCode: 'PUMCH_FETCH_FAILED',
      observations: [],
    });
  });

  it('returns TEMPORARY_FAILURE when the required one-shot render fails', async () => {
    const shellHtml = `
      <div id="docker-visit"></div>
      <script>var _url = "/newdsearchs/dockerinfo/3/皮肤科/1/1.html";</script>
    `;
    const fetchImpl = vi.fn(async () => new Response(shellHtml, { status: 200 }));
    const renderPage = vi.fn(async () => {
      throw new Error('simulated browser timeout');
    });
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'TEMPORARY_FAILURE',
      errorCode: 'PUMCH_RENDER_FAILED',
      observations: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledTimes(1);
  });

  it('does not access the network after the request deadline', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html></html>', { status: 200 }));
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:02:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'TEMPORARY_FAILURE',
      errorCode: 'PUMCH_DEADLINE_EXCEEDED',
      observations: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns TEMPORARY_FAILURE for an upstream 5xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('maintenance', { status: 503 }));
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'TEMPORARY_FAILURE',
      errorCode: 'PUMCH_UPSTREAM_UNAVAILABLE',
      observations: [],
    });
  });

  it('does not follow a redirect outside the declared official hosts', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.example/schedule' },
      }),
    );
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'SOURCE_CHANGED',
      errorCode: 'PUMCH_REDIRECT_NOT_ALLOWED',
      observations: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a rendered login wall unknown instead of treating it as an empty schedule', async () => {
    const shellHtml = `
      <div id="docker-visit"></div>
      <script>var _url = "/newdsearchs/dockerinfo/3/皮肤科/1/1.html";</script>
    `;
    const fetchImpl = vi.fn(async () => new Response(shellHtml, { status: 200 }));
    const renderPage = vi.fn(async () =>
      '<html><title>用户登录</title><p>请登录后查看出诊信息</p></html>',
    );
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'AUTH_REQUIRED',
      errorCode: 'PUMCH_AUTH_REQUIRED',
      observations: [],
    });
  });

  it('reports title filters as unsupported because the public schedule has no title field', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html></html>', { status: 200 }));
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, {
      ...request,
      titles: ['主任医师'],
    });

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      errorCode: 'PUMCH_TITLE_FILTER_UNSUPPORTED',
      observations: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the deadline active while consuming the response body', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new Error('aborted by deadline')),
          );
        },
      });
      return {
        status: 200,
        headers: new Headers(),
        body,
      } as Response;
    });
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const outcome = await Promise.race([
      runSourceAdapter(adapter, {
        ...request,
        deadlineAt: '2026-07-19T00:00:00.020Z',
      }),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    expect(outcome).toMatchObject({
      status: 'TEMPORARY_FAILURE',
      errorCode: 'PUMCH_DEADLINE_EXCEEDED',
      observations: [],
    });
  });

  it('rejects an oversized response body before parsing it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(PUMCH_MAX_RESPONSE_BYTES + 1), { status: 200 }),
    );
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'SOURCE_CHANGED',
      errorCode: 'PUMCH_RESPONSE_TOO_LARGE',
      observations: [],
    });
  });

  it('classifies an HTTP 200 WAF challenge as unknown and never renders around it', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html><meta name="Block-Event-Id" content="redacted">安全验证</html>', {
        status: 200,
      }),
    );
    const renderPage = vi.fn(async () => '<html>should not render</html>');
    const adapter = createPumchDermatologyScheduleAdapter({
      fetchImpl,
      renderPage,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    const result = await runSourceAdapter(adapter, request);

    expect(result).toMatchObject({
      status: 'RATE_LIMITED',
      errorCode: 'PUMCH_WAF_OR_ACCESS_DENIED',
      observations: [],
    });
    expect(renderPage).not.toHaveBeenCalled();
  });
});
