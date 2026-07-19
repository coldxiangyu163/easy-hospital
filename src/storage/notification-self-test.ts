import { randomUUID } from 'node:crypto';

import type { NotificationSendResult } from '../core/notification-channel.js';
import type { SqliteDatabase } from './database.js';

type NotificationSelfTestRow = {
  id: string;
  channel_key: string;
  status: NotificationSendResult['status'];
  provider_message_id: string | null;
  error_code: string | null;
  tested_at: number;
};

export type NotificationSelfTestRecord = {
  id: string;
  channel: string;
  status: NotificationSendResult['status'];
  providerMessageId: string | null;
  errorCode: string | null;
  testedAt: string;
};

function toRecord(row: NotificationSelfTestRow): NotificationSelfTestRecord {
  return {
    id: row.id,
    channel: row.channel_key,
    status: row.status,
    providerMessageId: row.provider_message_id,
    errorCode: row.error_code,
    testedAt: new Date(row.tested_at).toISOString(),
  };
}

export function recordNotificationSelfTest(
  database: SqliteDatabase,
  channel: string,
  result: NotificationSendResult,
  testedAt: number,
): NotificationSelfTestRecord {
  const id = randomUUID();
  const providerMessageId = result.status === 'accepted' ? result.providerMessageId : null;
  const errorCode = result.status === 'accepted' ? null : result.errorCode;
  database
    .prepare(
      `INSERT INTO notification_self_test (
        id, channel_key, status, provider_message_id, error_code, tested_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, channel, result.status, providerMessageId, errorCode, testedAt);
  // 必须按 id 读回：并发自测时 getLatest 可能返回另一请求刚写入的记录。
  const row = database
    .prepare('SELECT * FROM notification_self_test WHERE id = ?')
    .get(id) as NotificationSelfTestRow;
  return toRecord(row);
}

export function getLatestNotificationSelfTest(
  database: SqliteDatabase,
  channel: string,
): NotificationSelfTestRecord | undefined {
  const row = database
    .prepare(
      `SELECT * FROM notification_self_test
       WHERE channel_key = ? ORDER BY tested_at DESC, id DESC LIMIT 1`,
    )
    .get(channel) as NotificationSelfTestRow | undefined;
  return row ? toRecord(row) : undefined;
}
