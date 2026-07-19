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
        remindBeforeMinutes: 5,
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
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('请选择开始日期。')).toBeInTheDocument();
    expect(screen.getByText('请选择结束日期。')).toBeInTheDocument();
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('结束日期')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-20' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-05' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('日期范围最多为连续 14 天。')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });
});
