import { createHash } from 'node:crypto';

import type {
  CheckRequest,
  CheckResult,
  Observation,
  SourceAdapter,
  SourceManifest,
} from '../../core/source-adapter.js';
import {
  parsePumchSchedule,
  PumchScheduleParseError,
  type PumchSchedule,
  type PumchSchedulePeriod,
} from './pumch-schedule.js';
import { renderPumchSchedulePage } from './pumch-playwright.js';

export const PUMCH_SCHEDULE_URL =
  'https://www.pumch.cn/expert_chuzhen_week/%E7%9A%AE%E8%82%A4%E7%A7%91/3/1.html?linkage=990473';
export const PUMCH_OFFICIAL_ENTRY_URL = 'https://pumchapp.pumch.cn/pages/pc/home/index';

const PUMCH_HOSPITAL_ID = 'hospital-pumch';
const PUMCH_CAMPUS_ID = 'campus-pumch-dongdan';
const PUMCH_DEPARTMENT_ID = 'department-pumch-dermatology';
const MIN_INTERVAL_MS = 7_200_000;
export const PUMCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class PumchResponseTooLargeError extends Error {}

const readResponseText = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > PUMCH_MAX_RESPONSE_BYTES) {
    throw new PumchResponseTooLargeError();
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
    if (bytesRead > PUMCH_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PumchResponseTooLargeError();
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
};

export const pumchDermatologyScheduleManifest = {
  adapterKey: 'pumch-public-dermatology-schedule',
  contractVersion: 1,
  version: '1.1.0',
  accessClass: 'A',
  transport: 'fetch',
  allowedHosts: ['www.pumch.cn', 'pumchapp.pumch.cn'],
  minIntervalMs: MIN_INTERVAL_MS,
  sourceId: 'source-pumch-public-schedule',
  rateLimitKey: 'official-html:pumch.cn',
  eventTypes: ['schedule_released'],
  stability: 'stable',
  bindings: [
    {
      targetId: 'target-pumch-dermatology',
      hospitalId: PUMCH_HOSPITAL_ID,
      campusId: PUMCH_CAMPUS_ID,
      departmentId: PUMCH_DEPARTMENT_ID,
      officialEntryUrl: PUMCH_OFFICIAL_ENTRY_URL,
    },
  ],
} satisfies SourceManifest;

export interface PumchAdapterDependencies {
  fetchImpl?: typeof fetch;
  renderPage?: (url: string, deadlineAt: string) => Promise<string>;
  now?: () => Date;
}

const canonicalHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const resolveAllowedRedirect = (response: Response, baseUrl: string): string | null => {
  const location = response.headers.get('location');
  if (!location) return null;
  try {
    const redirectUrl = new URL(location, baseUrl);
    return redirectUrl.protocol === 'https:' &&
      pumchDermatologyScheduleManifest.allowedHosts.includes(redirectUrl.hostname)
      ? redirectUrl.toString()
      : null;
  } catch {
    return null;
  }
};

const diagnosticResult = (
  status: CheckResult['status'],
  errorCode: string,
  observedAt: Date,
): CheckResult => ({
  status,
  observedAt: observedAt.toISOString(),
  nextAllowedAt: new Date(observedAt.getTime() + MIN_INTERVAL_MS).toISOString(),
  contentHash: canonicalHash({ status, errorCode }),
  observations: [],
  errorCode,
});

const toSession = (period: PumchSchedulePeriod): 'AM' | 'PM' =>
  period === 'morning' ? 'AM' : 'PM';

const matchesRequest = (
  request: CheckRequest,
  date: string,
  session: 'AM' | 'PM',
  doctorName: string,
): boolean =>
  date >= request.dateFrom &&
  date <= request.dateTo &&
  (request.session === 'ANY' || request.session === session) &&
  (request.doctorName === null || request.doctorName === doctorName);

const toObservations = (schedule: PumchSchedule, request: CheckRequest): Observation[] =>
  schedule.sessions.flatMap((publishedSession) => {
    const session = toSession(publishedSession.period);

    return publishedSession.doctors
      .filter((doctorName) => matchesRequest(request, publishedSession.date, session, doctorName))
      .map((doctorName) => ({
        slotKey: [
          'pumch',
          PUMCH_CAMPUS_ID,
          PUMCH_DEPARTMENT_ID,
          publishedSession.date,
          session,
          encodeURIComponent(doctorName),
        ].join(':'),
        hospitalId: PUMCH_HOSPITAL_ID,
        campusId: PUMCH_CAMPUS_ID,
        departmentId: PUMCH_DEPARTMENT_ID,
        date: publishedSession.date,
        session,
        doctorName,
        title: null,
        scheduleStatus: 'present' as const,
        availability: 'unknown' as const,
        officialEntryUrl: PUMCH_OFFICIAL_ENTRY_URL,
        evidence: 'explicit' as const,
      }));
  });

export function createPumchDermatologyScheduleAdapter(
  dependencies: PumchAdapterDependencies = {},
): SourceAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const renderPage = dependencies.renderPage ?? renderPumchSchedulePage;
  const now = dependencies.now ?? (() => new Date());

  return {
    manifest: pumchDermatologyScheduleManifest,
    async check(request): Promise<CheckResult> {
      const observedAt = now();
      const supportsScope =
        request.sourceId === pumchDermatologyScheduleManifest.sourceId &&
        request.hospitalId === PUMCH_HOSPITAL_ID &&
        request.campusId === PUMCH_CAMPUS_ID &&
        request.departmentId === PUMCH_DEPARTMENT_ID;

      if (!supportsScope) {
        return diagnosticResult('UNSUPPORTED', 'PUMCH_SCOPE_UNSUPPORTED', observedAt);
      }
      if (request.titles.length > 0) {
        return diagnosticResult(
          'UNSUPPORTED',
          'PUMCH_TITLE_FILTER_UNSUPPORTED',
          observedAt,
        );
      }

      const remainingMs = Date.parse(request.deadlineAt) - observedAt.getTime();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        return diagnosticResult('TEMPORARY_FAILURE', 'PUMCH_DEADLINE_EXCEEDED', observedAt);
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(remainingMs, 2_147_483_647),
      );
      let fetchedHtml: string;
      try {
        const fetchOnce = (targetUrl: string): Promise<Response> =>
          fetchImpl(targetUrl, {
            headers: {
              accept: 'text/html,application/xhtml+xml',
            },
            redirect: 'manual',
            signal: controller.signal,
          });

        let response = await fetchOnce(PUMCH_SCHEDULE_URL);

        if (response.status >= 300 && response.status < 400) {
          const redirectTarget = resolveAllowedRedirect(response, PUMCH_SCHEDULE_URL);
          if (!redirectTarget) {
            return diagnosticResult(
              'SOURCE_CHANGED',
              'PUMCH_REDIRECT_NOT_ALLOWED',
              observedAt,
            );
          }
          // allowlist 内重定向只跟随一次；二次重定向或循环一律失败。
          response = await fetchOnce(redirectTarget);
          if (response.status >= 300 && response.status < 400) {
            return diagnosticResult(
              'TEMPORARY_FAILURE',
              'PUMCH_REDIRECT_RETRY_REQUIRED',
              observedAt,
            );
          }
        }

        if (response.status === 403 || response.status === 418 || response.status === 429) {
          return diagnosticResult('RATE_LIMITED', 'PUMCH_WAF_OR_ACCESS_DENIED', observedAt);
        }
        if (response.status >= 500) {
          return diagnosticResult(
            'TEMPORARY_FAILURE',
            'PUMCH_UPSTREAM_UNAVAILABLE',
            observedAt,
          );
        }

        fetchedHtml = await readResponseText(response);
      } catch (error) {
        if (error instanceof PumchResponseTooLargeError) {
          return diagnosticResult('SOURCE_CHANGED', 'PUMCH_RESPONSE_TOO_LARGE', observedAt);
        }
        if (controller.signal.aborted) {
          return diagnosticResult('TEMPORARY_FAILURE', 'PUMCH_DEADLINE_EXCEEDED', observedAt);
        }
        return diagnosticResult('TEMPORARY_FAILURE', 'PUMCH_FETCH_FAILED', observedAt);
      } finally {
        clearTimeout(timeout);
      }
      let schedule: PumchSchedule;

      try {
        schedule = parsePumchSchedule(fetchedHtml);
      } catch (error) {
        if (/(?:Block-Event-Id|WAF challenge|Access denied|安全验证)/i.test(fetchedHtml)) {
          return diagnosticResult(
            'RATE_LIMITED',
            'PUMCH_WAF_OR_ACCESS_DENIED',
            observedAt,
          );
        }
        if (/(?:用户登录|请登录后|登录后查看)/i.test(fetchedHtml)) {
          return diagnosticResult('AUTH_REQUIRED', 'PUMCH_AUTH_REQUIRED', observedAt);
        }

        const isRecognizedDynamicShell =
          error instanceof PumchScheduleParseError &&
          /id=["']docker-visit["']/i.test(fetchedHtml) &&
          fetchedHtml.includes('/newdsearchs/dockerinfo/');

        if (!isRecognizedDynamicShell || !renderPage) {
          return diagnosticResult('SOURCE_CHANGED', 'PUMCH_STRUCTURE_CHANGED', observedAt);
        }

        let renderedHtml: string;
        try {
          renderedHtml = await renderPage(PUMCH_SCHEDULE_URL, request.deadlineAt);
        } catch {
          return diagnosticResult('TEMPORARY_FAILURE', 'PUMCH_RENDER_FAILED', observedAt);
        }

        try {
          schedule = parsePumchSchedule(renderedHtml);
        } catch (renderError) {
          if (/(?:Block-Event-Id|WAF challenge|Access denied|安全验证)/i.test(renderedHtml)) {
            return diagnosticResult(
              'RATE_LIMITED',
              'PUMCH_WAF_OR_ACCESS_DENIED',
              observedAt,
            );
          }
          if (/(?:用户登录|请登录后|登录后查看)/i.test(renderedHtml)) {
            return diagnosticResult('AUTH_REQUIRED', 'PUMCH_AUTH_REQUIRED', observedAt);
          }
          if (renderError instanceof PumchScheduleParseError) {
            return diagnosticResult('SOURCE_CHANGED', 'PUMCH_STRUCTURE_CHANGED', observedAt);
          }
          return diagnosticResult('TEMPORARY_FAILURE', 'PUMCH_RENDER_FAILED', observedAt);
        }
      }

      const observations = toObservations(schedule, request);

      return {
        status: 'OK',
        observedAt: observedAt.toISOString(),
        nextAllowedAt: new Date(observedAt.getTime() + MIN_INTERVAL_MS).toISOString(),
        contentHash: canonicalHash(schedule),
        observations,
      };
    },
  };
}
