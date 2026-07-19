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
