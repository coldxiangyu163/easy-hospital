import { createHash } from 'node:crypto';

import type {
  CheckRequest,
  CheckResult,
  Observation,
  SourceAdapter,
  SourceBinding,
  SourceManifest,
} from '../../core/source-adapter.js';
import {
  AnzhenScheduleParseError,
  parseAnzhenHeartCenterSchedule,
  type AnzhenSchedule,
  type AnzhenScheduleDepartment,
} from './anzhen-schedule.js';

export const ANZHEN_HEART_CENTER_URL =
  'https://www.anzhen.org.cn/Html/Departments/Main/SearchIndex_118.html';
export const ANZHEN_MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

const bindings = [
  {
    targetId: 'target-anzhen-coronary-heart-disease-center',
    hospitalId: 'hospital-anzhen',
    campusId: 'campus-anzhen-chaoyang',
    departmentId: 'department-anzhen-coronary-heart-disease-center',
    officialEntryUrl: ANZHEN_HEART_CENTER_URL,
  },
  {
    targetId: 'target-anzhen-arrhythmia-center',
    hospitalId: 'hospital-anzhen',
    campusId: 'campus-anzhen-chaoyang',
    departmentId: 'department-anzhen-arrhythmia-center',
    officialEntryUrl: ANZHEN_HEART_CENTER_URL,
  },
] satisfies SourceBinding[];

export const anzhenHeartCenterScheduleManifest = {
  adapterKey: 'anzhen-public-heart-center-schedule',
  contractVersion: 1,
  version: '1.0.0',
  accessClass: 'A',
  transport: 'fetch',
  allowedHosts: ['www.anzhen.org', 'www.anzhen.org.cn'],
  minIntervalMs: MIN_INTERVAL_MS,
  sourceId: 'source-anzhen-public-heart-center-schedule',
  rateLimitKey: 'official-html:anzhen.org.cn',
  eventTypes: ['schedule_released'],
  stability: 'experimental',
  bindings,
} satisfies SourceManifest;

export type AnzhenAdapterDependencies = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

class ResponseTooLargeError extends Error {}

const canonicalHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > ANZHEN_MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > ANZHEN_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

function diagnosticResult(
  status: CheckResult['status'],
  errorCode: string,
  observedAt: Date,
  retryAfterMs = MIN_INTERVAL_MS,
): CheckResult {
  return {
    status,
    observedAt: observedAt.toISOString(),
    nextAllowedAt: new Date(observedAt.getTime() + retryAfterMs).toISOString(),
    contentHash: canonicalHash({ status, errorCode }),
    observations: [],
    errorCode,
  };
}

function retryAfterMs(response: Response, observedAt: Date): number {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return MIN_INTERVAL_MS;

  let serverDelayMs: number | undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) serverDelayMs = seconds * 1_000;
  } else {
    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) serverDelayMs = Math.max(0, retryAt - observedAt.getTime());
  }
  if (serverDelayMs === undefined || !Number.isSafeInteger(serverDelayMs)) {
    return MIN_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(serverDelayMs, MAX_RETRY_AFTER_MS));
}

function requestBinding(request: CheckRequest): SourceBinding | undefined {
  if (request.sourceId !== anzhenHeartCenterScheduleManifest.sourceId) return undefined;
  return bindings.find(
    (binding) =>
      binding.hospitalId === request.hospitalId &&
      binding.campusId === request.campusId &&
      binding.departmentId === request.departmentId,
  );
}

function departmentForBinding(binding: SourceBinding): AnzhenScheduleDepartment {
  return binding.departmentId === 'department-anzhen-coronary-heart-disease-center'
    ? 'coronary-heart-disease-center'
    : 'arrhythmia-center';
}

function toObservations(
  schedule: AnzhenSchedule,
  binding: SourceBinding,
  request: CheckRequest,
): Observation[] {
  const department = departmentForBinding(binding);
  return schedule.slots
    .filter(
      (slot) =>
        slot.department === department &&
        slot.date >= request.dateFrom &&
        slot.date <= request.dateTo &&
        (request.session === 'ANY' || slot.session === request.session) &&
        (request.doctorName === null || slot.doctorName === request.doctorName) &&
        (request.titles.length === 0 || request.titles.includes(slot.title)),
    )
    .map((slot) => ({
      slotKey: [
        'anzhen',
        binding.campusId,
        binding.departmentId,
        encodeURIComponent(slot.clinicName),
        slot.date,
        slot.session,
        encodeURIComponent(slot.doctorName),
      ].join(':'),
      hospitalId: binding.hospitalId,
      campusId: binding.campusId,
      departmentId: binding.departmentId,
      date: slot.date,
      session: slot.session,
      doctorName: slot.doctorName,
      title: slot.title,
      scheduleStatus: 'present' as const,
      availability: 'unknown' as const,
      officialEntryUrl: binding.officialEntryUrl,
      evidence: 'explicit' as const,
    }));
}

