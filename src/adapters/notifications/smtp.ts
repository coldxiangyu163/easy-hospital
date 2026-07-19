import { createHash } from 'node:crypto';

import nodemailer, { type Transporter } from 'nodemailer';

import type {
  NotificationChannel,
  NotificationMessage,
  NotificationSendResult,
} from '../../core/notification-channel.js';

export type SmtpTransporter = Pick<Transporter, 'sendMail'>;

export type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
};

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransporter;

type SmtpErrorShape = {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
};

function classifySmtpError(error: unknown): NotificationSendResult {
  const shape = error && typeof error === 'object' ? (error as SmtpErrorShape) : {};
  const code = typeof shape.code === 'string' ? shape.code : undefined;
  const responseCode = typeof shape.responseCode === 'number' ? shape.responseCode : undefined;
  const command = typeof shape.command === 'string' ? shape.command.toUpperCase() : undefined;

  if (code === 'EAUTH') {
    return { status: 'rejected', errorCode: 'SMTP_AUTH', retryable: false };
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return { status: 'rejected', errorCode: 'SMTP_MESSAGE_REJECTED', retryable: false };
  }
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
    return { status: 'rejected', errorCode: 'SMTP_TEMPORARY', retryable: true };
  }
  if (responseCode !== undefined && responseCode >= 500) {
    return { status: 'rejected', errorCode: 'SMTP_PERMANENT', retryable: false };
  }
  if (command === 'DATA') {
    return { status: 'unknown', errorCode: 'SMTP_DELIVERY_UNKNOWN' };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return { status: 'unknown', errorCode: 'SMTP_DELIVERY_UNKNOWN' };
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ETIMEOUT' ||
    code === 'ECONNECTION' ||
    code === 'EDNS' ||
    code === 'ESOCKET' ||
    code === 'ECONNREFUSED'
  ) {
    return { status: 'rejected', errorCode: 'SMTP_NETWORK', retryable: true };
  }
  return { status: 'unknown', errorCode: 'SMTP_DELIVERY_UNKNOWN' };
}

export type SmtpChannelOptions = {
  transporter?: SmtpTransporter;
  from?: string;
  to?: string;
  timeoutMs?: number;
};

export class SmtpChannel implements NotificationChannel {
  readonly key = 'smtp';
  readonly enabled: boolean;
  readonly disabledReason: 'missing_transporter' | 'missing_from' | 'missing_to' | null;

  readonly #transporter: SmtpTransporter | undefined;
  readonly #from: string;
  readonly #to: string;
  readonly #timeoutMs: number;

  constructor(options: SmtpChannelOptions) {
    this.#transporter = options.transporter;
    this.#from = options.from?.trim() ?? '';
    this.#to = options.to?.trim() ?? '';
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.disabledReason = !this.#transporter
      ? 'missing_transporter'
      : !this.#from
        ? 'missing_from'
        : !this.#to
          ? 'missing_to'
          : null;
    this.enabled = this.disabledReason === null;
  }

  async send(
    message: NotificationMessage,
    signal?: AbortSignal,
  ): Promise<NotificationSendResult> {
    if (!this.enabled || !this.#transporter) {
      return { status: 'rejected', errorCode: 'CHANNEL_DISABLED', retryable: false };
    }
    if (signal?.aborted) {
      return { status: 'rejected', errorCode: 'ABORTED', retryable: false };
    }

    const messageId = `<${createHash('sha256').update(message.messageId).digest('hex')}@easy-hospital.local>`;
    const sending = this.#transporter
      .sendMail({
        from: this.#from,
        to: this.#to,
        subject: message.subject,
        text: `${message.text}\n\n官方入口：${message.officialEntryUrl}`,
        messageId,
      })
      .then(
        (info) => ({ kind: 'sent' as const, info }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), this.#timeoutMs);
    });
    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
      if (!signal) return;
      abortHandler = () => resolve({ kind: 'aborted' });
      signal.addEventListener('abort', abortHandler, { once: true });
    });
    const outcome = await Promise.race([sending, timeout, aborted]);
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);

    if (outcome.kind === 'timeout') {
      return { status: 'unknown', errorCode: 'SMTP_TIMEOUT' };
    }
    if (outcome.kind === 'aborted') {
      return { status: 'unknown', errorCode: 'SMTP_ABORTED' };
    }
    if (outcome.kind === 'error') {
      return classifySmtpError(outcome.error);
    }
    if (
      Array.isArray(outcome.info.accepted) &&
      outcome.info.accepted.length === 0 &&
      Array.isArray(outcome.info.rejected) &&
      outcome.info.rejected.length > 0
    ) {
      return { status: 'rejected', errorCode: 'SMTP_RECIPIENT_REJECTED', retryable: false };
    }
    return {
      status: 'accepted',
      providerMessageId:
        typeof outcome.info.messageId === 'string' && outcome.info.messageId.length > 0
          ? outcome.info.messageId
          : null,
    };
  }
}

const defaultTransportFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

export function createSmtpChannelFromEnv(
  env: Record<string, string | undefined> = process.env,
  createTransport: SmtpTransportFactory = defaultTransportFactory,
): SmtpChannel {
  const host = env.SMTP_HOST?.trim() ?? '';
  const from = env.SMTP_FROM?.trim() ?? '';
  const to = env.SMTP_TO?.trim() ?? '';
  const port = Number(env.SMTP_PORT);
  const timeoutMs = env.SMTP_TIMEOUT_MS ? Number(env.SMTP_TIMEOUT_MS) : 15_000;
  const secureSetting = env.SMTP_SECURE;
  const secure = secureSetting === undefined ? port === 465 : secureSetting === 'true';
  const user = env.SMTP_USER?.trim() ?? '';
  const password = env.SMTP_PASSWORD ?? '';
  const authIsComplete = Boolean(user) === Boolean(password);
  const secureIsValid =
    secureSetting === undefined || secureSetting === 'true' || secureSetting === 'false';

  if (
    !host ||
    !from ||
    !to ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !authIsComplete ||
    !secureIsValid
  ) {
    return new SmtpChannel({ from, to });
  }

  const transportOptions: SmtpTransportOptions = {
    host,
    port,
    secure,
    requireTLS: !secure,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
  if (user && password) transportOptions.auth = { user, pass: password };

  let transporter: SmtpTransporter;
  try {
    transporter = createTransport(transportOptions);
  } catch {
    return new SmtpChannel({ from, to });
  }

  return new SmtpChannel({ transporter, from, to, timeoutMs });
}
