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

    expect(await screen.findByRole('heading', { name: '4 个科室可创建提醒' })).toBeInTheDocument();
    expect(screen.getByText('可创建提醒')).toBeInTheDocument();
    expect(screen.getByText('4', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('仅目录')).toBeInTheDocument();
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科' })).toBeInTheDocument();
    expect(screen.getByText('可关注公开排班')).toBeInTheDocument();
    const sourceAudit = screen.getByText('source-pumch-public-schedule').closest('details');
    expect(sourceAudit).not.toHaveAttribute('open');
    expect(sourceAudit).toHaveTextContent('pumch-public-dermatology-schedule');
    expect(sourceAudit).toHaveTextContent('target-pumch-dermatology');
    expect(sourceAudit).toHaveTextContent('stable');
    expect(screen.queryByText('source-decoy')).not.toBeInTheDocument();
    expect(screen.getByText(/最近检查不可用；上次成功：2026年7月27日 16:00/)).toBeInTheDocument();
    expect(sourceAudit).toHaveTextContent('SOURCE_CHECK_FAILED');

    expect(screen.getByRole('heading', { name: '北京同仁医院 · 崇文门院区 · 鼻科' })).toBeInTheDocument();
    expect(screen.getByText('仅规则提醒')).toBeInTheDocument();
    expect(screen.getByText('rules-only:target-tongren-rhinology').closest('details')).not.toHaveAttribute('open');

    const anzhenCoronary = screen.getByRole('heading', { name: '北京安贞医院 · 朝阳院区 · 冠心病中心' }).closest('article')!;
    const anzhenArrhythmia = screen.getByRole('heading', { name: '北京安贞医院 · 朝阳院区 · 心律失常中心' }).closest('article')!;
    expect(within(anzhenCoronary).getByText('实验支持')).toBeInTheDocument();
    expect(within(anzhenArrhythmia).getByText('实验支持')).toBeInTheDocument();
    expect(within(anzhenCoronary).getByText('已装配，尚无检查记录').className).toContain('statusWarning');
    expect(within(anzhenArrhythmia).getByText('已装配，尚无检查记录')).toBeInTheDocument();
    expect(within(anzhenCoronary).queryByText('公开来源正在运行')).not.toBeInTheDocument();
    expect(within(anzhenCoronary).getByText('source-anzhen-public-heart-center-schedule').closest('details')).not.toHaveAttribute('open');

    expect(screen.queryByRole('heading', { name: '北京大学人民医院 · 西直门 · 血液科' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '显示其余 2 个目录目标' }));
    const directoryRow = screen.getByRole('heading', { name: '北京大学人民医院 · 西直门 · 血液科' }).closest('article')!;
    expect(within(directoryRow).getByText('暂不支持提醒')).toBeInTheDocument();
    expect(within(directoryRow).getByText('待可靠公开来源')).toBeInTheDocument();
    expect(within(directoryRow).getByRole('link', { name: '打开医院官网或科室页（新标签页打开）' }))
      .toHaveAttribute('href', 'https://www.pkuph.cn/');
    expect(within(directoryRow).queryByText(/已启用|来源已装配/)).not.toBeInTheDocument();

    const browserDetails = screen.getByText('本机页面读取技术详情').closest('details');
    expect(browserDetails).not.toHaveAttribute('open');
    expect(browserDetails).toHaveTextContent('Browser Agent');
    expect(browserDetails).toHaveTextContent('browser-agent');

    expect(screen.getAllByText(/会访问医院公开网络，结果可能写入事件和通知记录；失败不代表无号/)).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '立即检查并记录北京协和医院东单院区皮肤科的新变化' }));
    expect(await screen.findByText('检查已完成；此次未发现新的公开排班记录。')).toBeInTheDocument();
  });

  it.each([
    {
      lastStatus: 'PARTIAL',
      statusText: '仅完成部分检查',
      detailText: /仅完成部分检查；上次成功：2026年7月27日 16:00/,
      statusClass: 'statusWarning',
      detailClass: 'probeError',
    },
    {
      lastStatus: 'OK',
      statusText: '最近检查成功',
      detailText: /最近检查成功；上次成功：2026年7月27日 16:00/,
      statusClass: 'statusGood',
      detailClass: 'probeResult',
    },
  ])('$lastStatus 如实显示检查结果并保留上次成功时间', async ({
    lastStatus,
    statusText,
    detailText,
    statusClass,
    detailClass,
  }) => {
    const runtimeCapability = {
      ...capabilities[1],
      runtime: {
        lastAttemptAt: '2026-07-27T08:10:00.000Z',
        lastSuccessAt: '2026-07-27T08:00:00.000Z',
        lastStatus,
        lastErrorCode: lastStatus === 'PARTIAL' ? 'SOURCE_PARTIAL' : null,
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse({ hospitals: [catalog.hospitals[0]] });
      if (path === '/api/health') return jsonResponse({ status: 'healthy', checks: {} });
      if (path === '/api/source-adapters') return jsonResponse({ adapters: [runtimeCapability] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources']}>
        <App />
      </MemoryRouter>,
    );

    const row = (await screen.findByRole('heading', {
      name: '北京协和医院 · 东单院区 · 皮肤科',
    })).closest('article')!;
    expect(within(row).getByText(statusText).className).toContain(statusClass);
    expect(within(row).getByText(detailText).className).toContain(detailClass);
  });

  it('禁用公开来源且缺少 rules-only capability 时不计入当前可创建数量', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') {
        return jsonResponse({ hospitals: [catalog.hospitals[0], catalog.hospitals[1]] });
      }
      if (path === '/api/health') return jsonResponse({ status: 'healthy', checks: {} });
      if (path === '/api/source-adapters') {
        return jsonResponse({ adapters: [{ ...capabilities[1], enabled: false }] });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/sources']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: '0 个科室可创建提醒' })).toBeInTheDocument();
    expect(screen.getByText('可创建提醒').nextElementSibling).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: '显示其余 2 个目录目标' }));
    const publicRow = screen.getByRole('heading', {
      name: '北京协和医院 · 东单院区 · 皮肤科',
    }).closest('article')!;
    const rulesRow = screen.getByRole('heading', {
      name: '北京同仁医院 · 崇文门院区 · 鼻科',
    }).closest('article')!;
    expect(within(publicRow).getByText('本次运行未启用')).toBeInTheDocument();
    expect(within(rulesRow).getByText('本次运行未启用')).toBeInTheDocument();
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

    await screen.findByRole('heading', { name: '1 个科室可创建提醒' });
    fireEvent.click(screen.getByRole('button', { name: '立即检查并记录北京协和医院东单院区皮肤科的新变化' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '来源检查过于频繁；请约 5 分钟后再试。本次结果不可用，也不代表无号。',
    );
  });
});
