import { isBrowserAgentScopeAllowed } from '../core/browser-agent.js';
import {
  findSourceBinding,
  isBoundSourceManifest,
  type SourceAdapter,
} from '../core/source-adapter.js';
import { watchTaskAllowedByTarget } from '../core/target-support.js';
import {
  resolveCatalogScope,
  resolveCatalogTarget,
  type CatalogScope,
} from '../storage/catalog.js';
import type { SqliteDatabase } from '../storage/database.js';

type ScopeInput = {
  hospitalId: string;
  campusId: string | null;
  departmentId: string;
};

type WatchTaskPolicyInput = ScopeInput & {
  matchMode: 'any_expert' | 'title' | 'doctor';
  doctorName: string | null;
  titles: string[];
  session: 'ANY' | 'AM' | 'PM';
  eventTypes: string[];
  remindBeforeMinutes: number | null;
};

export type EnabledWatchTaskAdmissionError =
  | 'WATCH_TASK_CAMPUS_REQUIRED'
  | 'SOURCE_BINDING_NOT_AVAILABLE'
  | 'SOURCE_EVENT_TYPE_NOT_AVAILABLE'
  | 'RELEASE_RULE_NOT_AVAILABLE';

export class TargetSupportRegistry {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly sourceAdapters: SourceAdapter[] = [],
    private readonly browserAgentEnabled = false,
  ) {}

  resolveScope(input: ScopeInput): CatalogScope | undefined {
    return resolveCatalogScope(this.database, input);
  }

  resolveTarget(targetId: string): CatalogScope | undefined {
    return resolveCatalogTarget(this.database, targetId);
  }

  listRuleOnlyTargetIds(): string[] {
    return (
      this.database
        .prepare(
          `SELECT target_id FROM department
           WHERE active = 1 AND support_mode = 'rules-only'
           ORDER BY sort_order, id`,
        )
        .all() as Array<{ target_id: string }>
    ).map(({ target_id }) => target_id);
  }

  enabledWatchTaskAdmissionError(
    input: WatchTaskPolicyInput,
  ): EnabledWatchTaskAdmissionError | undefined {
    if (input.campusId === null) return 'WATCH_TASK_CAMPUS_REQUIRED';
    const target = this.resolveScope(input);
    if (!target) return undefined;

    if (target.support.supportMode === 'rules-only') {
      const rule = this.database
        .prepare(
          `SELECT 1 FROM release_rule
           WHERE hospital_id = ? AND campus_id = ? AND department_id = ? AND enabled = 1
           LIMIT 1`,
        )
        .get(input.hospitalId, input.campusId, input.departmentId);
      return rule ? undefined : 'RELEASE_RULE_NOT_AVAILABLE';
    }
    if (target.support.supportMode !== 'public-source') return undefined;

    const eventTypes = new Set<string>();
    let hasBinding = false;
    for (const adapter of this.sourceAdapters) {
      if (
        isBoundSourceManifest(adapter.manifest) &&
        findSourceBinding(adapter.manifest, {
          targetId: target.targetId,
          hospitalId: input.hospitalId,
          campusId: input.campusId,
          departmentId: input.departmentId,
        })
      ) {
        hasBinding = true;
        for (const eventType of adapter.manifest.eventTypes) eventTypes.add(eventType);
      }
    }
    if (!hasBinding) return 'SOURCE_BINDING_NOT_AVAILABLE';
    if (this.browserAgentEnabled && isBrowserAgentScopeAllowed(input)) {
      eventTypes.add('availability_changed_to_available');
      eventTypes.add('cancellation_slot_detected');
    }
    return input.eventTypes.every((eventType) => eventTypes.has(eventType))
      ? undefined
      : 'SOURCE_EVENT_TYPE_NOT_AVAILABLE';
  }

  watchTaskAllowed(input: WatchTaskPolicyInput): boolean {
    const target = this.resolveScope(input);
    return target !== undefined && watchTaskAllowedByTarget(target.support, input);
  }
}
