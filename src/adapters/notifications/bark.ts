import type {
  NotificationChannel,
  NotificationMessage,
  NotificationSendResult,
} from '../../core/notification-channel.js';

export type BarkChannelOptions = {
  baseUrl?: string;
  deviceKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type BarkResponse = {
  code?: number;
  id?: string | number;
};

function getNetworkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('cause' in error)) return undefined;
  const cause = error.cause;
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}

export class BarkChannel implements NotificationChannel {
  readonly key = 'bark';
  readonly enabled: boolean;
  readonly disabledReason:
    | 'missing_device_key'
    | 'invalid_base_url'
    | 'invalid_timeout'
    | null;

  readonly #baseUrl: URL | null;
  readonly #deviceKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: BarkChannelOptions) {
    this.#deviceKey = options.deviceKey?.trim() ?? '';
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;

    let baseUrl: URL | null;
    try {
      baseUrl = new URL(options.baseUrl ?? 'https://api.day.app');
      if (
        baseUrl.protocol !== 'https:' ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.search ||
        baseUrl.hash
      ) {
        baseUrl = null;
      }
    } catch {
      baseUrl = null;
    }

    this.#baseUrl = baseUrl;
    this.disabledReason = !this.#deviceKey
      ? 'missing_device_key'
      : baseUrl === null
        ? 'invalid_base_url'
        : !Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0
          ? 'invalid_timeout'
          : null;
    this.enabled = this.disabledReason === null;
  }

  async send(
    message: NotificationMessage,
    signal?: AbortSignal,
  ): Promise<NotificationSendResult> {
    if (!this.enabled || this.#baseUrl === null) {
      return { status: 'rejected', errorCode: 'CHANNEL_DISABLED', retryable: false };
    }
    if (signal?.aborted) {
      return { status: 'rejected', errorCode: 'ABORTED', retryable: false };
    }

    const endpoint = new URL(this.#baseUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodeURIComponent(this.#deviceKey)}`;
    endpoint.search = '';
    endpoint.hash = '';

    const timeout = new AbortController();
    const timeoutId = setTimeout(() => timeout.abort(), this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

    try {
      let response: Response;
      try {
        response = await this.#fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            title: message.subject,
            body: message.text,
            url: message.officialEntryUrl,
            id: message.messageId,
          }),
          signal: requestSignal,
        });
      } catch (error) {
        if (timeout.signal.aborted) {
          return { status: 'unknown', errorCode: 'BARK_TIMEOUT' };
        }
        if (signal?.aborted) {
          return { status: 'unknown', errorCode: 'BARK_ABORTED' };
        }
        const code = getNetworkErrorCode(error);
        if (
          code === 'ENOTFOUND' ||
          code === 'EAI_AGAIN' ||
          code === 'ECONNREFUSED' ||
          code === 'ETIMEDOUT' ||
          code === 'UND_ERR_CONNECT_TIMEOUT'
        ) {
          return { status: 'rejected', errorCode: 'BARK_NETWORK', retryable: true };
        }
        return { status: 'unknown', errorCode: 'BARK_DELIVERY_UNKNOWN' };
      }

      if (!response.ok) {
        const status = response.status;
        return {
          status: 'rejected',
          errorCode: `BARK_HTTP_${status}`,
          retryable: status === 408 || status === 425 || status === 429 || status >= 500,
        };
      }

      const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
        if (requestSignal.aborted) {
          resolve({ kind: 'aborted' });
          return;
        }
        requestSignal.addEventListener('abort', () => resolve({ kind: 'aborted' }), {
          once: true,
        });
      });
      const parsed = response.json().then(
        (payload: unknown) => ({ kind: 'parsed' as const, payload }),
        () => ({ kind: 'invalid' as const }),
      );
      const outcome = await Promise.race([parsed, aborted]);
      if (outcome.kind === 'aborted') {
        return timeout.signal.aborted
          ? { status: 'unknown', errorCode: 'BARK_TIMEOUT' }
          : { status: 'unknown', errorCode: 'BARK_ABORTED' };
      }
      if (outcome.kind === 'invalid') {
        return { status: 'unknown', errorCode: 'BARK_INVALID_RESPONSE' };
      }

      const payload = outcome.payload as BarkResponse;
      if (payload.code === 200) {
        return {
          status: 'accepted',
          providerMessageId: payload.id === undefined ? null : String(payload.id),
        };
      }
      if (typeof payload.code === 'number') {
        const code = payload.code;
        return {
          status: 'rejected',
          errorCode: `BARK_CODE_${code}`,
          retryable: code === 408 || code === 425 || code === 429 || code >= 500,
        };
      }
      return { status: 'unknown', errorCode: 'BARK_INVALID_RESPONSE' };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createBarkChannelFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImplementation: typeof fetch = globalThis.fetch,
): BarkChannel {
  const timeoutMs = env.BARK_TIMEOUT_MS ? Number(env.BARK_TIMEOUT_MS) : 10_000;
  return new BarkChannel({
    baseUrl: env.BARK_BASE_URL,
    deviceKey: env.BARK_DEVICE_KEY,
    fetch: fetchImplementation,
    timeoutMs,
  });
}
