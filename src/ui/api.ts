export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code?: string, retryAfterMs?: number) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

// 服务端要求：带 Origin 的写请求必须携带该头（CSRF 简单请求防护）。
// 同源 UI 统一注入；跨站页面无法携带自定义头（会触发预检且被无 CORS 策略拒绝）。
const CLIENT_HEADERS = { 'x-easy-hospital-client': 'web' } as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { 'content-type': 'application/json; charset=utf-8', ...CLIENT_HEADERS, ...init.headers }
      : { ...CLIENT_HEADERS, ...init?.headers },
  });

  if (!response.ok) {
    let code: string | undefined;
    let retryAfterMs: number | undefined;
    try {
      const body = (await response.json()) as { error?: unknown; retryAfterMs?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)) {
        retryAfterMs = body.retryAfterMs;
      }
    } catch {
      code = undefined;
    }
    throw new ApiError(response.status, code, retryAfterMs);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export type HealthResponse = {
  status: string;
  checks: {
    storage?: { status?: string };
    worker?: {
      // 与 src/server/local-worker.ts 的 WorkerHealth 对齐；顶层 status 不含 worker 状态，必须下钻
      status?: 'healthy' | 'degraded' | 'stopped';
      running?: boolean;
      lastErrorCode?: string | null;
      lastRebaselineAt?: string | null;
    };
  };
};

export type TargetSupportMode =
  | 'public-source'
  | 'browser-agent'
  | 'rules-only'
  | 'directory-only';

export type TargetSupport = {
  active: boolean;
  sortOrder: number;
  supportMode: TargetSupportMode;
  canCreateWatchTask: boolean;
  // Catalog 未来可直接携带来源身份；当前运行时可从精确 manifest binding 补足。
  sourceId?: string | null;
  stability?: 'stable' | 'experimental' | null;
};

export type CatalogDepartment = {
  id: string;
  name: string;
  targetId: string;
  support: TargetSupport;
};

export type CatalogCampus = {
  id: string;
  name: string;
  departments: CatalogDepartment[];
};

export type CatalogHospital = {
  id: string;
  name: string;
  // 兼容服务端后续直接下发。当前 UI 对既有 API 使用受控官方域 fallback。
  officialUrl?: string;
  campuses: CatalogCampus[];
};

export type Catalog = {
  hospitals: CatalogHospital[];
};

export type EventType =
  | 'schedule_released'
  | 'availability_changed_to_available'
  | 'cancellation_slot_detected';

