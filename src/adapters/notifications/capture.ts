import type {
  NotificationChannel,
  NotificationMessage,
  NotificationSendResult,
} from '../../core/notification-channel.js';

export class CaptureChannel implements NotificationChannel {
  readonly key = 'capture';
  readonly enabled = true;
  readonly isRealDelivery = false;
  readonly displayName = '本地记录（未真实送达）';

  readonly #messages: NotificationMessage[] = [];

  get messages(): readonly NotificationMessage[] {
    return structuredClone(this.#messages);
  }

  async send(
    message: NotificationMessage,
    signal?: AbortSignal,
  ): Promise<NotificationSendResult> {
    if (signal?.aborted) {
      return { status: 'rejected', errorCode: 'ABORTED', retryable: false };
    }
    this.#messages.push(structuredClone(message));
    return {
      status: 'accepted',
      providerMessageId: `capture:${message.messageId}`,
    };
  }
}
