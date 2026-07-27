// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import type { Catalog } from '../../src/ui/api.js';
import {
  catalogDepartment,
  pumchDepartment,
  tongrenDepartment,
} from '../support/ui-catalog.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const catalog: Catalog = {
  hospitals: [
    {
      id: 'hospital-pumch',
      name: '北京协和医院',
      campuses: [{ id: 'campus-pumch-dongdan', name: '东单院区', departments: [pumchDepartment] }],
    },
    {
      id: 'hospital-tongren',
      name: '北京同仁医院',
      campuses: [{ id: 'campus-tongren-chongwenmen', name: '崇文门院区', departments: [tongrenDepartment] }],
    },
    {
      id: 'hospital-anzhen',
      name: '北京安贞医院',
      campuses: [
        {
          id: 'campus-anzhen-chaoyang',
          name: '朝阳院区',
          departments: [
            catalogDepartment('department-anzhen-coronary-heart-disease-center', '冠心病中心', 'target-anzhen-coronary-heart-disease-center', 'public-source', true),
            catalogDepartment('department-anzhen-arrhythmia-center', '心律失常中心', 'target-anzhen-arrhythmia-center', 'public-source', true, 20),
            catalogDepartment('department-anzhen-cardiac-surgery', '心脏外科', 'target-anzhen-cardiac-surgery', 'directory-only', false, 30),
          ],
        },
      ],
    },
    {
      id: 'hospital-pkuph',
      name: '北京大学人民医院',
      campuses: [
        {
          id: 'campus-pkuph-xizhimen',
          name: '西直门',
          departments: [
            catalogDepartment('department-pkuph-hematology', '血液科', 'target-pkuph-hematology', 'directory-only', false),
          ],
        },
      ],
    },
  ],
};

const capabilities = [
  {
    key: 'decoy-a-source',
    sourceId: 'source-decoy',
    accessClass: 'A',
    enabled: true,
    transport: 'fetch',
    minIntervalMs: 300_000,
    stability: 'stable',
    eventTypes: ['schedule_released'],
    bindings: [{
      targetId: 'target-not-in-catalog', hospitalId: 'hospital-other', campusId: 'campus-other',
      departmentId: 'department-other', officialEntryUrl: 'https://other.example/',
    }],
    capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
    runtime: null,
  },
  {
    key: 'pumch-public-dermatology-schedule',
    sourceId: 'source-pumch-public-schedule',
    accessClass: 'A',
    enabled: true,
    transport: 'fetch',
    minIntervalMs: 7_200_000,
    stability: 'stable',
    eventTypes: ['schedule_released'],
    bindings: [{
      targetId: 'target-pumch-dermatology', hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan', departmentId: 'department-pumch-dermatology',
      officialEntryUrl: 'https://www.pumch.cn/news_visitinfo.html',
    }],
    capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
    runtime: {
      lastAttemptAt: '2026-07-27T08:10:00.000Z',
      lastSuccessAt: '2026-07-27T08:00:00.000Z',
      lastStatus: 'TEMPORARY_FAILURE',
      lastErrorCode: 'SOURCE_CHECK_FAILED',
    },
  },
  {
    key: 'anzhen-public-heart-center-schedule',
    sourceId: 'source-anzhen-public-heart-center-schedule',
    accessClass: 'A',
    enabled: true,
    transport: 'fetch',
    minIntervalMs: 43_200_000,
    stability: 'experimental',
    eventTypes: ['schedule_released'],
    bindings: [
      {
        targetId: 'target-anzhen-coronary-heart-disease-center', hospitalId: 'hospital-anzhen',
        campusId: 'campus-anzhen-chaoyang', departmentId: 'department-anzhen-coronary-heart-disease-center',
        officialEntryUrl: 'https://www.anzhen.org.cn/Html/Departments/Main/SearchIndex_118.html',
      },
      {
        targetId: 'target-anzhen-arrhythmia-center', hospitalId: 'hospital-anzhen',
        campusId: 'campus-anzhen-chaoyang', departmentId: 'department-anzhen-arrhythmia-center',
        officialEntryUrl: 'https://www.anzhen.org.cn/Html/Departments/Main/SearchIndex_118.html',
      },
    ],
    capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
    runtime: null,
  },
  {
    key: 'rules-only:target-tongren-rhinology',
    targetId: 'target-tongren-rhinology',
    accessClass: 'C',
    enabled: true,
    transport: 'rules-only',
    minIntervalMs: null,
    capabilities: { schedule: false, availability: false, cancellation: false, ruleReminder: true },
    runtime: null,
  },
  {
    key: 'browser-agent', accessClass: 'B', enabled: false,
    transport: 'local-agent', minIntervalMs: 300_000,
    capabilities: { schedule: false, availability: true, cancellation: true, ruleReminder: false },
    runtime: null,
  },
];

