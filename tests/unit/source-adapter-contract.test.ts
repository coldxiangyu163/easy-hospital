import { describe, expect, it } from 'vitest';

import {
  runSourceAdapter,
  type SourceAdapter,
} from '../../src/core/source-adapter.js';

describe('SourceAdapter 契约 seam', () => {
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
