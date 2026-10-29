import { createServer, type Server } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { loadEnvOrExit, loadWorkerEnv, type WorkerEnv } from '@socialhub/config';
import {
  AdapterRegistry,
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
} from '@socialhub/platform-adapters';
import { Keyring } from '@socialhub/security';
import { buildJobId, buildQueueJobOptions } from '@socialhub/shared';
import { RedisTokenRefreshLock } from '@socialhub/social-runtime';

import Redis from 'ioredis';
import { logger } from './logger';
import { WorkerAdapterFactory } from './utils/adapter-factory';
import { createCreatePlatformCommentProcessor } from './processors/create-platform-comment';
import { createDeletePlatformPostProcessor } from './processors/delete-platform-post';
import { createGenerateThumbnailProcessor } from './processors/generate-thumbnail';
import { createModeratePlatformCommentProcessor } from './processors/moderate-platform-comment';
import { createProcessWebhookProcessor } from './processors/process-webhook';
import { createPublishPostProcessor } from './processors/publish-post';
import {
  createRefreshSocialTokenProcessor,
  createWorkerPrisma,
} from './processors/refresh-social-token';
import { createReplyPlatformCommentProcessor } from './processors/reply-platform-comment';
import { createSyncAccountMetricsProcessor } from './processors/sync-account-metrics';
import { createSyncCommentsProcessor } from './processors/sync-comments';
import { createSyncExternalPostsProcessor } from './processors/sync-external-posts';
import { createSyncPostMetricsProcessor } from './processors/sync-post-metrics';
import { createCleanupUnusedMediaProcessor } from './processors/cleanup-unused-media';
import { createReconciliationProcessor } from './processors/reconciliation.processor';
import { createUpdatePlatformPostProcessor } from './processors/update-platform-post';
import { setWorkerTokenRefreshLock } from './processors/token-refresh';
import { JobLockService } from './queue/job-lock';
import { QueueRegistry } from './queue/queue-registry';
import { startScheduledPostScanner } from './schedulers/scheduled-post-scanner';
import { startOutboxDispatcher } from './outbox-dispatcher';

/**
 * Worker chạy như một process riêng, KHÔNG phải một phần của HTTP API.
 *
 * Lý do (ARCHITECTURE.md §3): một job upload video có thể mất vài phút. Nếu
 * chạy chung process với API, nó sẽ chiếm event loop và làm tăng latency của
 * mọi request; và mỗi lần deploy sẽ giết job đang chạy giữa chừng.
 */

let shuttingDown = false;

