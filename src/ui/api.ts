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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { 'content-type': 'application/json; charset=utf-8', ...init.headers }
      : init?.headers,
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
    worker?: { status?: string; running?: boolean };
  };
};

export type Catalog = {
  hospitals: Array<{
    id: string;
    name: string;
    campuses: Array<{
      id: string;
      name: string;
      departments: Array<{ id: string; name: string }>;
    }>;
  }>;
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

export type SourceCapability = {
  key: string;
  accessClass: 'A' | 'B' | 'C';
  enabled: boolean;
  transport: 'fetch' | 'playwright' | 'rules-only' | 'local-agent';
  minIntervalMs: number | null;
  capabilities: {
    schedule: boolean;
    availability: boolean;
    cancellation: boolean;
    ruleReminder: boolean;
  };
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
