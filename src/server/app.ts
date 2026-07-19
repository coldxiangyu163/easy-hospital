import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import {
  browserAgentIngestSchema,
  deriveBrowserAgentIngest,
} from '../core/browser-agent.js';
import {
  sendNotification,
  type NotificationChannel,
} from '../core/notification-channel.js';
import { releaseRuleInputSchema, releaseRulePatchSchema } from '../core/release-rule.js';
import {
  checkRequestSchema,
  runSourceAdapter,
  type SourceAdapter,
} from '../core/source-adapter.js';
import { watchTaskInputSchema, watchTaskPatchSchema } from '../core/watch-task.js';
import {
  assessBrowserAgentIngest,
  getLatestBrowserAgentSeenAt,
  recordBrowserAgentIngest,
} from '../storage/browser-agent.js';
import { openDatabase, readCatalog } from '../storage/database.js';
import { SqliteJobRunner } from '../storage/job-runner.js';
import {
  applyCheckResult,
  listAvailabilityStates,
  listDetectedEvents,
} from '../storage/monitoring.js';
import { listNotificationBatches } from '../storage/notification-outbox.js';
import {
  getLatestNotificationSelfTest,
  recordNotificationSelfTest,
} from '../storage/notification-self-test.js';
import { scheduleWatchTask } from '../storage/scheduling.js';
import {
  recordSourceAttempt,
  recordSourceResult,
  sourceRetryAfterMs,
} from '../storage/source-runtime.js';
import {
  createReleaseRule,
  deleteReleaseRule,
  getReleaseRule,
  hasOfficialRuleUrls,
  listReleaseRules,
  updateReleaseRule,
} from '../storage/release-rules.js';
import {
  createWatchTask,
  deleteWatchTask,
  getWatchTask,
  listWatchTasks,
  updateWatchTask,
} from '../storage/watch-tasks.js';
import { LocalWorker } from './local-worker.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function requestHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;

  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

function isLoopbackWebOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    const hostname = origin.hostname.replace(/^\[|\]$/g, '');
    return (
      (origin.protocol === 'http:' || origin.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(hostname) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash
    );
  } catch {
    return false;
  }
}

function isChromeExtensionOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (
      origin.protocol === 'chrome-extension:' &&
      origin.hostname.length > 0 &&
      !origin.username &&
      !origin.password &&
      (origin.pathname === '' || origin.pathname === '/') &&
      !origin.search &&
      !origin.hash
    );
  } catch {
    return false;
  }
}

export type NotificationChannelStatus = {
  key: string;
  enabled: boolean;
  reason: string | null;
};

