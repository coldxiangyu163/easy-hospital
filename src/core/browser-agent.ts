import { z } from 'zod';

import { observationSchema, type Observation } from './source-adapter.js';

type BrowserAgentScope = {
  hospitalId: string;
  campusId: string;
  departmentId: string;
  allowedDomains: readonly string[];
};

const BROWSER_AGENT_SCOPES: readonly BrowserAgentScope[] = [
  {
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
    allowedDomains: ['pumch.cn', '114yygh.com'],
  },
  {
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
    allowedDomains: ['trhos.com', 'bjtrhos.cn', '114yygh.com'],
  },
] as const;

function findScope(observation: Observation): BrowserAgentScope | undefined {
  return BROWSER_AGENT_SCOPES.find(
    (scope) =>
      scope.hospitalId === observation.hospitalId &&
      scope.campusId === observation.campusId &&
      scope.departmentId === observation.departmentId,
  );
}

function isAllowedOfficialOrigin(value: string, scope: BrowserAgentScope): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    return scope.allowedDomains.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function isAllowedStateCombination(observation: Observation): boolean {
  return (
    (observation.scheduleStatus === 'present' &&
      (observation.availability === 'available' ||
        observation.availability === 'unavailable')) ||
    (observation.scheduleStatus === 'unknown' && observation.availability === 'unknown')
  );
}

export function deriveBrowserAgentSourceId(hospitalId: string): string {
  return `browser-agent-${hospitalId}`;
}

export function deriveBrowserAgentSlotKey(observation: Observation): string {
  return [
    'browser-agent',
    observation.hospitalId,
    observation.campusId,
    observation.departmentId,
    observation.date,
    observation.session,
    encodeURIComponent(observation.doctorName ?? '*'),
    encodeURIComponent(observation.title ?? '*'),
  ].join(':');
}

export const browserAgentIngestSchema = z
  .strictObject({
    sourceId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    observedAt: z.iso.datetime(),
    observations: z.array(observationSchema).min(1).max(500),
  })
  .superRefine((value, context) => {
    const first = value.observations[0];
    if (!first) return;
    const expectedScope = findScope(first);
    if (!expectedScope) {
      context.addIssue({
        code: 'custom',
        path: ['observations', 0],
        message: 'BROWSER_AGENT_SCOPE_NOT_ALLOWED',
      });
      return;
    }

    if (value.sourceId !== deriveBrowserAgentSourceId(expectedScope.hospitalId)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceId'],
        message: 'BROWSER_AGENT_SOURCE_ID_INVALID',
      });
    }

    value.observations.forEach((observation, index) => {
      const scope = findScope(observation);
      if (
        !scope ||
        scope.hospitalId !== expectedScope.hospitalId ||
        scope.campusId !== expectedScope.campusId ||
        scope.departmentId !== expectedScope.departmentId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index],
          message: 'BROWSER_AGENT_MULTIPLE_OR_INVALID_SCOPE',
        });
        return;
      }
      if (!isAllowedOfficialOrigin(observation.officialEntryUrl, scope)) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'officialEntryUrl'],
          message: 'BROWSER_AGENT_OFFICIAL_ORIGIN_INVALID',
        });
      }
      if (observation.evidence !== 'explicit') {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'evidence'],
          message: 'BROWSER_AGENT_EVIDENCE_INVALID',
        });
      }
      if (!isAllowedStateCombination(observation)) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index],
          message: 'BROWSER_AGENT_STATE_COMBINATION_INVALID',
        });
      }
      if (observation.slotKey !== deriveBrowserAgentSlotKey(observation)) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'slotKey'],
          message: 'BROWSER_AGENT_SLOT_KEY_INVALID',
        });
      }
    });
  });

export type BrowserAgentIngest = z.infer<typeof browserAgentIngestSchema>;

export function deriveBrowserAgentIngest(input: BrowserAgentIngest): BrowserAgentIngest {
  const hospitalId = input.observations[0]!.hospitalId;
  return {
    ...input,
    sourceId: deriveBrowserAgentSourceId(hospitalId),
    observations: input.observations.map((observation) => ({
      ...observation,
      slotKey: deriveBrowserAgentSlotKey(observation),
    })),
  };
}
