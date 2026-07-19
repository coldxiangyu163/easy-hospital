// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('现在页面', () => {
  it('请求完成前显示加载而不是空状态，空数据时给出真实下一步', async () => {
    let releaseRequests!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      const path = new URL(String(input), 'http://localhost').pathname;
      const payloads: Record<string, unknown> = {
        '/api/health': { status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { status: 'healthy' } } },
        '/api/watch-tasks': { tasks: [] },
        '/api/release-rules': { rules: [] },
        '/api/events': { events: [] },
        '/api/notification-batches': { batches: [] },
      };
      return jsonResponse(payloads[path]);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByText('正在读取本机数据')).toBeInTheDocument();
    expect(screen.queryByText('还没有关注任务')).not.toBeInTheDocument();

    releaseRequests();

    expect(await screen.findByRole('heading', { name: '下一步：创建第一件关注' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '创建关注任务' })).toHaveAttribute(
      'href',
      '/tasks/new',
    );
    expect(screen.queryByText(/检测到可用号源|发现退号/)).not.toBeInTheDocument();
  });
});