export type BuildAppOptions = {
  host?: string;
  databasePath?: string;
  dataDirectory?: string;
  sourceAdapters?: SourceAdapter[];
  notificationChannels?: NotificationChannel[];
  notificationChannelStatuses?: NotificationChannelStatus[];
  browserAgentToken?: string;
  workerPollMs?: number;
  publicDirectory?: string;
  serveStatic?: boolean;
  now?: () => number;
  enforceSourceRateLimit?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error('RADAR_HOST 只允许 127.0.0.1');
  }

  const serveStatic = options.serveStatic ?? process.env.NODE_ENV === 'production';
  const publicDirectory = options.publicDirectory ?? resolve(process.cwd(), 'dist/public');
  if (serveStatic && !existsSync(publicDirectory)) {
    throw new Error('STATIC_PUBLIC_DIRECTORY_MISSING');
  }

  const app = Fastify({ logger: false });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (typeof error.code === 'string' && error.code.startsWith('SQLITE_BUSY')) {
      return reply.code(503).send({
        error: 'STORAGE_BUSY',
        message: '本地数据正忙，请稍后重试',
      });
    }
    return reply.send(error);
  });
  const database = openDatabase(options.databasePath);
  const now = options.now ?? Date.now;
  const enforceSourceRateLimit =
    options.enforceSourceRateLimit ?? process.env.NODE_ENV !== 'test';
  const staticAvailable = serveStatic;
  if (staticAvailable) {
    await app.register(fastifyStatic, {
      root: publicDirectory,
      wildcard: false,
    });
  }
  const sourceAdapters = new Map(
    (options.sourceAdapters ?? []).map((adapter) => [adapter.manifest.adapterKey, adapter]),
  );
  const notificationChannels = new Map(
    (options.notificationChannels ?? []).map((channel) => [channel.key, channel]),
  );
  const notificationStatuses =
    options.notificationChannelStatuses ??
    (options.notificationChannels ?? []).map((channel) => ({
      key: channel.key,
      enabled: true,
      reason: null,
    }));
  const sourceCapabilities = [
    ...[...sourceAdapters.values()].map((adapter) => ({
      key: adapter.manifest.adapterKey,
      accessClass: adapter.manifest.accessClass,
      enabled: true,
      transport: adapter.manifest.transport,
      minIntervalMs: adapter.manifest.minIntervalMs,
      capabilities:
        adapter.manifest.adapterKey === 'pumch-public-dermatology-schedule'
          ? { schedule: true, availability: false, cancellation: false, ruleReminder: false }
          : { schedule: true, availability: true, cancellation: true, ruleReminder: false },
    })),
    {
      key: 'browser-agent',
      accessClass: 'B' as const,
      enabled: Boolean(options.browserAgentToken),
      transport: 'local-agent',
      minIntervalMs: 300_000,
      capabilities: { schedule: true, availability: true, cancellation: true, ruleReminder: false },
    },
    {
      key: 'tongren-rhinology-rules',
      accessClass: 'C' as const,
      enabled: true,
      transport: 'rules-only',
      minIntervalMs: null,
      capabilities: { schedule: false, availability: false, cancellation: false, ruleReminder: true },
    },
  ];
  const jobRunner = new SqliteJobRunner(database);
  const startupNow = now();
  for (const task of listWatchTasks(database)) {
    scheduleWatchTask(database, jobRunner, task, sourceAdapters, startupNow);
  }
  const worker = new LocalWorker(
    database,
    options.notificationChannels ?? [],
    [...sourceAdapters.values()],
    options.workerPollMs,
    now,
  );
  worker.start();

  app.addHook('onRequest', async (request, reply) => {
    const hostname = requestHostname(request.headers.host);
    if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
      return reply.code(403).send({
        error: 'LOCAL_ACCESS_ONLY',
        message: '此服务仅允许本机访问',
      });
    }

    const origin = request.headers.origin;
    if (origin && request.method !== 'GET' && request.method !== 'HEAD') {
      const isBrowserAgentObservation =
        request.url.split('?', 1)[0] === '/api/browser-agent/observations';
      const allowed = isBrowserAgentObservation
        ? isChromeExtensionOrigin(origin)
        : isLoopbackWebOrigin(origin);
      if (!allowed) {
        return reply.code(403).send({
          error: isBrowserAgentObservation
            ? 'BROWSER_AGENT_ORIGIN_FORBIDDEN'
            : 'LOCAL_ORIGIN_REQUIRED',
          message: '请求 Origin 不在本机允许范围内',
        });
      }
    }
  });

  app.addHook('onClose', async () => {
    await worker.stop();
    database.close();
  });

  app.get('/api/health', async () => {
    database.prepare('SELECT 1').get();
    return {
      status: 'healthy',
      checks: {
        storage: { status: 'healthy' },
        worker: worker.health(),
      },
    };
  });

  app.get('/api/runtime-status', async () => {
    database.prepare('SELECT 1').get();
    const dataDirectory =
      options.dataDirectory ??
      (options.databasePath && options.databasePath !== ':memory:'
        ? dirname(options.databasePath)
        : 'memory');
    return {
      dataDirectory: { display: `…/${basename(dataDirectory)}` },
      sqlite: { status: 'healthy' },
      worker: worker.health(),
      notifications: notificationStatuses,
      browserAgent: {
        configured: Boolean(options.browserAgentToken),
        lastSeenAt: (() => {
          const lastSeenAt = getLatestBrowserAgentSeenAt(database);
          return lastSeenAt === undefined ? null : new Date(lastSeenAt).toISOString();
        })(),
      },
      sourceCapabilities,
    };
  });

  app.get('/api/source-adapters', async () => ({ adapters: sourceCapabilities }));

  app.post('/api/source-adapters/:adapterKey/live-probe', async (request, reply) => {
    const { adapterKey } = request.params as { adapterKey: string };
    const adapter = sourceAdapters.get(adapterKey);
    if (!adapter) return reply.code(404).send({ error: 'SOURCE_ADAPTER_NOT_FOUND' });

    const checkedAt = now();
    let checkRequest: unknown = request.body;
    if (
      (checkRequest === undefined || checkRequest === null) &&
      adapterKey === 'pumch-public-dermatology-schedule'
    ) {
      const beijingNow = new Date(checkedAt + 8 * 60 * 60 * 1_000);
      const formatDate = (date: Date): string =>
        [
          date.getUTCFullYear(),
          String(date.getUTCMonth() + 1).padStart(2, '0'),
          String(date.getUTCDate()).padStart(2, '0'),
        ].join('-');
      const end = new Date(beijingNow);
      end.setUTCDate(end.getUTCDate() + 7);
      checkRequest = {
        requestId: randomUUID(),
        sourceId: 'source-pumch-public-schedule',
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        dateFrom: formatDate(beijingNow),
        dateTo: formatDate(end),
        doctorName: null,
        titles: [],
        session: 'ANY',
        deadlineAt: new Date(checkedAt + 30_000).toISOString(),
      };
    }
    const parsed = checkRequestSchema.safeParse(checkRequest);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
    }

    const retryAfterMs = sourceRetryAfterMs(database, adapterKey, checkedAt);
    if (retryAfterMs > 0) {
      return reply.code(429).send({ error: 'SOURCE_RATE_LIMITED', retryAfterMs });
    }

    recordSourceAttempt(database, adapterKey, checkedAt, adapter.manifest.minIntervalMs);
    const result = await runSourceAdapter(adapter, parsed.data);
    recordSourceResult(
      database,
      adapterKey,
      result,
      checkedAt + adapter.manifest.minIntervalMs,
    );
    const scopeKey = createHash('sha256')
      .update(
        JSON.stringify([
          parsed.data.sourceId,
          parsed.data.hospitalId,
          parsed.data.campusId,
          parsed.data.departmentId,
          parsed.data.dateFrom,
          parsed.data.dateTo,
          parsed.data.doctorName,
          parsed.data.titles,
          parsed.data.session,
        ]),
      )
      .digest('hex');
    const eventsCreated = applyCheckResult(database, {
      sourceId: parsed.data.sourceId,
      scopeKey,
      requestId: parsed.data.requestId,
      result,
    });
    return { ...result, eventsCreated };
  });

  app.post('/api/notifications/:channel/test', async (request, reply) => {
    const { channel: channelKey } = request.params as { channel: string };
    const status = notificationStatuses.find((candidate) => candidate.key === channelKey);
    const channel = notificationChannels.get(channelKey);
    if (!status || !status.enabled || !channel) {
      return reply.code(409).send({
        error: 'NOTIFICATION_CHANNEL_DISABLED',
        reason: status?.reason ?? 'not_configured',
      });
    }

    const testedAt = now();
    const result = await sendNotification(channel, {
      messageId: `self-test-${randomUUID()}@easy-hospital.local`,
      subject: '北京挂号雷达测试通知',
      text: '这是一条本机通知渠道自检消息，不代表真实放号或可用号源。',
      officialEntryUrl: 'https://www.pumch.cn/news_visitinfo.html',
      eventTags: ['schedule_released'],
      detectedAt: new Date(testedAt).toISOString(),
    });
    return recordNotificationSelfTest(database, channelKey, result, testedAt);
  });

  app.get('/api/notifications/:channel/test-result', async (request, reply) => {
    const { channel: channelKey } = request.params as { channel: string };
    const result = getLatestNotificationSelfTest(database, channelKey);
    if (!result) return reply.code(404).send({ error: 'NOTIFICATION_SELF_TEST_NOT_FOUND' });
    return result;
  });

  app.get('/api/catalog', async () => readCatalog(database));

  app.post('/api/release-rules', async (request, reply) => {
    const parsed = releaseRuleInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        issues: parsed.error.issues,
      });
    }

    if (!hasOfficialRuleUrls(database, parsed.data)) {
      return reply.code(400).send({ error: 'UNOFFICIAL_URL' });
    }

    return reply.code(201).send(createReleaseRule(database, parsed.data));
  });

  app.get('/api/release-rules', async () => ({ rules: listReleaseRules(database) }));

  app.patch('/api/release-rules/:id', async (request, reply) => {
    const parsed = releaseRulePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
    }

    const { id } = request.params as { id: string };
    const current = getReleaseRule(database, id);
    if (!current) return reply.code(404).send({ error: 'RELEASE_RULE_NOT_FOUND' });
    const urlBoundaryChanged = ['hospitalId', 'officialEntryUrl', 'sourceUrl'].some((key) =>
      Object.prototype.hasOwnProperty.call(parsed.data, key),
    );
    if (urlBoundaryChanged && !hasOfficialRuleUrls(database, { ...current, ...parsed.data })) {
      return reply.code(400).send({ error: 'UNOFFICIAL_URL' });
    }
    return updateReleaseRule(database, id, parsed.data)!;
  });

  app.delete('/api/release-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deleteReleaseRule(database, id)) {
      return reply.code(404).send({ error: 'RELEASE_RULE_NOT_FOUND' });
    }
    return reply.code(204).send();
  });

  app.post('/api/watch-tasks', async (request, reply) => {
    const parsed = watchTaskInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
    }
    const task = createWatchTask(database, parsed.data);
    scheduleWatchTask(database, jobRunner, task, sourceAdapters, now());
    return reply.code(201).send(task);
  });

  app.get('/api/watch-tasks', async () => ({ tasks: listWatchTasks(database) }));

  app.get('/api/watch-tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = getWatchTask(database, id);
    if (!task) return reply.code(404).send({ error: 'WATCH_TASK_NOT_FOUND' });
    return task;
  });

  app.patch('/api/watch-tasks/:id', async (request, reply) => {
    const parsed = watchTaskPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
    }

    const { id } = request.params as { id: string };
    const result = updateWatchTask(database, id, parsed.data);
    if (result.status === 'not_found') {
      return reply.code(404).send({ error: 'WATCH_TASK_NOT_FOUND' });
    }
    if (result.status === 'version_conflict') {
      return reply.code(409).send({
        error: 'WATCH_TASK_VERSION_CONFLICT',
        currentVersion: result.currentVersion,
      });
    }
    scheduleWatchTask(database, jobRunner, result.task, sourceAdapters, now());
    return result.task;
  });

  app.delete('/api/watch-tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deleteWatchTask(database, id)) {
      return reply.code(404).send({ error: 'WATCH_TASK_NOT_FOUND' });
    }
    return reply.code(204).send();
  });

  app.get('/api/browser-agent/challenge', async (request, reply) => {
    const expectedToken = options.browserAgentToken;
    if (!expectedToken) {
      return reply.code(503).send({ error: 'BROWSER_AGENT_NOT_CONFIGURED' });
    }
    const nonce = (request.query as { nonce?: unknown }).nonce;
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      return reply.code(400).send({ error: 'BROWSER_AGENT_NONCE_INVALID' });
    }

    return reply.header('cache-control', 'no-store').send({
      algorithm: 'HMAC-SHA256',
      nonce,
      proof: createHmac('sha256', expectedToken).update(nonce).digest('hex'),
    });
  });

  app.post('/api/browser-agent/observations', async (request, reply) => {
    const expectedToken = options.browserAgentToken;
    if (!expectedToken) {
      return reply.code(503).send({ error: 'BROWSER_AGENT_NOT_CONFIGURED' });
    }

    const authorization = request.headers.authorization;
    const tokenMatch = authorization?.match(/^Bearer\s+(.+)$/i);
    const providedToken = tokenMatch?.[1] ?? '';
    const expectedDigest = createHash('sha256').update(expectedToken).digest();
    const providedDigest = createHash('sha256').update(providedToken).digest();
    if (!timingSafeEqual(expectedDigest, providedDigest)) {
      return reply.code(401).send({ error: 'BROWSER_AGENT_UNAUTHORIZED' });
    }

    const parsed = browserAgentIngestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR' });
    }

    const ingestedAt = now();
    const canonical = deriveBrowserAgentIngest(parsed.data);
    const observedAt = Date.parse(canonical.observedAt);
    const admission = assessBrowserAgentIngest(database, {
      requestId: canonical.requestId,
      observedAt,
      ingestedAt,
    });
    if (admission.status === 'rejected') {
      return reply.code(admission.statusCode).send({
        error: admission.errorCode,
        ...(admission.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: admission.retryAfterMs }),
      });
    }

    const contentHash = createHash('sha256')
      .update(JSON.stringify(canonical.observations))
      .digest('hex');
    const scopeKey = createHash('sha256')
      .update(
        JSON.stringify(
          canonical.observations.map((observation) => [
            observation.hospitalId,
            observation.campusId,
            observation.departmentId,
            observation.date,
            observation.session,
          ]),
        ),
      )
      .digest('hex');
    const eventsCreated = database.transaction(() => {
      const created = applyCheckResult(database, {
        sourceId: canonical.sourceId,
        scopeKey,
        requestId: canonical.requestId,
        result: {
          status: 'OK',
          observedAt: canonical.observedAt,
          nextAllowedAt: new Date(ingestedAt + 300_000).toISOString(),
          contentHash,
          observations: canonical.observations,
        },
      });
      recordBrowserAgentIngest(database, {
        requestId: canonical.requestId,
        sourceId: canonical.sourceId,
        observedAt,
        ingestedAt,
      });
      return created;
    })();
    return reply.code(202).send({ status: 'accepted', eventsCreated });
  });

  app.post('/api/source-checks/:adapterKey', async (request, reply) => {
    const { adapterKey } = request.params as { adapterKey: string };
    const adapter = sourceAdapters.get(adapterKey);
    if (!adapter) return reply.code(404).send({ error: 'SOURCE_ADAPTER_NOT_FOUND' });

    const parsed = checkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
    }

    const checkedAt = now();
    if (enforceSourceRateLimit) {
      const retryAfterMs = sourceRetryAfterMs(database, adapterKey, checkedAt);
      if (retryAfterMs > 0) {
        return reply.code(429).send({ error: 'SOURCE_RATE_LIMITED', retryAfterMs });
      }
      recordSourceAttempt(database, adapterKey, checkedAt, adapter.manifest.minIntervalMs);
    }

    const result = await runSourceAdapter(adapter, parsed.data);
    if (enforceSourceRateLimit) {
      recordSourceResult(
        database,
        adapterKey,
        result,
        checkedAt + adapter.manifest.minIntervalMs,
      );
    }
    const scopeKey = createHash('sha256')
      .update(
        JSON.stringify([
          parsed.data.sourceId,
          parsed.data.hospitalId,
          parsed.data.campusId,
          parsed.data.departmentId,
          parsed.data.dateFrom,
          parsed.data.dateTo,
          parsed.data.doctorName,
          parsed.data.titles,
          parsed.data.session,
        ]),
      )
      .digest('hex');
    const eventsCreated = applyCheckResult(database, {
      sourceId: parsed.data.sourceId,
      scopeKey,
      requestId: parsed.data.requestId,
      result,
    });
    return { ...result, eventsCreated };
  });

  app.get('/api/events', async () => ({ events: listDetectedEvents(database) }));

  app.get('/api/availability-states', async (request, reply) => {
    const sourceId = (request.query as { sourceId?: string }).sourceId;
    if (!sourceId) return reply.code(400).send({ error: 'SOURCE_ID_REQUIRED' });
    return { states: listAvailabilityStates(database, sourceId) };
  });

  app.get('/api/notification-batches', async () => ({
    batches: listNotificationBatches(database),
  }));

  app.setNotFoundHandler(async (request, reply) => {
    if (staticAvailable && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'NOT_FOUND' });
  });

  return app;
}
