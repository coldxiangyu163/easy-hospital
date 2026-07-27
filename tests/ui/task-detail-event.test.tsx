// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { pumchCatalog as catalog } from '../support/ui-catalog.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const task = {
  id: 'task-1', hospitalId: 'hospital-pumch', campusId: 'campus-pumch-dongdan', departmentId: 'department-pumch-dermatology',
  matchMode: 'any_expert', doctorName: null, titles: [], dateFrom: '2026-07-20', dateTo: '2026-07-26', session: 'AM',
  eventTypes: ['availability_changed_to_available'], remindBeforeMinutes: 5, enabled: true, version: 1,
  createdAt: '2026-07-19T01:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z',
};

const event = {
  id: 'event-1', taskId: 'task-1', sourceId: 'pumch-public', eventType: 'availability_changed_to_available',
  slotKey: 'slot-1', fromState: 'unavailable', toState: 'available', evidence: 'explicit', detectedAt: '2026-07-19T01:10:00.000Z',
  payload: {
    officialEntryUrl: 'https://www.pumch.cn/register', date: '2026-07-22', session: 'AM', doctorName: null,
    title: '副主任医师', availability: 'available',
  },
};

describe('关注任务详情', () => {
  it('有真实事件时展示检测时间和官方入口，不把事件写成预约成功', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/watch-tasks/task-1') return jsonResponse(task);
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/events') return jsonResponse({ events: [event] });
      if (path === '/api/release-rules') return jsonResponse({ rules: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/task-1']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '检测记录出现有号变化' })).toBeInTheDocument();
    expect(screen.getByText(/检测时间/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往官方渠道核验（新标签页打开）' })).toHaveAttribute('href', event.payload.officialEntryUrl);
    expect(screen.queryByText('预约成功')).not.toBeInTheDocument();
  });
});
