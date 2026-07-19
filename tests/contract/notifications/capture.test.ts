import { describe, expect, it } from 'vitest';

import { CaptureChannel } from '../../../src/adapters/notifications/capture.js';
import { sendNotification, type NotificationMessage } from '../../../src/core/notification-channel.js';

const message: NotificationMessage = {
  messageId: 'delivery-20260719-001',
  subject: '验收测试通知',
  text: '这是一条仅供本地契约测试的通知',
  officialEntryUrl: 'https://www.example-hospital.cn/appoint',
  eventTags: ['schedule_released'],
  detectedAt: '2026-07-19T00:32:18.000Z',
};

describe('CaptureChannel 通知契约', () => {
  it('只记录本地消息，并明确声明不是真实送达', async () => {
    const channel = new CaptureChannel();

    expect(channel.key).toBe('capture');
    expect(channel.isRealDelivery).toBe(false);
    expect(channel.displayName).toBe('本地记录（未真实送达）');
    await expect(sendNotification(channel, message)).resolves.toEqual({
      status: 'accepted',
      providerMessageId: 'capture:delivery-20260719-001',
    });
    expect(channel.messages).toEqual([message]);
  });

  it('AbortSignal 已中止时不记录消息', async () => {
    const controller = new AbortController();
    controller.abort();
    const channel = new CaptureChannel();

    await expect(channel.send(message, controller.signal)).resolves.toEqual({
      status: 'rejected',
      errorCode: 'ABORTED',
      retryable: false,
    });
    expect(channel.messages).toEqual([]);
  });
});
