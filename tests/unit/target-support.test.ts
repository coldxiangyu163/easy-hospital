import { describe, expect, it } from 'vitest';

import {
  watchTaskAllowedByTarget,
  type TargetSupport,
} from '../../src/core/target-support.js';
import { supportPresentation } from '../../src/ui/catalog.js';
import type { SourceCapability } from '../../src/ui/api.js';

const rulesOnly: TargetSupport = {
  active: true,
  sortOrder: 10,
  supportMode: 'rules-only',
  canCreateWatchTask: true,
};

const ruleReminderTask = {
  matchMode: 'any_expert' as const,
  doctorName: null,
  titles: [],
  session: 'ANY' as const,
  eventTypes: ['schedule_released'],
  remindBeforeMinutes: 5,
};

describe('target support 任务策略', () => {
  it('rules-only 只允许无医生/职称/时段的规则提醒', () => {
    expect(watchTaskAllowedByTarget(rulesOnly, ruleReminderTask)).toBe(true);
    expect(
      watchTaskAllowedByTarget(rulesOnly, {
        ...ruleReminderTask,
        matchMode: 'doctor',
        doctorName: '测试医生',
      }),
    ).toBe(false);
    expect(
      watchTaskAllowedByTarget(rulesOnly, {
        ...ruleReminderTask,
        eventTypes: ['availability_changed_to_available'],
      }),
    ).toBe(false);
  });

  it.each([
    { ...rulesOnly, active: false },
    { ...rulesOnly, canCreateWatchTask: false },
    { ...rulesOnly, supportMode: 'directory-only' as const },
  ])('inactive、不可创建和仅目录目标均拒绝创建任务', (support) => {
    expect(watchTaskAllowedByTarget(support, ruleReminderTask)).toBe(false);
  });

  it.each(['public-source', 'browser-agent'] as const)(
    '%s 目标保留现有任务筛选能力',
    (supportMode) => {
      expect(
        watchTaskAllowedByTarget(
          { ...rulesOnly, supportMode },
          {
            ...ruleReminderTask,
            matchMode: 'doctor',
            doctorName: '测试医生',
            session: 'AM',
            eventTypes: ['availability_changed_to_available'],
          },
        ),
      ).toBe(true);
    },
  );

  it('public-source 缺少稳定性信息时使用中性标签，明确来源稳定性时保持标签', () => {
    const publicSource = { ...rulesOnly, supportMode: 'public-source' as const };
    const source = (stability: 'stable' | 'experimental'): SourceCapability => ({
      key: `source-${stability}`,
      sourceId: `source-${stability}`,
      accessClass: 'A',
      enabled: true,
      transport: 'fetch',
      minIntervalMs: 60_000,
      stability,
      eventTypes: ['schedule_released'],
      bindings: [],
      capabilities: { schedule: true, availability: false, cancellation: false, ruleReminder: false },
      runtime: null,
    });

    expect(supportPresentation(publicSource)).toMatchObject({
      title: '公开来源支持',
      activityLabel: '公开来源支持已启用',
    });
    expect(supportPresentation(publicSource, source('stable')).title).toBe('可关注公开排班');
    expect(supportPresentation(publicSource, source('experimental')).title).toBe('实验支持');
  });
});
