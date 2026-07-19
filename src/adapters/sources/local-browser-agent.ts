export const BROWSER_AGENT_OFFICIAL_DOMAINS = [
  'pumch.cn',
  'pumchapp.pumch.cn',
  'trhos.com',
  'bjtrhos.cn',
  '114yygh.com',
] as const;

export type BrowserAgentAvailability = 'available' | 'unavailable' | 'unknown';

export interface VisiblePageSignals {
  matchedSelectorIds: readonly string[];
  statusTexts: readonly string[];
  guardTexts: readonly string[];
}

export interface ClassifiedVisiblePageState {
  availability: BrowserAgentAvailability;
  diagnosticCode: string | null;
}

export type BrowserAgentSession = 'AM' | 'PM';

export interface BrowserAgentConfirmation {
  confirmed: boolean;
  hospitalId: string;
  campusId: string;
  departmentId: string;
  date: string;
  session: BrowserAgentSession;
  doctorName: string;
  title: string;
}

export interface BrowserAgentPayloadInput {
  sourceUrl: string;
  observedAt: string;
  classified: ClassifiedVisiblePageState;
  confirmation: BrowserAgentConfirmation;
}

export interface BrowserAgentPayload {
  sourceId: string;
  requestId: string;
  observedAt: string;
  observations: Array<{
    slotKey: string;
    hospitalId: string;
    campusId: string;
    departmentId: string;
    date: string;
    session: BrowserAgentSession;
    doctorName: string | null;
    title: string | null;
    availability: BrowserAgentAvailability;
    scheduleStatus: 'unknown';
    officialEntryUrl: string;
    evidence: 'explicit';
  }>;
}

export function classifyVisiblePageState(
  signals: VisiblePageSignals,
): ClassifiedVisiblePageState {
  if (
    signals.guardTexts.some((text) =>
      /(?:验证码|人机验证|安全验证|滑动验证|访问验证)/i.test(text),
    )
  ) {
    return { availability: 'unknown', diagnosticCode: 'VERIFICATION_REQUIRED' };
  }
  if (
    signals.guardTexts.some((text) =>
      /(?:请登录|重新登录|登录状态.*失效|登录后(?:查看|继续)|会话.*失效)/i.test(text),
    )
  ) {
    return { availability: 'unknown', diagnosticCode: 'AUTH_REQUIRED' };
  }

  if (signals.matchedSelectorIds.length === 0) {
    return { availability: 'unknown', diagnosticCode: 'SELECTOR_NOT_FOUND' };
  }

  if (signals.statusTexts.some((text) => /^(?:可候补|候补|候补中)$/.test(text.trim()))) {
    return { availability: 'unknown', diagnosticCode: 'WAITLIST_ONLY' };
  }

  const hasAvailable = signals.statusTexts.some((text) =>
    /^(?:可预约|有号|可挂号|尚有号源|剩余\s*[1-9]\d*\s*(?:号|个)?)$/.test(text.trim()),
  );
  const hasUnavailable = signals.statusTexts.some((text) =>
    /^(?:已约满|无号|约满|已满|暂无号源|号源已满|剩余\s*0\s*(?:号|个)?)$/.test(text.trim()),
  );

  if (hasAvailable && hasUnavailable) {
    return { availability: 'unknown', diagnosticCode: 'AMBIGUOUS_STATUS' };
  }
  if (hasAvailable) {
    return { availability: 'available', diagnosticCode: null };
  }
  if (hasUnavailable) {
    return { availability: 'unavailable', diagnosticCode: null };
  }

  return { availability: 'unknown', diagnosticCode: 'STATUS_NOT_RECOGNIZED' };
}

const optionalText = (value: string): string | null => value.trim() || null;

const ALLOWED_SCOPES = [
  {
    hospitalId: 'hospital-pumch',
    campusId: 'campus-pumch-dongdan',
    departmentId: 'department-pumch-dermatology',
  },
  {
    hospitalId: 'hospital-tongren',
    campusId: 'campus-tongren-chongwenmen',
    departmentId: 'department-tongren-rhinology',
  },
] as const;

export function isAllowedBrowserAgentOfficialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      BROWSER_AGENT_OFFICIAL_DOMAINS.some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

export function isBrowserAgentOfficialSourceCompatible(
  sourceUrl: string,
  hospitalId: string,
): boolean {
  if (!isAllowedBrowserAgentOfficialUrl(sourceUrl)) return false;
  const source = new URL(sourceUrl);
  const hostnameMatches = (domain: string): boolean =>
    source.hostname === domain || source.hostname.endsWith(`.${domain}`);
  return (
    hostnameMatches('114yygh.com') ||
    (hospitalId === 'hospital-pumch' && hostnameMatches('pumch.cn')) ||
    (hospitalId === 'hospital-tongren' &&
      (hostnameMatches('trhos.com') || hostnameMatches('bjtrhos.cn')))
  );
}

export function buildBrowserAgentPayload(input: BrowserAgentPayloadInput): BrowserAgentPayload {
  if (!input.confirmation.confirmed) {
    throw new Error('USER_CONFIRMATION_REQUIRED');
  }
  if (!isAllowedBrowserAgentOfficialUrl(input.sourceUrl)) {
    throw new Error('OFFICIAL_URL_NOT_ALLOWED');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    throw new Error('OBSERVED_AT_INVALID');
  }

  const confirmation = input.confirmation;
  const scopeAllowed = ALLOWED_SCOPES.some(
    (scope) =>
      scope.hospitalId === confirmation.hospitalId &&
      scope.campusId === confirmation.campusId &&
      scope.departmentId === confirmation.departmentId,
  );
  if (
    !scopeAllowed ||
    !/^\d{4}-\d{2}-\d{2}$/.test(confirmation.date) ||
    (confirmation.session !== 'AM' && confirmation.session !== 'PM')
  ) {
    throw new Error('CONFIRMATION_FIELDS_INCOMPLETE');
  }

  if (!isBrowserAgentOfficialSourceCompatible(input.sourceUrl, confirmation.hospitalId)) {
    throw new Error('OFFICIAL_SCOPE_MISMATCH');
  }

  const sourceOrigin = `${new URL(input.sourceUrl).origin}/`;
  const classifiedIsValid =
    ['available', 'unavailable', 'unknown'].includes(input.classified.availability) &&
    (input.classified.availability === 'unknown'
      ? typeof input.classified.diagnosticCode === 'string' &&
        input.classified.diagnosticCode.length > 0
      : input.classified.diagnosticCode === null);
  const availability = classifiedIsValid ? input.classified.availability : 'unknown';

  const doctorName = optionalText(confirmation.doctorName);
  const title = optionalText(confirmation.title);
  const sourceId = `browser-agent-${confirmation.hospitalId}`;

  return {
    sourceId,
    requestId: `${sourceId}:${input.observedAt}`,
    observedAt: input.observedAt,
    observations: [
      {
        slotKey: [
          'browser-agent',
          confirmation.hospitalId,
          confirmation.campusId,
          confirmation.departmentId,
          confirmation.date,
          confirmation.session,
          encodeURIComponent(doctorName ?? '*'),
          encodeURIComponent(title ?? '*'),
        ].join(':'),
        hospitalId: confirmation.hospitalId,
        campusId: confirmation.campusId,
        departmentId: confirmation.departmentId,
        date: confirmation.date,
        session: confirmation.session,
        doctorName,
        title,
        availability,
        // Browser Agent 只读取可见号源状态，从不直接观察排班发布；
        // 排班与号源是不同事实，scheduleStatus 恒为 unknown，不得互相推导。
        scheduleStatus: 'unknown' as const,
        officialEntryUrl: sourceOrigin,
        evidence: 'explicit',
      },
    ],
  };
}
