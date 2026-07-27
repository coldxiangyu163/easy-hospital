// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('应用导航可访问性', () => {
  it('路由切换时更新标题并把焦点移到主要内容，且不移动顺序焦点起点', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') return jsonResponse({
        status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { status: 'healthy', running: true } },
      });
      if (path === '/api/runtime-status') return jsonResponse({
        sqlite: { status: 'healthy' }, worker: { status: 'healthy', running: true },
      });
      if (path === '/api/watch-tasks') return jsonResponse({ tasks: [] });
      if (path === '/api/catalog') return jsonResponse({ hospitals: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );

    expect(document.title).toBe('页面未找到 · 北京挂号雷达');
    fireEvent.click(screen.getByRole('link', { name: '关注任务', exact: true }));
    await screen.findByRole('heading', { name: '还没有关注任务' });

    expect(document.title).toBe('关注任务 · 北京挂号雷达');
    expect(document.getElementById('main-content')).toHaveFocus();
    // 回归：scrollIntoView 会移动浏览器顺序焦点起点，导致首 Tab 跳过「跳到主要内容」
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('顶栏把仅本机访问与真实健康状态分开，并在路由切换时刷新', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') return jsonResponse({
        status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { status: 'healthy', running: true } },
      });
      if (path === '/api/runtime-status') return jsonResponse({
        sqlite: { status: 'healthy' }, worker: { status: 'healthy', running: true },
      });
      if (path === '/api/watch-tasks') return jsonResponse({ tasks: [] });
      if (path === '/api/catalog') return jsonResponse({ hospitals: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('仅本机访问')).toBeInTheDocument();
    expect(await screen.findByText('运行正常')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '关注任务', exact: true }));
    await screen.findByRole('heading', { name: '还没有关注任务' });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/health')).toHaveLength(2);
    });
  });

  it('顶栏在检查失败时显示状态未知，在已知非健康时显示需要处理', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') return jsonResponse({
        status: 'degraded', checks: { storage: { status: 'healthy' }, worker: { status: 'degraded', running: true } },
      });
      if (path === '/api/runtime-status') return jsonResponse({
        sqlite: { status: 'healthy' }, worker: { status: 'degraded', running: true },
      });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('需要处理')).toBeInTheDocument();

    view.unmount();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('状态未知')).toBeInTheDocument();
  });

  it('六个导航入口无需横向滚动提示即可发现，并保留产品边界', () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(
      <MemoryRouter initialEntries={['/does-not-exist']}>
        <App />
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: '主要导航，六个入口' });
    for (const label of ['现在', '关注任务', '规则与日历', '通知记录', '数据来源', '本机设置']) {
      expect(nav).toContainElement(screen.getByRole('link', { name: label, exact: true }));
    }
    expect(screen.getByText('只提醒，不代预约')).toBeInTheDocument();
  });

  it('直接进入后半段导航时直接滚动导航容器，保持当前项可见', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') return jsonResponse({
        status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { running: true } },
      });
      if (path === '/api/catalog') return jsonResponse({ hospitals: [] });
      if (path === '/api/runtime-status') return jsonResponse({
        dataDirectory: { display: '…/easy-hospital' },
        sqlite: { status: 'healthy' },
        worker: { status: 'healthy', running: true },
        notifications: [],
        browserAgent: { configured: false, lastSeenAt: null },
        sourceCapabilities: [],
      });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const scrollLeftSet = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      configurable: true,
      get: () => 0,
      set: scrollLeftSet,
    });

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '先确认这台电脑已经准备好' });
    // 用赋值 scrollLeft 的方式滚动容器，而不是 scrollIntoView
    await waitFor(() => expect(scrollLeftSet).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.title).toBe('本机设置 · 北京挂号雷达');
  });
});
