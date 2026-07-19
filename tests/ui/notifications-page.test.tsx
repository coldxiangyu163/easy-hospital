// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const task = {
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

const batch = {
  id: 'batch-1',
  taskId: 'task-1',
  state: 'delivery_unknown',
  opensAt: '2026-07-19T01:00:00.000Z',
  closesAt: '2026-07-19T01:01:00.000Z',
  eventTags: ['schedule_released'],
  eventIds: ['event-1'],
  officialEntryUrl: 'https://www.pumch.cn/register',
};

describe('通知记录', () => {
  it('从 API 关联任务并明确 delivery_unknown 不等于真实送达', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/notification-batches') return jsonResponse({ batches: [batch] });
      if (path === '/api/watch-tasks') return jsonResponse({ tasks: [task] });
      if (path === '/api/catalog') return jsonResponse(catalog);
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/notifications']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '我收到的提醒' })).toBeInTheDocument();
    expect(screen.getByText('北京协和医院 · 东单院区 · 皮肤科')).toBeInTheDocument();
    expect(screen.getByText('送达状态未知')).toBeInTheDocument();
    expect(screen.getByText('不会自动重复发送，请先检查接收端。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往官方渠道核验（新标签页打开）' })).toHaveAttribute(
      'href',
      batch.officialEntryUrl,
    );
  });
});
