export const targetSupportModes = [
  'public-source',
  'browser-agent',
  'rules-only',
  'directory-only',
] as const;

export type TargetSupportMode = (typeof targetSupportModes)[number];

export type TargetSupport = {
  active: boolean;
  sortOrder: number;
  supportMode: TargetSupportMode;
  canCreateWatchTask: boolean;
};

type WatchTaskPolicyInput = {
  matchMode: 'any_expert' | 'title' | 'doctor';
  doctorName: string | null;
  titles: string[];
  session: 'ANY' | 'AM' | 'PM';
  eventTypes: string[];
  remindBeforeMinutes: number | null;
};

export function normalizeTargetSupport(input: TargetSupport): TargetSupport {
  return {
    ...input,
    canCreateWatchTask:
      input.active && input.supportMode !== 'directory-only' && input.canCreateWatchTask,
  };
}

export function watchTaskAllowedByTarget(
  support: TargetSupport,
  input: WatchTaskPolicyInput,
): boolean {
  const effective = normalizeTargetSupport(support);
  if (!effective.canCreateWatchTask) return false;
  if (effective.supportMode !== 'rules-only') return true;

  return (
    input.matchMode === 'any_expert' &&
    input.doctorName === null &&
    input.titles.length === 0 &&
    input.session === 'ANY' &&
    input.eventTypes.length === 1 &&
    input.eventTypes[0] === 'schedule_released' &&
    input.remindBeforeMinutes !== null
  );
}

export function targetSupportsRuleReminders(support: TargetSupport): boolean {
  const effective = normalizeTargetSupport(support);
  return effective.canCreateWatchTask && effective.supportMode === 'rules-only';
}
