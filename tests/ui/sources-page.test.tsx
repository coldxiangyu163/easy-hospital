// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const catalog = {
  hospitals: [
    {
      id: 'hospital-pumch',
      name: '北京协和医院',
      campuses: [{ id: 'campus-pumch-dongdan', name: '东单院区', departments: [{ id: 'department-pumch-dermatology', name: '皮肤科' }] }],
    },
    {
      id: 'hospital-tongren',
      name: '北京同仁医院',
      campuses: [{ id: 'campus-tongren-chongwenmen', name: '崇文门院区', departments: [{ id: 'department-tongren-rhinology', name: '鼻科' }] }],
    },
  ],
};

afterEach(cleanup);

describe('数据来源', () => {
  it('从 catalog、health 与 Adapter API 展示真实范围，并运行 A 级来源自检', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/health') return jsonResponse({ status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { running: true } } });
      if (path === '/api/source-adapters/pumch-public-dermatology-schedule/live-probe') {
        return jsonResponse({
          status: 'OK', observedAt: '2026-07-19T08:00:00.000Z',
          nextAllowedAt: '2026-07-19T10:00:00.000Z', eventsCreated: 0,
        });
      }
      if (path === '/api/source-adapters') return jsonResponse({
        adapters: [
          {
            key: 'pumch-public-dermatology-schedule', accessClass: 'A', enabled: true,
            transport: 'playwright', minIntervalMs: 300000,
            capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
          },
          {
            key: 'browser-agent', accessClass: 'B', enabled: false,
            transport: 'local-agent', minIntervalMs: 300000,
            capabilities: { schedule: true, availability: true, cancellation: true, ruleReminder: false },
          },
          {
            key: 'tongren-rhinology-rules', accessClass: 'C', enabled: true,
            transport: 'rules-only', minIntervalMs: null,
            capabilities: { schedule: false, availability: false, cancellation: false, ruleReminder: true },
          },
        ],
      });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '数据从哪里来' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科' })).toBeInTheDocument();
    expect(screen.getByText('A 级公开来源')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '北京同仁医院 · 崇文门院区 · 鼻科' })).toBeInTheDocument();
    expect(screen.getByText('C 级规则提醒')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'B 级本机浏览器会话' })).toBeInTheDocument();
    expect(screen.getByText('pumch-public-dermatology-schedule')).toBeInTheDocument();
    expect(screen.getAllByText('已启用').length).toBeGreaterThan(0);
    expect(screen.getByText('未配置')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行 A 级来源自检' }));
    expect(await screen.findByText('来源自检已完成；此次未发现可通知变化。')).toBeInTheDocument();
  });

  it('来源限流时展示等待时间，不把 429 当作未知来源结果', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse({ hospitals: [catalog.hospitals[0]] });
      if (path === '/api/health') return jsonResponse({ status: 'healthy', checks: {} });
      if (path === '/api/source-adapters') return jsonResponse({
        adapters: [{
          key: 'pumch-public-dermatology-schedule', accessClass: 'A', enabled: true,
          transport: 'playwright', minIntervalMs: 300000,
          capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
        }],
      });
      if (path === '/api/source-adapters/pumch-public-dermatology-schedule/live-probe') {
        return jsonResponse({ error: 'SOURCE_RATE_LIMITED', retryAfterMs: 300000 }, 429);
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '数据从哪里来' });
    fireEvent.click(screen.getByRole('button', { name: '运行 A 级来源自检' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '来源检查过于频繁；请约 5 分钟后再试。本次结果不可用，也不代表无号。',
    );
  });
});