async function main(): Promise<void> {
  const env: WorkerEnv = loadEnvOrExit(loadWorkerEnv);

  logger.level = env.LOG_LEVEL;

  const connection = new Redis(env.REDIS_URL, {
    // BullMQ yêu cầu null: nó tự quản lý retry, và giới hạn của ioredis sẽ
    // xung đột với cơ chế đó.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const registry = new QueueRegistry(connection, env.WORKER_CONCURRENCY_MULTIPLIER);
  registry.createQueues();

  const prisma = createWorkerPrisma(env.DATABASE_URL, env.LOG_LEVEL === 'trace');
  await prisma.$connect();
  const keyring = Keyring.fromEnv(env.ENCRYPTION_KEYS, env.ENCRYPTION_ACTIVE_KEY);
  const adapterFactory = new WorkerAdapterFactory(prisma, keyring, env, connection);
  const defaultAdapters = createWebhookAdapterRegistry(env);
  const locks = new JobLockService(connection);
  const tokenRefreshLock = new RedisTokenRefreshLock(connection);
  setWorkerTokenRefreshLock(tokenRefreshLock);
  const storage = createStorageClient(env);

  const reconcileQueue = registry.getQueue('reconcile-platform-post');
  const cleanupMediaQueue = registry.getQueue('cleanup-unused-media');

  registry.registerWorker(
    'publish-post',
    createPublishPostProcessor({ prisma, keyring, adapterFactory, locks, storage, reconcileQueue }),
  );
  registry.registerWorker(
    'update-platform-post',
    createUpdatePlatformPostProcessor({ prisma, keyring, adapterFactory, locks }),
  );
  registry.registerWorker(
    'delete-platform-post',
    createDeletePlatformPostProcessor({
      prisma,
      keyring,
      adapterFactory,
      locks,
      cleanupMediaQueue,
    }),
  );
  registry.registerWorker(
    'retry-failed-post',
    createPublishPostProcessor({ prisma, keyring, adapterFactory, locks, storage, reconcileQueue }),
  );
  registry.registerWorker(
    'reconcile-platform-post',
    createReconciliationProcessor({ prisma, keyring, platformResolver: adapterFactory }),
  );
  registry.registerWorker(
    'refresh-social-token',
    createRefreshSocialTokenProcessor({
      prisma,
      keyring,
      adapterFactory,
      tokenRefreshLock,
      locks,
    }),
  );
  registry.registerWorker(
    'sync-comments',
    createSyncCommentsProcessor({ prisma, keyring, adapterFactory }),
  );
  registry.registerWorker(
    'create-platform-comment',
    createCreatePlatformCommentProcessor({ prisma, keyring, adapterFactory }),
  );
  registry.registerWorker(
    'reply-platform-comment',
    createReplyPlatformCommentProcessor({ prisma, keyring, adapterFactory }),
  );
  registry.registerWorker(
    'moderate-platform-comment',
    createModeratePlatformCommentProcessor({ prisma, keyring, adapterFactory, locks }),
  );
  registry.registerWorker(
    'sync-external-posts',
    createSyncExternalPostsProcessor({ prisma, keyring, adapterFactory }),
  );
  registry.registerWorker(
    'sync-post-metrics',
    createSyncPostMetricsProcessor({ prisma, keyring, adapterFactory }),
  );
  registry.registerWorker(
    'sync-account-metrics',
    createSyncAccountMetricsProcessor({ prisma, keyring, adapterFactory }),
  );
  registry.registerWorker(
    'process-webhook',
    createProcessWebhookProcessor({
      prisma,
      adapters: defaultAdapters,
      syncCommentsQueue: registry.getQueue('sync-comments'),
      onJobQueued: (info) => {
        registry.publishRealtime(info.workspaceId, {
          type: 'job.queued',
          queueName: 'sync-comments',
          jobId: info.jobId,
          socialAccountId: info.socialAccountId,
          platformPostId: info.platformPostId,
        });
      },
    }),
  );
  registry.registerWorker(
    'generate-thumbnail',
    createGenerateThumbnailProcessor({ prisma, storage }),
  );
  registry.registerWorker(
    'cleanup-unused-media',
    createCleanupUnusedMediaProcessor({ prisma, storage }),
  );
  const scheduledPostScanner = startScheduledPostScanner({
    prisma,
    publishQueue: registry.getQueue('publish-post'),
    enabled: env.SCHEDULER_ENABLED,
    onJobQueued: (info) => {
      registry.publishRealtime(info.workspaceId, {
        type: 'job.queued',
        queueName: 'publish-post',
        jobId: info.jobId,
        contentPostId: info.contentPostId,
        platformPostId: info.platformPostId,
      });
      registry.publishRealtime(info.workspaceId, {
        type: 'posts.changed',
        queueName: 'publish-post',
        jobId: info.jobId,
        contentPostId: info.contentPostId,
        platformPostId: info.platformPostId,
      });
    },
  });
  const outboxDispatcher = startOutboxDispatcher({
    prisma,
    registry,
    batchSize: env.OUTBOX_BATCH_SIZE,
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    claimLeaseMs: env.OUTBOX_CLAIM_LEASE_MS,
  });
  const mediaCleanupScheduler = startMediaCleanupScheduler({
    cleanupMediaQueue,
    enabled: env.SCHEDULER_ENABLED,
  });
  logger.info({ workers: registry.getWorkerCount() }, 'Đã đăng ký processor Phase 3');

  const healthServer = startHealthServer(env, registry, connection);

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Nhận tín hiệu dừng');
    scheduledPostScanner.stop();
    outboxDispatcher.stop();
    mediaCleanupScheduler.stop();
    healthServer.close();
    await registry.shutdown(30_000);
    await adapterFactory.close();
    await prisma.$disconnect();
    await connection.quit().catch(() => connection.disconnect());
    logger.info('Worker đã dừng');
    process.exit(0);
  };

  // eslint-disable-next-line no-restricted-properties
  if (env.NODE_ENV !== 'production' && process.env.LOG_DIRECT_OUTBOUND_IP === 'true') {
    fetch('https://api.ipify.org?format=json')
      .then((r) => r.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((data: any) => logger.info(`🌐 Direct outbound IP của Worker: ${data.ip}`))
      .catch((err) => logger.warn(`Không lấy được Outbound IP: ${err.message}`));
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ err: reason }, 'Promise bị reject mà không được xử lý');
  });

  logger.info({ port: env.WORKER_HEALTH_PORT }, 'Worker sẵn sàng');
}

