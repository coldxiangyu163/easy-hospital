// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      campuses: [
        {
          id: 'campus-pumch-dongdan',
          name: '东单院区',
          departments: [pumchDepartment],
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
          departments: [tongrenDepartment],
        },
      ],
    },
    {
      id: 'hospital-jishuitan',
      name: '北京积水潭医院',
      campuses: [
        {
          id: 'campus-jishuitan-xinjiekou',
          name: '新街口',
          departments: [
            catalogDepartment(
              'department-jishuitan-trauma-orthopedics',
              '创伤骨科',
              'target-jishuitan-trauma-orthopedics',
              'directory-only',
              false,
            ),
          ],
        },
        {
          id: 'campus-jishuitan-huilongguan',
          name: '回龙观',
          departments: [
            catalogDepartment(
              'department-jishuitan-burn-plastic-wound-repair',
              '烧伤整形与创面修复科',
              'target-jishuitan-burn-plastic-wound-repair',
              'directory-only',
              false,
            ),
          ],
        },
      ],
    },
    {
      id: 'hospital-anzhen',
      name: '北京安贞医院',
      campuses: [
        {
          id: 'campus-anzhen-chaoyang',
          name: '朝阳院区',
          departments: [
            catalogDepartment(
              'department-anzhen-coronary-heart-disease-center',
              '冠心病中心',
              'target-anzhen-coronary-heart-disease-center',
              'public-source',
              true,
            ),
            catalogDepartment(
              'department-anzhen-arrhythmia-center',
              '心律失常中心',
              'target-anzhen-arrhythmia-center',
              'public-source',
              true,
              20,
            ),
            catalogDepartment(
              'department-anzhen-cardiac-surgery',
              '心脏外科',
              'target-anzhen-cardiac-surgery',
              'directory-only',
              false,
              30,
            ),
          ],
        },
      ],
    },
  ],
};

