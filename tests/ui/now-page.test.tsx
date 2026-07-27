// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import type { WatchTask } from '../../src/ui/api.js';
import { pumchCatalog } from '../support/ui-catalog.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function watchTask(): WatchTask {
  return {
    id: 'task-1',
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
    matchMode: 'any_expert',
    doctorName: null,
    titles: [],
    dateFrom: '2026-07-20',
    dateTo: '2026-07-27',
    session: 'ANY',
    eventTypes: ['schedule_released'],
    remindBeforeMinutes: 5,
    enabled: true,
    version: 1,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

function renderNowWith(health: unknown): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const payloads: Record<string, unknown> = {
      '/api/health': health,
      '/api/catalog': pumchCatalog,
      '/api/watch-tasks': { tasks: [watchTask()] },
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
        '/api/catalog': { hospitals: [] },
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

  it('顶层 status 为 healthy 但 worker degraded 时，首屏提示先检查 Worker', async () => {
    renderNowWith({
      status: 'healthy',
      checks: {
        storage: { status: 'healthy' },
        worker: { status: 'degraded', running: true, lastErrorCode: 'SOURCE_TEMPORARY_FAILURE' },
      },
    });

    expect(
      await screen.findByRole('heading', { name: '下一步：先检查本机 Worker' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/监测曾中断或本机 Worker 异常/)).toBeInTheDocument();
    expect(screen.queryByText(/公开排班关注正在运行/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看本机状态' })).toHaveAttribute('href', '/settings');
  });

  it('worker stopped 时同样提示先检查 Worker，不显示监控运行', async () => {
    renderNowWith({
      status: 'healthy',
      checks: {
        storage: { status: 'healthy' },
        worker: { status: 'stopped', running: false },
      },
    });

    expect(
      await screen.findByRole('heading', { name: '下一步：先检查本机 Worker' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/公开排班关注正在运行/)).not.toBeInTheDocument();
  });

  it('worker 健康但最近重建过基线时，如实说明空窗不推断且不显示精确时间', async () => {
    renderNowWith({
      status: 'healthy',
      checks: {
        storage: { status: 'healthy' },
        worker: { status: 'healthy', running: true, lastRebaselineAt: '2026-07-19T01:00:00.000Z' },
      },
    });

    expect(await screen.findByText(/公开排班关注正在运行/)).toBeInTheDocument();
    expect(screen.getByText(/空窗期间是否有变化不做推断/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-07-19T01:00/)).not.toBeInTheDocument();
  });

  it('worker 健康且未重建基线时，不显示空窗说明', async () => {
    renderNowWith({
      status: 'healthy',
      checks: {
        storage: { status: 'healthy' },
        worker: { status: 'healthy', running: true, lastRebaselineAt: null },
      },
    });

    expect(await screen.findByText(/公开排班关注正在运行/)).toBeInTheDocument();
    expect(screen.queryByText(/空窗/)).not.toBeInTheDocument();
  });
});