export type WatchTask = {
  id: string;
  hospitalId: string;
  campusId: string | null;
  departmentId: string;
  matchMode: 'any_expert' | 'title' | 'doctor';
  doctorName: string | null;
  titles: string[];
  dateFrom: string;
  dateTo: string;
  session: 'ANY' | 'AM' | 'PM';
  eventTypes: EventType[];
  remindBeforeMinutes: number | null;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WatchTaskInput = Omit<
  WatchTask,
  'id' | 'enabled' | 'version' | 'createdAt' | 'updatedAt'
>;

export type ReleaseRule = {
  id: string;
  hospitalId: string;
  campusId: string;
  departmentId: string;
  advanceDays: number;
  releaseTimeLocal: string;
  sameDayPolicy: string;
  officialEntryUrl: string;
  sourceUrl: string;
  verifiedAt: string;
  confidence: 'high' | 'medium' | 'low';
  needsReconfirmation: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DetectedEvent = {
  id: string;
  taskId: string;
  sourceId: string;
  eventType: EventType;
  slotKey: string;
  fromState: string | null;
  toState: string;
  evidence: 'explicit' | 'inferred';
  detectedAt: string;
  payload: {
    officialEntryUrl: string;
    date: string;
    session: 'AM' | 'PM';
    doctorName: string | null;
    title: string | null;
    availability: 'available' | 'unavailable' | 'unknown';
  };
};

export type SourceBinding = {
  targetId: string;
  hospitalId: string;
  campusId: string;
  departmentId: string;
  officialEntryUrl: string;
};

export type SourceCapability = {
  key: string;
  sourceId?: string | null;
  targetId?: string;
  accessClass: 'A' | 'B' | 'C';
  enabled: boolean;
  transport: 'fetch' | 'playwright' | 'rules-only' | 'local-agent';
  minIntervalMs: number | null;
  stability?: 'stable' | 'experimental' | null;
  eventTypes?: EventType[] | null;
  bindings?: SourceBinding[];
  capabilities: {
    schedule: boolean;
    availability: boolean;
    cancellation: boolean;
    ruleReminder: boolean;
  };
  runtime: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastStatus: string | null;
    lastErrorCode: string | null;
  } | null;
};

export type NotificationChannelStatus = {
  key: string;
  enabled: boolean;
  reason: string | null;
};

export type SourceProbeResult = {
  status: 'OK' | 'PARTIAL' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'SOURCE_CHANGED' | 'UNSUPPORTED' | 'TEMPORARY_FAILURE';
  observedAt: string;
  nextAllowedAt: string | null;
  eventsCreated: number;
  errorCode?: string;
};

export type RuntimeStatus = {
  dataDirectory: { display: string };
  sqlite: { status: string };
  worker: { status: string; running: boolean; lastHeartbeatAt?: string };
  notifications: NotificationChannelStatus[];
  browserAgent: { configured: boolean; lastSeenAt: string | null };
  sourceCapabilities: SourceCapability[];
};

export type NotificationSelfTest = {
  id: string;
  channel: string;
  status: 'accepted' | 'rejected' | 'unknown';
  providerMessageId: string | null;
  errorCode: string | null;
  testedAt: string;
};

export type NotificationBatch = {
  id: string;
  taskId: string;
  state: 'collecting' | 'pending' | 'sending' | 'sent' | 'failed' | 'delivery_unknown';
  opensAt: string;
  closesAt: string;
  eventTags: EventType[];
  eventIds: string[];
  officialEntryUrl: string;
  kind: 'event' | 'release-reminder';
  targetDate: string | null;
  needsReconfirmation: boolean;
  terminalReason: string | null;
  deliveries: Array<{
    channel: string;
    state: 'pending' | 'sending' | 'sent' | 'failed' | 'delivery_unknown';
    attempts: number;
    messageId: string;
    errorCode: string | null;
  }>;
};

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('/api/health', { signal }),
  catalog: (signal?: AbortSignal) => request<Catalog>('/api/catalog', { signal }),
  runtimeStatus: (signal?: AbortSignal) =>
    request<RuntimeStatus>('/api/runtime-status', { signal }),
  sourceAdapters: (signal?: AbortSignal) =>
    request<{ adapters: SourceCapability[] }>('/api/source-adapters', { signal }),
  liveProbe: (adapterKey: string, signal?: AbortSignal) =>
    request<SourceProbeResult>(
      `/api/source-adapters/${encodeURIComponent(adapterKey)}/live-probe`,
      { method: 'POST', signal },
    ),
  testNotification: (channelKey: string, signal?: AbortSignal) =>
    request<NotificationSelfTest>(`/api/notifications/${encodeURIComponent(channelKey)}/test`, {
      method: 'POST',
      signal,
    }),
  notificationTestResult: (channelKey: string, signal?: AbortSignal) =>
    request<NotificationSelfTest>(
      `/api/notifications/${encodeURIComponent(channelKey)}/test-result`,
      { signal },
    ),
  tasks: (signal?: AbortSignal) =>
    request<{ tasks: WatchTask[] }>('/api/watch-tasks', { signal }),
  task: (id: string, signal?: AbortSignal) =>
    request<WatchTask>(`/api/watch-tasks/${encodeURIComponent(id)}`, { signal }),
  createTask: (input: WatchTaskInput, signal?: AbortSignal) =>
    request<WatchTask>('/api/watch-tasks', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
  updateTask: (
    id: string,
    patch: Partial<WatchTaskInput> & { version: number; enabled?: boolean },
    signal?: AbortSignal,
  ) =>
    request<WatchTask>(`/api/watch-tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      signal,
    }),
  deleteTask: (id: string, signal?: AbortSignal) =>
    request<void>(`/api/watch-tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    }),
  rules: (signal?: AbortSignal) =>
    request<{ rules: ReleaseRule[] }>('/api/release-rules', { signal }),
  events: (signal?: AbortSignal) =>
    request<{ events: DetectedEvent[] }>('/api/events', { signal }),
  notifications: (signal?: AbortSignal) =>
    request<{ batches: NotificationBatch[] }>('/api/notification-batches', { signal }),
};
