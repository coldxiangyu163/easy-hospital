import { describe, expect, it } from 'vitest';

import {
  sendNotification,
  type NotificationChannel,
} from '../../src/core/notification-channel.js';

describe('NotificationChannel 契约 seam', () => {
  it('向渠道传递完整可行动消息并规范化接受结果', async () => {
    let received: unknown;
    const channel: NotificationChannel = {
      key: 'capture',
      async send(message) {
        received = message;
        return { status: 'accepted', providerMessageId: 'provider-1' };
      },
    };

    const result = await sendNotification(channel, {
      messageId: 'event-1@example.local',
      subject: '检测到可用号源',
      text: '北京同仁医院 · 崇文门院区 · 鼻科',
      officialEntryUrl: 'https://www.trhos.com/',
      eventTags: ['availability_changed_to_available'],
      detectedAt: '2026-07-19T00:00:00.000Z',
    });

    expect(received).toMatchObject({
      messageId: 'event-1@example.local',
      officialEntryUrl: 'https://www.trhos.com/',
    });
    expect(result).toEqual({ status: 'accepted', providerMessageId: 'provider-1' });
  });
});
