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

afterEach(cleanup);

describe('创建关注任务', () => {
  it('先校验真实 catalog 表单，再通过 API 创建并进入任务详情', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-1',
          enabled: true,
          version: 1,
          createdAt: '2026-07-19T01:00:00.000Z',
          updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-1') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('正在读取可关注范围')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '新增一件关注' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.change(screen.getByLabelText('时段'), { target: { value: 'AM' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
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
        remindBeforeMinutes: null,
      }),
    );
    expect(
      await screen.findByRole('heading', {
        name: '北京协和医院 · 东单院区 · 皮肤科',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('所有预约仍需在官方渠道手动完成')).toBeInTheDocument();
  });

  it('C 级规则提醒隐藏并强制忽略医生、职称与时段条件', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-c-1', enabled: true, version: 1,
          createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-c-1') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-tongren' } });
    expect(screen.queryByLabelText('关注范围')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('时段')).not.toBeInTheDocument();
    expect(screen.getByText('医生、职称与时段不会参与判断。', { exact: false })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() => expect(createdTask).toMatchObject({
      hospitalId: 'hospital-tongren',
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      session: 'ANY',
    }));
    expect(await screen.findByText('医生、职称和时段不参与规则提醒')).toBeInTheDocument();
  });

  it('Browser Agent 已配置时展示实验事件勾选，默认不选，勾选后随任务提交', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') {
        return jsonResponse({
          dataDirectory: { display: '…/data' },
          sqlite: { status: 'healthy' },
          worker: { status: 'healthy', running: true },
          notifications: [],
          browserAgent: { configured: true, lastSeenAt: null },
          sourceCapabilities: [],
        });
      }
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-b-1', enabled: true, version: 1,
          createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-b-1') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    const fixed = screen.getByLabelText('新排班发布（始终包含）');
    expect(fixed).toBeChecked();
    expect(fixed).toBeDisabled();
    const available = screen.getByLabelText(/实验性 B 级 · 从无号变为有号/);
    const cancellation = screen.getByLabelText(/实验性 B 级 · 疑似退号回流/);
    expect(available).not.toBeChecked();
    expect(cancellation).not.toBeChecked();

    fireEvent.click(cancellation);
    expect(cancellation).toBeChecked();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
        eventTypes: ['schedule_released', 'cancellation_slot_detected'],
      }),
    );
  });

  it('Browser Agent 未配置时不展示实验勾选，创建只订阅新排班发布', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') {
        return jsonResponse({
          dataDirectory: { display: '…/data' },
          sqlite: { status: 'healthy' },
          worker: { status: 'healthy', running: true },
          notifications: [],
          browserAgent: { configured: false, lastSeenAt: null },
          sourceCapabilities: [],
        });
      }
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-a-2', enabled: true, version: 1,
          createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-a-2') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    expect(screen.getByLabelText('新排班发布（始终包含）')).toBeChecked();
    expect(screen.queryByLabelText(/实验性 B 级/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
        hospitalId: 'hospital-pumch',
        eventTypes: ['schedule_released'],
      }),
    );
  });

  it('C 级规则提醒在 Browser Agent 已配置时仍不展示实验勾选，只依赖 schedule_released', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') {
        return jsonResponse({
          dataDirectory: { display: '…/data' },
          sqlite: { status: 'healthy' },
          worker: { status: 'healthy', running: true },
          notifications: [],
          browserAgent: { configured: true, lastSeenAt: null },
          sourceCapabilities: [],
        });
      }
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-c-2', enabled: true, version: 1,
          createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-c-2') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-tongren' } });
    expect(screen.queryByLabelText(/实验性 B 级/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('新排班发布（始终包含）')).not.toBeInTheDocument();
    expect(screen.getByText('医生、职称与时段不会参与判断。', { exact: false })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
        hospitalId: 'hospital-tongren',
        matchMode: 'any_expert',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      }),
    );
  });

  it('新建默认 A 级提醒分钟为 null，主动切换医院时按新等级重置', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-sw-1', enabled: true, version: 1,
          createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-sw-1') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    // 协和(A) → 同仁(C) → 协和(A)：主动切换按新 policy 重置，最终回到 A 级应为 null
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-tongren' } });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-pumch' } });

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
        hospitalId: 'hospital-pumch',
        remindBeforeMinutes: null,
      }),
    );
  });

  it('新建切到 C 级后提交，规则提醒分钟默认 5', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-sw-2', enabled: true, version: 1,
          createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-sw-2') return jsonResponse(createdTask);
      if (path === '/api/events') return jsonResponse({ events: [] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-tongren' } });

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-26' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
        hospitalId: 'hospital-tongren',
        remindBeforeMinutes: 5,
      }),
    );
  });

  it('在客户端阻止缺少日期和超过 14 天的提交', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('min', '2026-07-19');
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('max', '2026-08-02');
    expect(screen.getByLabelText('结束日期')).toHaveAttribute('max', '2026-08-02');
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('请选择开始日期。')).toBeInTheDocument();
    expect(screen.getByText('请选择结束日期。')).toBeInTheDocument();
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('结束日期')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-05' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('日期范围最多为连续 14 天。')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-29' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-03' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('最多可选择北京时间今天起 14 天内的日期。')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });
});
