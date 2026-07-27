// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { pumchCatalog as catalog } from '../support/ui-catalog.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

afterEach(cleanup);

describe('管理关注任务', () => {
  it('通过 API 暂停并确认删除，删除后显示真实空状态', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/watch-tasks' && !init?.method) return jsonResponse({ tasks: [task] });
      if (path === '/api/watch-tasks/task-1' && init?.method === 'PATCH') {
        return jsonResponse({ ...task, enabled: false, version: 2 });
      }
      if (path === '/api/watch-tasks/task-1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '你正在关注的事' })).toBeInTheDocument();
    const target = '北京协和医院 · 东单院区 · 皮肤科';
    expect(screen.getByRole('link', { name: target })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `暂停关注 ${target}` }));
    expect(await screen.findByText('已暂停')).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1]?.body))).toEqual({
      version: 1,
      enabled: false,
    });

    const deleteButton = screen.getByRole('button', { name: `删除关注 ${target}` });
    fireEvent.click(deleteButton);
    const dialog = screen.getByRole('dialog', { name: '删除这项关注？' });
    const keepButton = screen.getByRole('button', { name: '保留任务' });
    const confirmButton = screen.getByRole('button', { name: '确认删除' });
    expect(dialog).toHaveTextContent(target);
    await waitFor(() => expect(keepButton).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(keepButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(deleteButton).toHaveFocus());

    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: '还没有关注任务' })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/watch-tasks/task-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('提醒能力不可用时用患者语言说明不能恢复', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse({ hospitals: [] });
      if (path === '/api/watch-tasks') return jsonResponse({ tasks: [{ ...task, enabled: false }] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('当前暂不支持恢复提醒；既有记录仍可查看。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /恢复关注/ })).toHaveAttribute(
      'title',
      '当前提醒能力不允许恢复',
    );
    expect(document.body).not.toHaveTextContent('target');
  });
});