function startMediaCleanupScheduler(input: {
  cleanupMediaQueue: ReturnType<QueueRegistry['getQueue']>;
  enabled: boolean;
}): { stop: () => void } {
  if (!input.enabled) {
    return { stop: () => undefined };
  }

  const enqueue = () => {
    const bucketKey = `periodic-${Math.floor(Date.now() / (6 * 60 * 60 * 1000))}`;
    const payload = { olderThanDays: 1, triggerKey: bucketKey };
    const jobId = buildJobId('cleanup-unused-media', payload);
    void input.cleanupMediaQueue
      .add('cleanup-unused-media', payload, buildQueueJobOptions('cleanup-unused-media', jobId))
      .catch((err: unknown) => {
        logger.warn({ err }, 'Không thể enqueue lịch định kỳ cleanup-unused-media');
      });
  };

  const initialTimer = setTimeout(enqueue, 30_000);
  const intervalTimer = setInterval(enqueue, 6 * 60 * 60 * 1000);
  initialTimer.unref();
  intervalTimer.unref();

  return {
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

function createStorageClient(env: WorkerEnv): {
  client: S3Client;
  bucket: string;
  publicBaseUrl?: string;
} {
  return {
    bucket: env.S3_BUCKET,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    client: new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5000,
        socketTimeout: 30000,
      }),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
  };
}

function createWebhookAdapterRegistry(env: WorkerEnv): AdapterRegistry {
  return createRuntimeAdapterRegistry({
    nodeEnv: env.NODE_ENV,
    fetch: createWebhookParsingFetch(),
    facebook: {
      appId: env.FACEBOOK_APP_ID,
      appSecret: env.FACEBOOK_APP_SECRET,
      apiVersion: env.FACEBOOK_API_VERSION,
      loginConfigId: env.FACEBOOK_LOGIN_CONFIG_ID,
    },
    instagram: {
      appId: env.INSTAGRAM_APP_ID,
      appSecret: env.INSTAGRAM_APP_SECRET,
      apiVersion: env.FACEBOOK_API_VERSION,
    },
    pinterest: {
      appId: env.PINTEREST_APP_ID,
      appSecret: env.PINTEREST_APP_SECRET,
      defaultBoardName: env.PINTEREST_DEFAULT_BOARD_NAME,
      environment: env.PINTEREST_API_ENVIRONMENT,
    },
    youtube: {
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
    },
    tiktok: {
      clientKey: env.TIKTOK_CLIENT_KEY,
      clientSecret: env.TIKTOK_CLIENT_SECRET,
      scopes: [...TIKTOK_OAUTH_SCOPES],
    },
  });
}

function createWebhookParsingFetch(): typeof fetch {
  return (() => {
    throw new Error('Webhook parsing registry must not perform outbound social HTTP requests.');
  }) as typeof fetch;
}

/**
 * HTTP server tối giản chỉ để phục vụ health check.
 *
 * Worker không phục vụ traffic, nhưng orchestrator vẫn cần biết nó còn sống —
 * nếu không, một worker treo sẽ nằm im mãi mà không ai phát hiện.
 */
function startHealthServer(env: WorkerEnv, registry: QueueRegistry, connection: Redis): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: shuttingDown ? 'shutting_down' : 'ok',
          uptimeSeconds: Math.floor(process.uptime()),
          queues: registry.getQueueNames().length,
          workers: registry.getWorkerCount(),
        }),
      );
      return;
    }

    if (req.url === '/ready') {
      const ready = !shuttingDown && connection.status === 'ready';
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, redis: connection.status }));
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(env.WORKER_HEALTH_PORT);
  return server;
}

void main().catch((error: unknown) => {
  console.error('Khởi động worker thất bại:', error);
  process.exit(1);
});
