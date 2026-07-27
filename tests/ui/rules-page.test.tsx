// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { supportedCatalog as catalog } from '../support/ui-catalog.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const rule = {
  id: 'rule-1',
  hospitalId: 'hospital-tongren',
  campusId: 'campus-tongren-chongwenmen',
  departmentId: 'department-tongren-rhinology',
  advanceDays: 7,
  releaseTimeLocal: '08:00',
  sameDayPolicy: '医院说明另载每日 07:00 开放当日剩余号，以官方页面为准',
  officialEntryUrl: 'https://www.bjtrhos.cn/Html/News/Articles/7104.html',
  sourceUrl: 'https://news.bjd.com.cn/2024/07/02/10822953.shtml',
  verifiedAt: '2026-07-18T09:20:00.000Z',
  confidence: 'high',
  enabled: true,
  createdAt: '2026-07-18T09:20:00.000Z',
  updatedAt: '2026-07-18T09:20:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('规则与日历', () => {
  it('只展示 API 规则，并把推算日期与官方确认边界放在一起', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/release-rules') return jsonResponse({ rules: [rule] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/rules']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '什么时候值得看' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '北京同仁医院 · 崇文门院区 · 鼻科' })).toBeInTheDocument();
    expect(screen.getByText('08:00', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('提前 7 天')).toBeInTheDocument();
    expect(screen.getByText('按本产品提醒时间推算，需在官方渠道确认')).toBeInTheDocument();
    const supplement = screen.getByText('医院说明补充').closest('section');
    expect(supplement).toHaveTextContent('每日 07:00');
    expect(supplement).toHaveTextContent('本产品未据此安排提醒');
    expect(screen.getAllByText('08:00')).toHaveLength(15);
    expect(document.querySelectorAll('time[datetime]')).toHaveLength(14);
    expect(screen.getAllByRole('listitem', {
      name: /^提醒日期 .+、提醒时间 08:00、目标就诊日期 .+$/,
    })).toHaveLength(14);
    expect(screen.getByRole('link', { name: '查看医院规则说明（新标签页打开）' })).toHaveAttribute(
      'href',
      rule.officialEntryUrl,
    );
    expect(screen.getByRole('link', { name: '查看医院规则说明（新标签页打开）' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: '查看佐证来源（新标签页打开）' })).toHaveAttribute('href', rule.sourceUrl);
  });

  it('北京时间凌晨的可见日期与机器可读 dateTime 保持同一天', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-18T16:30:00.000Z'));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/release-rules') return jsonResponse({ rules: [rule] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/rules']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '什么时候值得看' });
    const firstDate = document.querySelector('time');
    expect(firstDate).toHaveAttribute('datetime', '2026-07-19');
    expect(firstDate).toHaveTextContent('7月19日');
    expect(screen.getByRole('listitem', {
      name: '提醒日期 7月19日周日、提醒时间 08:00、目标就诊日期 7月26日周日',
    })).toBeInTheDocument();
  });
});
