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
  .extend({ enabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, '至少提供一个要修改的字段');

export type ReleaseRulePatch = z.infer<typeof releaseRulePatchSchema>;

export type ReleaseRule = ReleaseRuleInput & {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
