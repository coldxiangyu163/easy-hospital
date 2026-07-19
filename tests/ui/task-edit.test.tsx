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

const catalogWithTongren = {
  hospitals: [
    ...catalog.hospitals,
    {
      id: 'hospital-tongren',
      name: '北京同仁医院',
      campuses: [
        {
          id: 'campus-tongren-chongwenmen',
          name: '崇文门院区',
          departments: [{ id: 'department-tongren-rhinology', name: '鼻科' }],
        },
      ],
    },
  ],
};

const tongrenTask = {
  ...originalTask,
  id: 'task-tr-1',
  hospitalId: 'hospital-tongren',
  campusId: 'campus-tongren-chongwenmen',
  departmentId: 'department-tongren-rhinology',
  session: 'ANY',
  remindBeforeMinutes: 30,
};

const experimentalTask = {
  ...originalTask,
  eventTypes: ['schedule_released', 'cancellation_slot_detected'],
};

function runtimeStatusResponse(configured: boolean) {
  return jsonResponse({
    dataDirectory: { display: '…/data' },
    sqlite: { status: 'healthy' },
    worker: { status: 'healthy', running: true },
    notifications: [],
    browserAgent: { configured, lastSeenAt: null },
    sourceCapabilities: [],
  });
}

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

  it('编辑 C 级任务：提醒分钟 30 原样保留，不静默改回 5', async () => {
    let currentTask = tongrenTask;
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalogWithTongren);
      if (path === '/api/runtime-status') return runtimeStatusResponse(false);
      if (path === '/api/watch-tasks/task-tr-1' && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        currentTask = { ...currentTask, ...patchBody, version: 2, updatedAt: '2026-07-19T02:00:00.000Z' };
        return jsonResponse(currentTask);
      }
      if (path === '/api/watch-tasks/task-tr-1') return jsonResponse(currentTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/task-tr-1/edit']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '编辑这件关注' });
    expect(screen.queryByLabelText(/实验性 B 级/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() =>
      expect(patchBody).toMatchObject({
        hospitalId: 'hospital-tongren',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 30,
      }),
    );
  });

  it('编辑 A 级任务：API 已有的提醒分钟 30 原样保留', async () => {
    let currentTask = { ...originalTask, remindBeforeMinutes: 30 };
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return runtimeStatusResponse(false);
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

    await screen.findByRole('heading', { name: '编辑这件关注' });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));

    await waitFor(() => expect(patchBody).toMatchObject({ remindBeforeMinutes: 30 }));
  });

  it('编辑时主动切换医院：提醒分钟按新等级重置（A 30 → C 5 → A null）', async () => {
    let currentTask = { ...originalTask, remindBeforeMinutes: 30 };
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalogWithTongren);
      if (path === '/api/runtime-status') return runtimeStatusResponse(false);
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

    await screen.findByRole('heading', { name: '编辑这件关注' });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-tongren' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(patchBody).toMatchObject({
        hospitalId: 'hospital-tongren',
        remindBeforeMinutes: 5,
      }),
    );
  });

  it('编辑已勾选实验事件的任务：勾选状态按后端原值初始化，保存不静默覆盖', async () => {
    let currentTask = experimentalTask;
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return runtimeStatusResponse(true);
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

    await screen.findByRole('heading', { name: '编辑这件关注' });
    const cancellation = screen.getByLabelText(/实验性 B 级 · 疑似退号回流/);
    expect(cancellation).toBeChecked();
    expect(screen.getByLabelText(/实验性 B 级 · 从无号变为有号/)).not.toBeChecked();

    // 不改动事件勾选，直接保存：原 eventTypes 必须原样保留
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(patchBody).toMatchObject({
        eventTypes: ['schedule_released', 'cancellation_slot_detected'],
      }),
    );
  });

  it('Browser Agent 未配置时编辑含实验事件的任务：不展示勾选但仍保留原 eventTypes', async () => {
    let currentTask = experimentalTask;
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return runtimeStatusResponse(false);
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

    await screen.findByRole('heading', { name: '编辑这件关注' });
    expect(screen.queryByLabelText(/实验性 B 级/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(patchBody).toMatchObject({
        eventTypes: ['schedule_released', 'cancellation_slot_detected'],
      }),
    );
  });

  it('取消勾选实验事件后保存，只保留 schedule_released', async () => {
    let currentTask = experimentalTask;
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return runtimeStatusResponse(true);
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

    await screen.findByRole('heading', { name: '编辑这件关注' });
    const cancellation = screen.getByLabelText(/实验性 B 级 · 疑似退号回流/);
    expect(cancellation).toBeChecked();
    fireEvent.click(cancellation);
    expect(cancellation).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(patchBody).toMatchObject({
        eventTypes: ['schedule_released'],
      }),
    );
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
