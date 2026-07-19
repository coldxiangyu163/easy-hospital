import { z } from 'zod';

export const releaseRuleInputSchema = z.object({
  hospitalId: z.string().min(1),
  campusId: z.string().min(1),
  departmentId: z.string().min(1),
  advanceDays: z.number().int().min(0).max(60),
  releaseTimeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  sameDayPolicy: z.string().min(1).max(500),
  officialEntryUrl: z.url({ protocol: /^https$/ }),
  sourceUrl: z.url({ protocol: /^https$/ }),
  verifiedAt: z.iso.datetime(),
  confidence: z.enum(['high', 'medium', 'low']),
  needsReconfirmation: z.boolean().default(false),
});

export type ReleaseRuleInput = z.infer<typeof releaseRuleInputSchema>;

export const releaseRulePatchSchema = releaseRuleInputSchema
  .partial()
  .extend({
    enabled: z.boolean().optional(),
    // input schema 的 .default(false) 经 .partial() 后仍会在未传值时输出 false，
    // 导致任何 PATCH 都把 needsReconfirmation 静默清零；这里改为纯 optional，
    // 未显式传值时输出不含该键，由存储层保留原值。
    needsReconfirmation: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少提供一个要修改的字段');

export type ReleaseRulePatch = z.infer<typeof releaseRulePatchSchema>;

export type ReleaseRule = ReleaseRuleInput & {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
