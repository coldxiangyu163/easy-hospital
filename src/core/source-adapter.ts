import { z } from 'zod';

const sourceBindingSchema = z.strictObject({
  targetId: z.string().min(1),
  hospitalId: z.string().min(1),
  campusId: z.string().min(1),
  departmentId: z.string().min(1),
  officialEntryUrl: z.url({ protocol: /^https$/ }),
});

const sourceManifestSchema = z
  .strictObject({
    adapterKey: z.string().min(1),
    contractVersion: z.literal(1),
    version: z.string().min(1),
    accessClass: z.enum(['A', 'B', 'C']),
    transport: z.enum(['fetch', 'playwright', 'rules-only']),
    allowedHosts: z.array(z.string().min(1)).min(1),
    minIntervalMs: z.number().int().min(300_000),
    // 下列字段是 binding-aware v1 manifest。暂时保留全字段缺省兼容，仅供旧测试
    // fixture/第三方 adapter 迁移；内置官方来源全部声明这些字段，调度也只认 bindings。
    sourceId: z.string().min(1).optional(),
    rateLimitKey: z.string().min(1).optional(),
    eventTypes: z.array(z.literal('schedule_released')).length(1).optional(),
    stability: z.enum(['stable', 'experimental']).optional(),
    bindings: z.array(sourceBindingSchema).min(1).optional(),
  })
  .superRefine((manifest, context) => {
    const bindingFields = [
      manifest.sourceId,
      manifest.rateLimitKey,
      manifest.eventTypes,
      manifest.stability,
      manifest.bindings,
    ];
    if (bindingFields.some((value) => value !== undefined) && bindingFields.some((value) => value === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'binding-aware manifest 字段必须同时声明',
      });
      return;
    }
    if (!manifest.bindings) return;

    const targetIds = new Set<string>();
    const scopes = new Set<string>();
    for (const binding of manifest.bindings) {
      const hostname = new URL(binding.officialEntryUrl).hostname;
      if (!manifest.allowedHosts.includes(hostname)) {
        context.addIssue({
          code: 'custom',
          message: 'binding 官方入口域名不在 Adapter 白名单内',
        });
      }
      const scopeKey = JSON.stringify([
        binding.hospitalId,
        binding.campusId,
        binding.departmentId,
      ]);
      if (targetIds.has(binding.targetId) || scopes.has(scopeKey)) {
        context.addIssue({
          code: 'custom',
          message: 'binding targetId 与 scope 必须唯一',
        });
      }
      targetIds.add(binding.targetId);
      scopes.add(scopeKey);
    }
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
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type BoundSourceManifest = SourceManifest & {
  sourceId: string;
  rateLimitKey: string;
  eventTypes: ['schedule_released'];
  stability: 'stable' | 'experimental';
  bindings: SourceBinding[];
};
export type CheckRequest = z.infer<typeof checkRequestSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;

export interface SourceAdapter {
  readonly manifest: SourceManifest;
  check(request: CheckRequest): Promise<CheckResult>;
}

export function isBoundSourceManifest(manifest: SourceManifest): manifest is BoundSourceManifest {
  return (
    manifest.sourceId !== undefined &&
    manifest.rateLimitKey !== undefined &&
    manifest.eventTypes !== undefined &&
    manifest.stability !== undefined &&
    manifest.bindings !== undefined
  );
}

export function findSourceBinding(
  manifest: SourceManifest,
  scope: Pick<CheckRequest, 'hospitalId' | 'campusId' | 'departmentId'> & {
    targetId?: string;
  },
): SourceBinding | undefined {
  if (!isBoundSourceManifest(manifest) || scope.campusId === null) return undefined;
  return manifest.bindings.find(
    (binding) =>
      (scope.targetId === undefined || binding.targetId === scope.targetId) &&
      binding.hospitalId === scope.hospitalId &&
      binding.campusId === scope.campusId &&
      binding.departmentId === scope.departmentId,
  );
}

export function sourceRateLimitKey(manifest: SourceManifest): string {
  return isBoundSourceManifest(manifest) ? manifest.rateLimitKey : manifest.adapterKey;
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

  const binding = findSourceBinding(manifest, input);
  if (isBoundSourceManifest(manifest) && input.sourceId !== manifest.sourceId) {
    if (result.observations.length > 0) throw new Error('Adapter sourceId 与请求不一致');
  }
  if (isBoundSourceManifest(manifest) && !binding && result.observations.length > 0) {
    throw new Error('Adapter 请求范围不属于 manifest binding');
  }
  if (!['OK', 'PARTIAL'].includes(result.status) && result.observations.length > 0) {
    throw new Error('诊断结果不得携带 observation');
  }

  for (const observation of result.observations) {
    const hostname = new URL(observation.officialEntryUrl).hostname;
    if (!manifest.allowedHosts.includes(hostname)) {
      throw new Error('官方入口域名不在 Adapter 白名单内');
    }
    if (
      binding &&
      (observation.hospitalId !== binding.hospitalId ||
        observation.campusId !== binding.campusId ||
        observation.departmentId !== binding.departmentId)
    ) {
      throw new Error('Observation 与请求 binding 范围不一致');
    }
    if (binding && observation.officialEntryUrl !== binding.officialEntryUrl) {
      throw new Error('Observation 官方入口与 binding 不一致');
    }
    if (
      observation.date < input.dateFrom ||
      observation.date > input.dateTo ||
      (input.session !== 'ANY' && observation.session !== input.session) ||
      (input.doctorName !== null && observation.doctorName !== input.doctorName) ||
      (input.titles.length > 0 &&
        (observation.title === null || !input.titles.includes(observation.title)))
    ) {
      throw new Error('Observation 超出 CheckRequest 过滤范围');
    }
    if (
      isBoundSourceManifest(manifest) &&
      (observation.scheduleStatus !== 'present' ||
        observation.availability !== 'unknown' ||
        observation.evidence !== 'explicit')
    ) {
      throw new Error('公开排班 Adapter 只能返回明确排班，不能推断实时号源');
    }
  }

  return result;
}
