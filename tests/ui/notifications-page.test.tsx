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

  it('failed 但存在已接受渠道时显示「部分送达」而非整体失败', async () => {
    const partialBatch = {
      ...batch,
      id: 'batch-partial',
      state: 'failed',
      terminalReason: null,
      deliveries: [
        { channel: 'macos', state: 'sent', attempts: 1, messageId: 'm-1', errorCode: null },
        { channel: 'bark', state: 'failed', attempts: 4, messageId: 'm-2', errorCode: 'BARK_HTTP_500' },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/notification-batches') return jsonResponse({ batches: [partialBatch] });
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

    expect(await screen.findByText('部分送达')).toBeInTheDocument();
    expect(
      screen.getByText('1 个渠道已接受消息，其余渠道失败。请检查失败渠道配置，并在已送达渠道确认到达。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('发送失败')).not.toBeInTheDocument();
  });

  it('规则提醒重试跨过放号 deadline 时不误写成电脑未运行', async () => {
    const expiredBatch = {
      ...batch,
      id: 'batch-reminder-retry-expired',
      state: 'failed',
      kind: 'release-reminder',
      targetDate: '2026-07-26',
      terminalReason: 'RELEASE_REMINDER_RETRY_EXPIRED',
      deliveries: [
        {
          channel: 'bark',
          state: 'failed',
          attempts: 3,
          messageId: 'm-expired',
          errorCode: 'BARK_HTTP_500',
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/notification-batches') return jsonResponse({ batches: [expiredBatch] });
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

    expect(
      await screen.findByText('通知渠道重试已到放号时刻，本次停止重试；最后一次渠道错误已保留。'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/电脑.*未运行/)).not.toBeInTheDocument();
  });

  it('陈旧事件终态展示诚实原因，不伪装准时送达', async () => {
    const staleBatch = {
      ...batch,
      id: 'batch-stale',
      state: 'failed',
      terminalReason: 'EVENT_NOTIFICATION_STALE',
      deliveries: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/notification-batches') return jsonResponse({ batches: [staleBatch] });
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

    expect(await screen.findByText('发送失败')).toBeInTheDocument();
    expect(
      screen.getByText('事件距检测已超过 15 分钟，已失去行动价值，不再补发。'),
    ).toBeInTheDocument();
  });
});