afterEach(cleanup);

describe('数据来源', () => {
  it('按精确 target binding/sourceId 展示 stable、experimental、rules-only 与 directory-only', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/health') return jsonResponse({ status: 'healthy', checks: { storage: { status: 'healthy' }, worker: { running: true } } });
      if (path === '/api/source-adapters/pumch-public-dermatology-schedule/live-probe') {
        return jsonResponse({
          status: 'OK', observedAt: '2026-07-27T08:00:00.000Z',
          nextAllowedAt: '2026-07-27T10:00:00.000Z', eventsCreated: 0,
        });
      }
      if (path === '/api/source-adapters') return jsonResponse({ adapters: capabilities });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '11 家医院，逐个 target 说明能力' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科' })).toBeInTheDocument();
    expect(screen.getByText('稳定公开排班来源')).toBeInTheDocument();
    expect(screen.getByText('source-pumch-public-schedule')).toBeInTheDocument();
    expect(screen.queryByText('source-decoy')).not.toBeInTheDocument();
    expect(screen.getByText(/最近检查不可用（SOURCE_CHECK_FAILED）/)).toBeInTheDocument();
    expect(screen.getByText(/上次成功：2026年7月27日 16:00/)).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: '北京同仁医院 · 崇文门院区 · 鼻科' })).toBeInTheDocument();
    expect(screen.getByText('规则提醒')).toBeInTheDocument();
    expect(screen.getByText('rules-only:target-tongren-rhinology')).toBeInTheDocument();

    const anzhenCoronary = screen.getByRole('heading', { name: '北京安贞医院 · 朝阳院区 · 冠心病中心' }).closest('article')!;
    const anzhenArrhythmia = screen.getByRole('heading', { name: '北京安贞医院 · 朝阳院区 · 心律失常中心' }).closest('article')!;
    expect(within(anzhenCoronary).getByText('实验性公开排班来源')).toBeInTheDocument();
    expect(within(anzhenArrhythmia).getByText('实验性公开排班来源')).toBeInTheDocument();
    expect(within(anzhenCoronary).getByText('source-anzhen-public-heart-center-schedule')).toBeInTheDocument();

    fireEvent.click(screen.getByText('北京大学人民医院'));
    const directoryRow = screen.getByRole('heading', { name: '北京大学人民医院 · 西直门 · 血液科' }).closest('article')!;
    expect(within(directoryRow).getByText('仅目录，待可靠公开来源')).toBeInTheDocument();
    expect(within(directoryRow).getByText('待可靠公开来源')).toBeInTheDocument();
    expect(within(directoryRow).getByRole('link', { name: '打开医院官方入口（新标签页打开）' }))
      .toHaveAttribute('href', 'https://www.pkuph.cn/');
    expect(within(directoryRow).queryByText(/已启用|来源已装配/)).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: '实验性本机 Browser Agent' })).toBeInTheDocument();
    expect(screen.getByText(/11 家目录不会自动扩大扩展 scope/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '自检 北京协和医院 东单院区 皮肤科 公开来源' }));
    expect(await screen.findByText('来源自检已完成；此次未发现新的公开排班记录。')).toBeInTheDocument();
  });

  it('来源限流时展示等待时间，不把 429 当作未知来源结果', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse({ hospitals: [catalog.hospitals[0]] });
      if (path === '/api/health') return jsonResponse({ status: 'healthy', checks: {} });
      if (path === '/api/source-adapters') return jsonResponse({ adapters: [capabilities[1]] });
      if (path === '/api/source-adapters/pumch-public-dermatology-schedule/live-probe') {
        return jsonResponse({ error: 'SOURCE_RATE_LIMITED', retryAfterMs: 300_000 }, 429);
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '11 家医院，逐个 target 说明能力' });
    fireEvent.click(screen.getByRole('button', { name: '自检 北京协和医院 东单院区 皮肤科 公开来源' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '来源检查过于频繁；请约 5 分钟后再试。本次结果不可用，也不代表无号。',
    );
  });
});
