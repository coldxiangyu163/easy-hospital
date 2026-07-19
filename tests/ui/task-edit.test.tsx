// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      campuses: [
        {
          id: 'campus-pumch-dongdan',
          name: '东单院区',
          departments: [{ id: 'department-pumch-dermatology', name: '皮肤科' }],
        },
      ],
    },
  ],
};

const originalTask = {
  id: 'task-1',
  hospitalId: 'hospital-pumch',
  campusId: 'campus-pumch-dongdan',
  departmentId: 'department-pumch-dermatology',
  matchMode: 'any_expert',
  doctorName: null,
  titles: [],
  dateFrom: '2026-07-20',
  dateTo: '2026-07-26',
  session: 'AM',
  eventTypes: ['schedule_released'],
  remindBeforeMinutes: 5,
  enabled: true,
  version: 1,
  createdAt: '2026-07-19T01:00:00.000Z',
  updatedAt: '2026-07-19T01:00:00.000Z',
};

afterEach(cleanup);

describe('编辑关注任务', () => {
  it('读取当前版本并通过 PATCH 保存，避免覆盖更新版本', async () => {
    let currentTask = originalTask;
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks/task-1' && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        currentTask = { ...currentTask, ...patchBody, version: 2, updatedAt: '2026-07-19T02:00:00.000Z' };
        return jsonResponse(currentTask);
      }
      if (path === '/api/watch-tasks/task-1') return jsonResponse(currentTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/task-1/edit']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '编辑这件关注' })).toBeInTheDocument();
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-07-20');
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-28' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() => expect(patchBody).toMatchObject({ version: 1, dateTo: '2026-07-28' }));
    expect(await screen.findByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科' })).toBeInTheDocument();
    expect(screen.getByText('2026-07-20 至 2026-07-28')).toBeInTheDocument();
  });

  it('版本冲突时保留内容、分类错误并聚焦摘要', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks/task-1' && init?.method === 'PATCH') {
        return jsonResponse({ error: 'WATCH_TASK_VERSION_CONFLICT' }, 409);
      }
      if (path === '/api/watch-tasks/task-1') return jsonResponse(originalTask);
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/task-1/edit']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '编辑这件关注' });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('任务已在其他页面更新');
    await waitFor(() => expect(summary).toHaveFocus());
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-07-20');
  });
});
