import { describe, expect, it } from 'vitest';

import {
  runSourceAdapter,
  SourceAdapterDeadlineError,
  type CheckRequest,
  type SourceAdapter,
} from '../../src/core/source-adapter.js';

// 契约层 deadline 兜底：adapter 可能忽略 request.deadlineAt，卡死的 check 不允许
// 拖停单进程 worker。超时后 adapter 迟到的 settle 不得产生未处理 rejection
// （vitest 默认把未处理 rejection 判为失败，本文件通过即证明）。
describe('runSourceAdapter 契约层 deadline', () => {
  const manifest: SourceAdapter['manifest'] = {
    adapterKey: 'fixture-deadline',
    contractVersion: 1,
    version: '1.0.0',
    accessClass: 'A',
    transport: 'fetch',
    allowedHosts: ['hospital.example'],
    minIntervalMs: 300_000,
  };

  const makeRequest = (deadlineAt: string): CheckRequest => ({
    requestId: 'deadline-request',
    sourceId: 'source-deadline',
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
    dateFrom: '2026-07-20',
    dateTo: '2026-07-26',
    doctorName: null,
    titles: [],
    session: 'ANY',
    deadlineAt,
  });

  it('adapter 忽略 deadline 卡死时按 deadlineAt 抛 SourceAdapterDeadlineError', async () => {
    const hanging: SourceAdapter = {
      manifest,
      check: () => new Promise(() => undefined), // 永不 settle
    };
    const startedAt = Date.now();
    const error = await runSourceAdapter(
      hanging,
      makeRequest(new Date(startedAt + 150).toISOString()),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceAdapterDeadlineError);
    expect((error as SourceAdapterDeadlineError).code).toBe('SOURCE_ADAPTER_DEADLINE_EXCEEDED');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('超时后 adapter 迟到 reject 不产生未处理 rejection，调用方仍拿到 deadline 错误', async () => {
    const lateRejecting: SourceAdapter = {
      manifest,
      check: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('adapter-late-failure')), 300);
        }),
    };
    const error = await runSourceAdapter(
      lateRejecting,
      makeRequest(new Date(Date.now() + 100).toISOString()),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceAdapterDeadlineError);
    await new Promise((resolve) => setTimeout(resolve, 400)); // 让迟到 reject 发生
  });

  it('deadlineAt 已过期时不武装超时，保持 adapter 自诊断的既有语义', async () => {
    const selfDiagnosing: SourceAdapter = {
      manifest,
      async check() {
        return {
          status: 'TEMPORARY_FAILURE',
          observedAt: new Date().toISOString(),
          nextAllowedAt: null,
          contentHash: 'c'.repeat(64),
          observations: [],
          errorCode: 'PUMCH_DEADLINE_EXCEEDED',
        };
      },
    };
    const result = await runSourceAdapter(
      selfDiagnosing,
      makeRequest(new Date(Date.now() - 1_000).toISOString()),
    );
    expect(result).toMatchObject({ status: 'TEMPORARY_FAILURE', errorCode: 'PUMCH_DEADLINE_EXCEEDED' });
  });

  it('adapter 在 deadline 前正常返回时结果原样透传', async () => {
    const healthy: SourceAdapter = {
      manifest,
      async check() {
        return {
          status: 'OK',
          observedAt: new Date().toISOString(),
          nextAllowedAt: null,
          contentHash: 'd'.repeat(64),
          observations: [],
        };
      },
    };
    const result = await runSourceAdapter(
      healthy,
      makeRequest(new Date(Date.now() + 30_000).toISOString()),
    );
    expect(result.status).toBe('OK');
  });
});
