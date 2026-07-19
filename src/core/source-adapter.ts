import { z } from 'zod';

const sourceManifestSchema = z.strictObject({
  adapterKey: z.string().min(1),
  contractVersion: z.literal(1),
  version: z.string().min(1),
  accessClass: z.enum(['A', 'B', 'C']),
  transport: z.enum(['fetch', 'playwright', 'rules-only']),
  allowedHosts: z.array(z.string().min(1)).min(1),
  minIntervalMs: z.number().int().min(300_000),
});

export const checkRequestSchema = z.strictObject({
  requestId: z.string().min(1),
  sourceId: z.string().min(1),
  hospitalId: z.string().min(1),
  campusId: z.string().min(1).nullable(),
  departmentId: z.string().min(1),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  doctorName: z.string().min(1).nullable(),
  titles: z.array(z.string().min(1)),
  session: z.enum(['ANY', 'AM', 'PM']),
  deadlineAt: z.iso.datetime(),
});

export const observationSchema = z.strictObject({
  slotKey: z.string().min(1),
  hospitalId: z.string().min(1),
  campusId: z.string().min(1),
  departmentId: z.string().min(1),
  date: z.iso.date(),
  session: z.enum(['AM', 'PM']),
  doctorName: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  scheduleStatus: z.enum(['absent', 'present', 'unknown']),
  availability: z.enum(['available', 'unavailable', 'unknown']),
  officialEntryUrl: z.url({ protocol: /^https$/ }),
  evidence: z.enum(['explicit', 'inferred']),
});

export const checkResultSchema = z.strictObject({
  status: z.enum([
    'OK',
    'PARTIAL',
    'AUTH_REQUIRED',
    'RATE_LIMITED',
    'SOURCE_CHANGED',
    'UNSUPPORTED',
    'TEMPORARY_FAILURE',
  ]),
  observedAt: z.iso.datetime(),
  nextAllowedAt: z.iso.datetime().nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  observations: z.array(observationSchema),
  errorCode: z.string().min(1).optional(),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type CheckRequest = z.infer<typeof checkRequestSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;

export interface SourceAdapter {
  readonly manifest: SourceManifest;
  check(request: CheckRequest): Promise<CheckResult>;
}

export class SourceAdapterDeadlineError extends Error {
  readonly code = 'SOURCE_ADAPTER_DEADLINE_EXCEEDED';

  constructor(readonly deadlineAt: string) {
    super(`来源检查超过契约时限 ${deadlineAt}`);
    this.name = 'SourceAdapterDeadlineError';
  }
}

// 契约层兜底：adapter 实现可能忽略 request.deadlineAt（deadline 至今只是
// 约定参数），一个卡死的 check 会拖停单进程 worker 并让 shutdown 无限等待。
// 这里只在「尚有剩余时间」时武装超时；deadlineAt 已过期的调用保持既有语义，
// 交由 adapter 自诊断（如 pumch 返回 PUMCH_DEADLINE_EXCEEDED），不在契约层抛错。
async function checkWithContractDeadline(
  adapter: SourceAdapter,
  input: CheckRequest,
): Promise<CheckResult> {
  const deadlineMs = Date.parse(input.deadlineAt);
  const remainingMs = deadlineMs - Date.now();
  if (!Number.isFinite(deadlineMs) || remainingMs <= 0) {
    return adapter.check(input);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promise.race 在创建时已为双方注册 settled 处理：超时胜出后 adapter 迟到的
  // resolve/reject 都会被既有 handler 吸收，不会产生未处理 rejection。
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SourceAdapterDeadlineError(input.deadlineAt)),
      remainingMs,
    );
  });
  try {
    return await Promise.race([adapter.check(input), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runSourceAdapter(
  adapter: SourceAdapter,
  request: CheckRequest,
): Promise<CheckResult> {
  const manifest = sourceManifestSchema.parse(adapter.manifest);
  const input = checkRequestSchema.parse(request);
  const result = checkResultSchema.parse(await checkWithContractDeadline(adapter, input));

  for (const observation of result.observations) {
    const hostname = new URL(observation.officialEntryUrl).hostname;
    if (!manifest.allowedHosts.includes(hostname)) {
      throw new Error('官方入口域名不在 Adapter 白名单内');
    }
  }

  return result;
}
