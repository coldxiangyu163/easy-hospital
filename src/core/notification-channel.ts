import { z } from 'zod';

import { eventTypeSchema } from './watch-task.js';

export const notificationMessageSchema = z.strictObject({
  messageId: z.string().min(1),
  subject: z.string().min(1),
  text: z.string().min(1),
  officialEntryUrl: z.url({ protocol: /^https$/ }),
  eventTags: z.array(eventTypeSchema).min(1),
  detectedAt: z.iso.datetime(),
});

export const notificationSendResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), providerMessageId: z.string().min(1).nullable() }),
  z.strictObject({ status: z.literal('rejected'), errorCode: z.string().min(1), retryable: z.boolean() }),
  z.strictObject({ status: z.literal('unknown'), errorCode: z.string().min(1) }),
]);

export type NotificationMessage = z.infer<typeof notificationMessageSchema>;
export type NotificationSendResult = z.infer<typeof notificationSendResultSchema>;

export interface NotificationChannel {
  readonly key: string;
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}

export async function sendNotification(
  channel: NotificationChannel,
  message: NotificationMessage,
): Promise<NotificationSendResult> {
  const input = notificationMessageSchema.parse(message);
  return notificationSendResultSchema.parse(await channel.send(input));
}