function allowedRedirect(response: Response, baseUrl: string): string | undefined {
  const location = response.headers.get('location');
  if (!location) return undefined;
  try {
    const url = new URL(location, baseUrl);
    return url.protocol === 'https:' &&
      anzhenHeartCenterScheduleManifest.allowedHosts.includes(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function createAnzhenHeartCenterScheduleAdapter(
  dependencies: AnzhenAdapterDependencies = {},
): SourceAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return {
    manifest: anzhenHeartCenterScheduleManifest,
    async check(request): Promise<CheckResult> {
      const observedAt = now();
      const binding = requestBinding(request);
      if (!binding) {
        return diagnosticResult('UNSUPPORTED', 'ANZHEN_SCOPE_UNSUPPORTED', observedAt);
      }

      const remainingMs = Date.parse(request.deadlineAt) - observedAt.getTime();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        return diagnosticResult('TEMPORARY_FAILURE', 'ANZHEN_DEADLINE_EXCEEDED', observedAt);
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(remainingMs, 2_147_483_647),
      );
      let html: string;
      try {
        const fetchOnce = (url: string): Promise<Response> =>
          fetchImpl(url, {
            headers: { accept: 'text/html,application/xhtml+xml' },
            redirect: 'manual',
            signal: controller.signal,
          });
        let response = await fetchOnce(ANZHEN_HEART_CENTER_URL);
        if (response.status >= 300 && response.status < 400) {
          const redirect = allowedRedirect(response, ANZHEN_HEART_CENTER_URL);
          if (!redirect) {
            return diagnosticResult('SOURCE_CHANGED', 'ANZHEN_REDIRECT_NOT_ALLOWED', observedAt);
          }
          response = await fetchOnce(redirect);
          if (response.status >= 300 && response.status < 400) {
            return diagnosticResult('SOURCE_CHANGED', 'ANZHEN_REDIRECT_CHAINED', observedAt);
          }
        }
        if (response.status === 429) {
          return diagnosticResult(
            'RATE_LIMITED',
            'ANZHEN_WAF_OR_ACCESS_DENIED',
            observedAt,
            retryAfterMs(response, observedAt),
          );
        }
        if ([403, 418].includes(response.status)) {
          return diagnosticResult('RATE_LIMITED', 'ANZHEN_WAF_OR_ACCESS_DENIED', observedAt);
        }
        if (response.status === 401) {
          return diagnosticResult('AUTH_REQUIRED', 'ANZHEN_AUTH_REQUIRED', observedAt);
        }
        if (response.status >= 500) {
          return diagnosticResult('TEMPORARY_FAILURE', 'ANZHEN_UPSTREAM_UNAVAILABLE', observedAt);
        }
        if (!response.ok) {
          return diagnosticResult('SOURCE_CHANGED', 'ANZHEN_HTTP_STATUS_CHANGED', observedAt);
        }
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml+xml')) {
          return diagnosticResult('SOURCE_CHANGED', 'ANZHEN_CONTENT_TYPE_CHANGED', observedAt);
        }
        html = await readResponseText(response);
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          return diagnosticResult('SOURCE_CHANGED', 'ANZHEN_RESPONSE_TOO_LARGE', observedAt);
        }
        if (controller.signal.aborted) {
          return diagnosticResult('TEMPORARY_FAILURE', 'ANZHEN_DEADLINE_EXCEEDED', observedAt);
        }
        return diagnosticResult('TEMPORARY_FAILURE', 'ANZHEN_FETCH_FAILED', observedAt);
      } finally {
        clearTimeout(timeout);
      }

      if (/(?:CloudWAF|Block-Event-Id|安全验证|访问被拦截|验证码)/i.test(html)) {
        return diagnosticResult('RATE_LIMITED', 'ANZHEN_WAF_OR_ACCESS_DENIED', observedAt);
      }
      if (/(?:用户登录|请登录后|登录后查看)/i.test(html)) {
        return diagnosticResult('AUTH_REQUIRED', 'ANZHEN_AUTH_REQUIRED', observedAt);
      }

      let schedule: AnzhenSchedule;
      try {
        schedule = parseAnzhenHeartCenterSchedule(html);
      } catch (error) {
        if (error instanceof AnzhenScheduleParseError) {
          return diagnosticResult('SOURCE_CHANGED', 'ANZHEN_STRUCTURE_CHANGED', observedAt);
        }
        return diagnosticResult('TEMPORARY_FAILURE', 'ANZHEN_PARSE_FAILED', observedAt);
      }

      return {
        status: 'OK',
        observedAt: observedAt.toISOString(),
        nextAllowedAt: new Date(observedAt.getTime() + MIN_INTERVAL_MS).toISOString(),
        contentHash: canonicalHash(schedule),
        observations: toObservations(schedule, binding, request),
      };
    },
  };
}
