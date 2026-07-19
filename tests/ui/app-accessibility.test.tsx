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
  it('路由切换时更新标题并把焦点移到主要内容', async () => {
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
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' });
  });

  it('直接进入后半段导航时主动把当前项滚动到可见范围', async () => {
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

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '先确认这台电脑已经准备好' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'center' }));
    expect(document.title).toBe('本机设置 · 北京挂号雷达');
  });
});
