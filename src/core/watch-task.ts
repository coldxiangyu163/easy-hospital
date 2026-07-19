import { z } from 'zod';

export const eventTypeSchema = z.enum([
  'schedule_released',
  'availability_changed_to_available',
  'cancellation_slot_detected',
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const watchTaskInputSchema = z
  .object({
    hospitalId: z.string().min(1),
    campusId: z.string().min(1).nullable(),
    departmentId: z.string().min(1),
    matchMode: z.enum(['any_expert', 'title', 'doctor']),
    doctorName: z.string().trim().min(1).nullable(),
    titles: z.array(z.string().trim().min(1)).max(10),
    dateFrom: z.iso.date(),
    dateTo: z.iso.date(),
    session: z.enum(['ANY', 'AM', 'PM']),
    eventTypes: z.array(eventTypeSchema).min(1),
    remindBeforeMinutes: z.number().int().min(0).max(120).nullable(),
  })
  .superRefine((value, context) => {
    if (value.dateTo < value.dateFrom) {
      context.addIssue({ code: 'custom', path: ['dateTo'], message: '结束日期不能早于开始日期' });
    }
    const rangeDays = (Date.parse(value.dateTo) - Date.parse(value.dateFrom)) / 86_400_000 + 1;
    if (rangeDays > 14) {
      context.addIssue({ code: 'custom', path: ['dateTo'], message: '关注范围最多连续 14 天' });
    }
    if (value.matchMode === 'doctor' && !value.doctorName) {
      context.addIssue({ code: 'custom', path: ['doctorName'], message: '指定医生时必须填写医生姓名' });
    }
    if (value.matchMode === 'title' && value.titles.length === 0) {
      context.addIssue({ code: 'custom', path: ['titles'], message: '按职称关注时至少选择一个职称' });
    }
  });

export type WatchTaskInput = z.infer<typeof watchTaskInputSchema>;

function addUtcDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validateWatchTaskDateWindow(
  input: Pick<WatchTaskInput, 'dateFrom' | 'dateTo'>,
  now: number,
): Array<{ path: ['dateFrom'] | ['dateTo']; message: string }> {
  const today = new Date(now + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const latest = addUtcDays(today, 14);
  const issues: Array<{ path: ['dateFrom'] | ['dateTo']; message: string }> = [];
  if (input.dateFrom < today) {
    issues.push({ path: ['dateFrom'], message: '开始日期不能早于北京时间今天' });
  }
  if (input.dateTo > latest) {
    issues.push({ path: ['dateTo'], message: '结束日期不能晚于北京时间今天加 14 天' });
  }
  return issues;
}

export const watchTaskPatchSchema = z.object({
  version: z.number().int().positive(),
  enabled: z.boolean().optional(),
  hospitalId: z.string().min(1).optional(),
  campusId: z.string().min(1).nullable().optional(),
  departmentId: z.string().min(1).optional(),
  matchMode: z.enum(['any_expert', 'title', 'doctor']).optional(),
  doctorName: z.string().trim().min(1).nullable().optional(),
  titles: z.array(z.string().trim().min(1)).max(10).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  session: z.enum(['ANY', 'AM', 'PM']).optional(),
  eventTypes: z.array(eventTypeSchema).min(1).optional(),
  remindBeforeMinutes: z.number().int().min(0).max(120).nullable().optional(),
});

export type WatchTaskPatch = z.infer<typeof watchTaskPatchSchema>;

export type WatchTask = WatchTaskInput & {
  id: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