const runtimeStatus = {
  dataDirectory: { display: '…/data' },
  sqlite: { status: 'healthy' },
  worker: { status: 'healthy', running: true },
  notifications: [],
  browserAgent: { configured: false, lastSeenAt: null },
  sourceCapabilities: [
    {
      key: 'pumch-public-dermatology-schedule',
      sourceId: 'source-pumch-public-schedule',
      accessClass: 'A',
      enabled: true,
      transport: 'fetch',
      minIntervalMs: 7_200_000,
      stability: 'stable',
      eventTypes: ['schedule_released'],
      bindings: [
        {
          targetId: 'target-pumch-dermatology',
          hospitalId: 'hospital-pumch',
          campusId: 'campus-pumch-dongdan',
          departmentId: 'department-pumch-dermatology',
          officialEntryUrl: 'https://www.pumch.cn/news_visitinfo.html',
        },
      ],
      capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
      runtime: null,
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
          targetId: 'target-anzhen-coronary-heart-disease-center',
          hospitalId: 'hospital-anzhen',
          campusId: 'campus-anzhen-chaoyang',
          departmentId: 'department-anzhen-coronary-heart-disease-center',
          officialEntryUrl: 'https://www.anzhen.org.cn/Html/Departments/Main/SearchIndex_118.html',
        },
        {
          targetId: 'target-anzhen-arrhythmia-center',
          hospitalId: 'hospital-anzhen',
          campusId: 'campus-anzhen-chaoyang',
          departmentId: 'department-anzhen-arrhythmia-center',
          officialEntryUrl: 'https://www.anzhen.org.cn/Html/Departments/Main/SearchIndex_118.html',
        },
      ],
      capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
      runtime: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('创建关注任务', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-27T01:00:00.000Z'));
  });

  it('按 catalog support 创建协和公开排班任务，不新增实时余号或退号事件', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return jsonResponse(runtimeStatus);
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdTask = {
          ...body,
          id: 'task-1', enabled: true, version: 1,
          createdAt: '2026-07-27T01:00:00.000Z', updatedAt: '2026-07-27T01:00:00.000Z',
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

    expect(await screen.findByRole('heading', { name: '新增一件关注' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '关注对象' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '匹配条件' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '目标就诊日期与时段' })).toBeInTheDocument();
    expect(screen.getByText('稳定公开排班来源')).toBeInTheDocument();
    expect(screen.queryByLabelText(/实验性 B 级/)).not.toBeInTheDocument();
    const technicalDetails = screen.getByText('技术详情').closest('details');
    expect(technicalDetails).not.toHaveAttribute('open');
    expect(technicalDetails).toHaveTextContent('target-pumch-dermatology');
    expect(technicalDetails).toHaveTextContent('source-pumch-public-schedule');
    expect(screen.getByRole('heading', { name: '这项提醒会怎样工作' })).toBeInTheDocument();
    expect(screen.getByText(/日期是希望就诊的目标日期/)).toBeInTheDocument();
    expect(screen.getByText(/首次检查只建立 baseline，不会补发已有排班/)).toBeInTheDocument();
    expect(screen.getByText(/不监测实时余号或退号，也不会自动预约/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开北京协和医院官网（不是预约入口，新标签页打开）' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-28' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-03' } });
    fireEvent.change(screen.getByLabelText('时段'), { target: { value: 'AM' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() =>
      expect(createdTask).toMatchObject({
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        dateFrom: '2026-07-28',
        dateTo: '2026-08-03',
        session: 'AM',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: null,
      }),
    );
    expect(await screen.findByRole('heading', { name: '北京协和医院 · 东单院区 · 皮肤科' })).toBeInTheDocument();
  });

  it('同仁 rules-only 由 target support 驱动，隐藏并规范化医生、职称与时段', async () => {
    let createdTask: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return jsonResponse(runtimeStatus);
      if (path === '/api/watch-tasks' && init?.method === 'POST') {
        createdTask = {
          ...(JSON.parse(String(init.body)) as Record<string, unknown>),
          id: 'task-rules', enabled: true, version: 1,
          createdAt: '2026-07-27T01:00:00.000Z', updatedAt: '2026-07-27T01:00:00.000Z',
        };
        return jsonResponse(createdTask, 201);
      }
      if (path === '/api/watch-tasks/task-rules') return jsonResponse(createdTask);
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
    expect(screen.getByText('规则提醒')).toBeInTheDocument();
    expect(screen.getByText(/规则提醒会按规则时间发送；规则标记为需复核时/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-28' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-03' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));

    await waitFor(() => expect(createdTask).toMatchObject({
      hospitalId: 'hospital-tongren',
      matchMode: 'any_expert',
      doctorName: null,
      titles: [],
      session: 'ANY',
      eventTypes: ['schedule_released'],
      remindBeforeMinutes: 5,
    }));
  });

  it('医院到院区到科室固定级联，directory-only 可打开 HTTPS 官网但不能提交', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return jsonResponse(runtimeStatus);
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-jishuitan' } });
    expect(screen.getByLabelText('院区')).toHaveValue('campus-jishuitan-xinjiekou');
    expect(screen.getByLabelText('科室')).toHaveValue('department-jishuitan-trauma-orthopedics');
    fireEvent.change(screen.getByLabelText('院区'), { target: { value: 'campus-jishuitan-huilongguan' } });
    expect(screen.getByLabelText('科室')).toHaveValue('department-jishuitan-burn-plastic-wound-repair');
    expect(screen.getByText('仅目录，待可靠公开来源')).toBeInTheDocument();
    expect(screen.queryByLabelText('开始日期')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并开始关注' })).toBeDisabled();
    expect(screen.getByText('当前不能创建提醒：这个科室还没有可可靠检查的公开排班或已确认规则。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开北京积水潭医院官网（不是预约入口，新标签页打开）' }))
      .toHaveAttribute('href', 'https://www.jst-hosp.com.cn/');
  });

  it('安贞只在两个 manifest target 展示 experimental public-source，其他科室仍 fail closed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return jsonResponse(runtimeStatus);
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    fireEvent.change(screen.getByLabelText('医院'), { target: { value: 'hospital-anzhen' } });
    expect(screen.getByLabelText('科室')).toHaveValue('department-anzhen-coronary-heart-disease-center');
    expect(screen.getByText('实验性公开排班来源')).toBeInTheDocument();
    expect(screen.getByText('技术详情').closest('details')).toHaveTextContent('source-anzhen-public-heart-center-schedule');
    expect(screen.getByRole('button', { name: '创建并开始关注' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('科室'), { target: { value: 'department-anzhen-arrhythmia-center' } });
    expect(screen.getByText('实验性公开排班来源')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并开始关注' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('科室'), { target: { value: 'department-anzhen-cardiac-surgery' } });
    expect(screen.getByText('仅目录，待可靠公开来源')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并开始关注' })).toBeDisabled();
  });

  it('在客户端阻止缺少日期和超过 14 天的提交，不放宽产品日期校验', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/catalog') return jsonResponse(catalog);
      if (path === '/api/runtime-status') return jsonResponse(runtimeStatus);
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: '新增一件关注' });
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('min', '2026-07-27');
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('max', '2026-08-10');
    fireEvent.change(screen.getByLabelText('关注范围'), { target: { value: 'doctor' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('请填写医生姓名。')).toBeInTheDocument();
    expect(screen.getByLabelText('医生姓名')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('请选择开始日期。')).toBeInTheDocument();
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('请选择结束日期。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('请修正下面标出的内容后再提交。');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-28' } });
    expect(screen.queryByText('请选择开始日期。')).not.toBeInTheDocument();
    expect(screen.getByLabelText('开始日期')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-03' } });
    expect(screen.queryByText('请选择结束日期。')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('医生姓名'), { target: { value: '张医生' } });
    expect(screen.queryByText('请填写医生姓名。')).not.toBeInTheDocument();
    expect(screen.getByLabelText('医生姓名')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);

    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-11' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并开始关注' }));
    expect(screen.getByText('日期范围最多为连续 14 天。')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });
});
