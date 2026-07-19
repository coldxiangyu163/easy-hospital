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

export async function runSourceAdapter(
  adapter: SourceAdapter,
  request: CheckRequest,
): Promise<CheckResult> {
  const manifest = sourceManifestSchema.parse(adapter.manifest);
  const input = checkRequestSchema.parse(request);
  const result = checkResultSchema.parse(await adapter.check(input));

  for (const observation of result.observations) {
    const hostname = new URL(observation.officialEntryUrl).hostname;
    if (!manifest.allowedHosts.includes(hostname)) {
      throw new Error('官方入口域名不在 Adapter 白名单内');
    }
  }

  return result;
}
