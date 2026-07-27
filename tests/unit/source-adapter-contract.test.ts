import { describe, expect, it } from 'vitest';

import {
  findSourceBinding,
  runSourceAdapter,
  type SourceAdapter,
} from '../../src/core/source-adapter.js';

const boundManifest = {
  adapterKey: 'fixture-bound-public',
  contractVersion: 1 as const,
  version: '1.0.0',
  accessClass: 'A' as const,
  transport: 'fetch' as const,
  allowedHosts: ['hospital.example'],
  minIntervalMs: 300_000,
  sourceId: 'source-bound-public',
  rateLimitKey: 'official-html:hospital.example',
  eventTypes: ['schedule_released'] as ['schedule_released'],
  stability: 'stable' as const,
  bindings: [
    {
      targetId: 'target-tongren-rhinology',
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      officialEntryUrl: 'https://hospital.example/appointment',
    },
  ],
};

const boundRequest = {
  requestId: 'request-bound',
  sourceId: 'source-bound-public',
  hospitalId: 'hospital-tongren',
  campusId: 'campus-tongren-chongwenmen',
  departmentId: 'department-tongren-rhinology',
  dateFrom: '2026-07-20',
  dateTo: '2026-07-26',
  doctorName: null,
  titles: [],
  session: 'ANY' as const,
  deadlineAt: '2026-07-19T00:00:30.000Z',
};

describe('SourceAdapter 契约 seam', () => {
  it('binding 查找把 targetId 与物理 scope 一并作为精确身份', () => {
    const physicalScope = {
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
    };

    expect(
      findSourceBinding(boundManifest, {
        ...physicalScope,
        targetId: 'target-wrong',
      }),
    ).toBeUndefined();
    expect(
      findSourceBinding(boundManifest, {
        ...physicalScope,
        targetId: 'target-tongren-rhinology',
      }),
    ).toMatchObject({ targetId: 'target-tongren-rhinology', ...physicalScope });
  });

  it('只接受规范化且可审计的 CheckResult', async () => {
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-public',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        return {
          status: 'OK',
          observedAt: '2026-07-19T00:00:00.000Z',
          nextAllowedAt: '2026-07-19T00:05:00.000Z',
          contentHash: 'a'.repeat(64),
          observations: [
            {
              slotKey: 'slot-1',
              hospitalId: 'hospital-tongren',
              campusId: 'campus-tongren-chongwenmen',
              departmentId: 'department-tongren-rhinology',
              date: '2026-07-20',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present',
              availability: 'available',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    const result = await runSourceAdapter(adapter, {
      requestId: 'request-1',
      sourceId: 'source-1',
      hospitalId: 'hospital-tongren',
      campusId: 'campus-tongren-chongwenmen',
      departmentId: 'department-tongren-rhinology',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-26',
      doctorName: null,
      titles: [],
      session: 'AM',
      deadlineAt: '2026-07-19T00:00:30.000Z',
    });

    expect(result.status).toBe('OK');
    expect(result.observations[0]).toMatchObject({
      slotKey: 'slot-1',
      availability: 'available',
    });
  });

  it('binding-aware manifest 拒绝跨 scope observation', async () => {
    const adapter: SourceAdapter = {
      manifest: boundManifest,
      async check() {
        return {
          status: 'OK',
          observedAt: '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: 'c'.repeat(64),
          observations: [
            {
              slotKey: 'cross-scope',
              hospitalId: 'hospital-tongren',
              campusId: 'campus-tongren-chongwenmen',
              departmentId: 'department-other',
              date: '2026-07-20',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present',
              availability: 'unknown',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    await expect(runSourceAdapter(adapter, boundRequest)).rejects.toThrow(
      'Observation 与请求 binding 范围不一致',
    );
  });

  it('公开排班 manifest 拒绝把状态图例或剩余字段解释为实时有号', async () => {
    const adapter: SourceAdapter = {
      manifest: boundManifest,
      async check() {
        return {
          status: 'OK',
          observedAt: '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: 'd'.repeat(64),
          observations: [
            {
              slotKey: 'not-realtime-availability',
              hospitalId: 'hospital-tongren',
              campusId: 'campus-tongren-chongwenmen',
              departmentId: 'department-tongren-rhinology',
              date: '2026-07-20',
              session: 'AM',
              doctorName: '示例医生',
              title: '主任医师',
              scheduleStatus: 'present',
              availability: 'available',
              officialEntryUrl: 'https://hospital.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    await expect(runSourceAdapter(adapter, boundRequest)).rejects.toThrow(
      '不能推断实时号源',
    );
  });

  it('拒绝 Adapter 返回白名单外的官方入口', async () => {
    const adapter: SourceAdapter = {
      manifest: {
        adapterKey: 'fixture-public',
        contractVersion: 1,
        version: '1.0.0',
        accessClass: 'A',
        transport: 'fetch',
        allowedHosts: ['hospital.example'],
        minIntervalMs: 300_000,
      },
      async check() {
        return {
          status: 'OK',
          observedAt: '2026-07-19T00:00:00.000Z',
          nextAllowedAt: null,
          contentHash: 'b'.repeat(64),
          observations: [
            {
              slotKey: 'slot-1',
              hospitalId: 'hospital-tongren',
              campusId: 'campus-tongren-chongwenmen',
              departmentId: 'department-tongren-rhinology',
              date: '2026-07-20',
              session: 'AM',
              doctorName: null,
              title: null,
              scheduleStatus: 'present',
              availability: 'available',
              officialEntryUrl: 'https://evil.example/appointment',
              evidence: 'explicit',
            },
          ],
        };
      },
    };

    await expect(
      runSourceAdapter(adapter, {
        requestId: 'request-2',
        sourceId: 'source-1',
        hospitalId: 'hospital-tongren',
        campusId: 'campus-tongren-chongwenmen',
        departmentId: 'department-tongren-rhinology',
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        doctorName: null,
        titles: [],
        session: 'ANY',
        deadlineAt: '2026-07-19T00:00:30.000Z',
      }),
    ).rejects.toThrow('官方入口域名不在 Adapter 白名单内');
  });
});
