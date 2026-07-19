import { describe, expect, it } from 'vitest';

import {
  browserAgentIngestSchema,
  deriveBrowserAgentIngest,
} from '../../../src/core/browser-agent.js';

const validPayload = {
  sourceId: 'browser-agent-hospital-pumch',
  requestId: 'browser-request-20260719-001',
  observedAt: '2026-07-19T00:00:00.000Z',
  observations: [
    {
      slotKey:
        'browser-agent:hospital-pumch:campus-pumch-dongdan:department-pumch-dermatology:2026-07-20:AM:%E5%8C%BB%E7%94%9F%E7%94%B2:%E4%B8%BB%E4%BB%BB%E5%8C%BB%E5%B8%88',
      hospitalId: 'hospital-pumch',
      campusId: 'campus-pumch-dongdan',
      departmentId: 'department-pumch-dermatology',
      date: '2026-07-20',
      session: 'AM' as const,
      doctorName: '医生甲',
      title: '主任医师',
      scheduleStatus: 'unknown' as const,
      availability: 'available' as const,
      officialEntryUrl: 'https://pumchapp.pumch.cn/',
      evidence: 'explicit' as const,
    },
  ],
};

describe('Browser Agent 服务端 payload 契约', () => {
  it('按首批 scope 服务端派生 sourceId 与 slotKey', () => {
    const parsed = browserAgentIngestSchema.parse(validPayload);

    expect(deriveBrowserAgentIngest(parsed)).toEqual(validPayload);
  });

  it.each([
    ['任意 sourceId', { sourceId: 'browser-agent-arbitrary' }],
    [
      '伪造 slotKey',
      {
        observations: [{ ...validPayload.observations[0], slotKey: 'attacker-controlled-slot' }],
      },
    ],
    [
      '错误 source-host mapping',
      {
        observations: [
          {
            ...validPayload.observations[0],
            officialEntryUrl: 'https://www.bjtrhos.cn/',
          },
        ],
      },
    ],
    [
      '非 origin 官方 URL',
      {
        observations: [
          {
            ...validPayload.observations[0],
            officialEntryUrl: 'https://pumchapp.pumch.cn/pages/pc/home/index?token=private',
          },
        ],
      },
    ],
    [
      'inferred evidence',
      {
        observations: [{ ...validPayload.observations[0], evidence: 'inferred' }],
      },
    ],
    [
      '非法状态组合 present+unknown',
      {
        observations: [
          {
            ...validPayload.observations[0],
            scheduleStatus: 'present',
            availability: 'unknown',
          },
        ],
      },
    ],
    [
      '非法状态组合 present+available',
      {
        observations: [
          {
            ...validPayload.observations[0],
            scheduleStatus: 'present',
            availability: 'available',
          },
        ],
      },
    ],
  ])('拒绝%s', (_label, patch) => {
    expect(browserAgentIngestSchema.safeParse({ ...validPayload, ...patch }).success).toBe(false);
  });

  it('拒绝一个 payload 混入多个医院 scope', () => {
    const mixed = {
      ...validPayload,
      observations: [
        ...validPayload.observations,
        {
          slotKey:
            'browser-agent:hospital-tongren:campus-tongren-chongwenmen:department-tongren-rhinology:2026-07-20:PM:*:*',
          hospitalId: 'hospital-tongren',
          campusId: 'campus-tongren-chongwenmen',
          departmentId: 'department-tongren-rhinology',
          date: '2026-07-20',
          session: 'PM',
          doctorName: null,
          title: null,
          scheduleStatus: 'unknown',
          availability: 'unknown',
          officialEntryUrl: 'https://www.bjtrhos.cn/',
          evidence: 'explicit',
        },
      ],
    };

    expect(browserAgentIngestSchema.safeParse(mixed).success).toBe(false);
  });

  it('只允许两个首批目标的完整 scope', () => {
    const wrongScope = {
      ...validPayload,
      sourceId: 'browser-agent-hospital-pumch',
      observations: [
        {
          ...validPayload.observations[0],
          departmentId: 'department-pumch-cardiology',
        },
      ],
    };

    expect(browserAgentIngestSchema.safeParse(wrongScope).success).toBe(false);
  });
});
