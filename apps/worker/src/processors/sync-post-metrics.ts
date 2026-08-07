import { isPlatformError, type PlatformError } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/config';
import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import {
  emptyPostMetrics,
  type MetricSource,
  type PostMetrics,
  type QueuePayload,
} from '@socialhub/shared';
import { z } from 'zod';

import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';

const syncPostMetricsPayloadSchema = z.object({
  platformPostId: z.string().min(1),
  workspaceId: z.string().min(1),
  syncRunId: z.string().min(1).optional(),
});

type SyncPostMetricsPayload = QueuePayload<'sync-post-metrics'>;

export function createSyncPostMetricsProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = syncPostMetricsPayloadSchema.parse(job.data) as SyncPostMetricsPayload;
    const jobName = job.name ?? 'sync-post-metrics';
    const jobId = job.id ?? `sync-post-metrics-${payload.platformPostId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await syncPostMetrics(input, payload);
      await finishJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');
      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      const platformError = isPlatformError(error) ? error : null;
      const isDead = platformError
        ? !platformError.retryable || attempt >= maxAttempts
        : attempt >= maxAttempts;
      await finishJob(input.prisma, jobName, jobId, startedAt, isDead ? 'DEAD' : 'FAILED', {
        errorCode: platformError?.kind ?? 'UNKNOWN',
        errorMessage:
          error instanceof Error ? error.message : 'Lỗi không xác định khi sync metrics.',
        isDead,
      });
      if (platformError && !platformError.retryable) {
        logger.warn(
          {
            platformPostId: payload.platformPostId,
            workspaceId: payload.workspaceId,
            kind: platformError.kind,
            message: platformError.message,
          },
          'Bỏ retry sync metrics vì lỗi platform không thể tự khắc phục',
        );
        return { synced: false, reason: platformError.kind };
      }
      throw error;
    }
  };
}

async function syncPostMetrics(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
  },
  payload: SyncPostMetricsPayload,
) {
  const platformPost = await input.prisma.platformPost.findFirst({
    where: {
      id: payload.platformPostId,
      workspaceId: payload.workspaceId,
      status: 'PUBLISHED',
      externalPostId: { not: null },
    },
  });

  if (!platformPost?.externalPostId) return { synced: false, reason: 'platform_post_not_found' };
  const account = await input.prisma.socialAccount.findFirst({
    where: {
      id: platformPost.socialAccountId,
      workspaceId: payload.workspaceId,
      deletedAt: null,
    },
    include: { token: true },
  });
  if (!account) return { synced: false, reason: 'account_not_found' };
  if (!account.token || account.status !== 'CONNECTED') {
    return { synced: false, reason: 'account_disconnected' };
  }
  const workspace = await input.prisma.workspace.findUnique({
    where: { id: payload.workspaceId },
    select: { timezone: true },
  });

  const { adapters } = await input.adapterFactory.forWorkspace(payload.workspaceId);
  const adapter = adapters.get(account.platform);
  const accessToken = await getFreshAccessToken({
    prisma: input.prisma,
    keyring: input.keyring,
    adapter,
    account: {
      id: account.id,
      workspaceId: account.workspaceId,
      platform: account.platform,
      token: account.token,
    },
  });

  let metrics: PostMetrics;
  try {
    metrics = await adapter.getPostMetrics(
      {
        accessToken,
        externalAccountId: account.externalAccountId,
        externalPageId: account.externalPageId ?? undefined,
        correlationId: `sync-post-metrics-${platformPost.id}`,
      },
      platformPost.externalPostId,
    );
  } catch (error) {
    const metricUnavailableError = platformMetricUnavailableError(error);
    if (metricUnavailableError) {
      const fallbackMetrics = emptyPostMetrics('UNSUPPORTED');
      await persistPostMetrics({
        prisma: input.prisma,
        workspaceId: payload.workspaceId,
        platformPost,
        timezone: workspace?.timezone ?? 'UTC',
        metrics: fallbackMetrics,
        errorCode: metricUnavailableError.kind,
        errorMessage: metricUnavailableError.message,
      });
      logger.warn(
        {
          platformPostId: platformPost.id,
          platform: platformPost.platform,
          kind: metricUnavailableError.kind,
          message: metricUnavailableError.message,
        },
        'Metric bài không lấy được; đã ghi UNSUPPORTED thay vì retry',
      );
      return {
        synced: false,
        reason: metricUnavailableError.kind,
        platformPostId: platformPost.id,
      };
    }
    throw error;
  }

  await persistPostMetrics({
    prisma: input.prisma,
    workspaceId: payload.workspaceId,
    platformPost,
    timezone: workspace?.timezone ?? 'UTC',
    metrics,
  });

  logger.info(
    { platformPostId: platformPost.id, platform: platformPost.platform },
    'Đã sync post metrics',
  );
  return { synced: true, platformPostId: platformPost.id };
}

async function persistPostMetrics(input: {
  prisma: PrismaClientInstance;
  workspaceId: string;
  platformPost: NonNullable<Awaited<ReturnType<PrismaClientInstance['platformPost']['findFirst']>>>;
  timezone: string;
  metrics: PostMetrics;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const now = new Date();
  const today = metricDate(now, input.timezone);

  await input.prisma.$transaction([
    input.prisma.postMetric.upsert({
      where: { platformPostId: input.platformPost.id },
      create: {
        workspaceId: input.workspaceId,
        platformPostId: input.platformPost.id,
        ...postMetricWrite(input.metrics),
        lastSyncedAt: now,
      },
      update: {
        ...postMetricWrite(input.metrics),
        lastSyncedAt: now,
      },
    }),
    input.prisma.metricSnapshot.upsert({
      where: {
        platformPostId_metricDate: {
          platformPostId: input.platformPost.id,
          metricDate: today,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        platformPostId: input.platformPost.id,
        capturedAt: now,
        metricDate: today,
        ...snapshotWrite(input.metrics),
        source: dominantSource(input.metrics),
        raw: rawMetrics(input.metrics),
      },
      update: {
        capturedAt: now,
        ...snapshotWrite(input.metrics),
        source: dominantSource(input.metrics),
        raw: rawMetrics(input.metrics),
      },
    }),
    input.prisma.platformPost.update({
      where: { id: input.platformPost.id },
      data: {
        platformState: mergeMetricsState(
          input.platformPost.platformState,
          input.metrics,
        ) as unknown as Prisma.InputJsonValue,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      },
    }),
  ]);
}

function platformMetricUnavailableError(error: unknown): PlatformError | null {
  if (!isPlatformError(error)) return null;
  return error.kind === 'PERMISSION_DENIED' ||
    error.kind === 'NOT_FOUND' ||
    error.kind === 'CAPABILITY_UNSUPPORTED'
    ? error
    : null;
}

function postMetricWrite(metrics: PostMetrics) {
  return {
    views: metrics.views.value,
    viewsSource: metrics.views.source,
    likes: metrics.likes.value,
    likesSource: metrics.likes.source,
    comments: metrics.comments.value,
    commentsSource: metrics.comments.source,
    shares: metrics.shares.value,
    sharesSource: metrics.shares.source,
    reach: metrics.reach.value,
    reachSource: metrics.reach.source,
    impressions: metrics.impressions.value,
    impressionsSource: metrics.impressions.source,
    saves: metrics.saves.value,
    savesSource: metrics.saves.source,
    engagementRate: metrics.engagementRate.value,
    engagementRateSource: metrics.engagementRate.source,
    watchTime: metrics.watchTime.value,
    watchTimeSource: metrics.watchTime.source,
    avgWatchTime: metrics.avgWatchTime.value,
    avgWatchTimeSource: metrics.avgWatchTime.source,
    completionRate: metrics.completionRate.value,
    completionRateSource: metrics.completionRate.source,
    clicks: metrics.clicks.value,
    clicksSource: metrics.clicks.source,
    linkClicks: metrics.linkClicks.value,
    linkClicksSource: metrics.linkClicks.source,
  };
}

function snapshotWrite(metrics: PostMetrics) {
  return {
    views: metrics.views.value,
    likes: metrics.likes.value,
    comments: metrics.comments.value,
    shares: metrics.shares.value,
    reach: metrics.reach.value,
    impressions: metrics.impressions.value,
    saves: metrics.saves.value,
    watchTime: metrics.watchTime.value,
    avgWatchTime: metrics.avgWatchTime.value,
    completionRate: metrics.completionRate.value,
    clicks: metrics.clicks.value,
    linkClicks: metrics.linkClicks.value,
  };
}

function dominantSource(metrics: PostMetrics): MetricSource {
  const values = postMetricValues(metrics);
  if (values.some((metric) => metric.source === 'PLATFORM_API')) return 'PLATFORM_API';
  if (values.some((metric) => metric.source === 'DERIVED')) return 'DERIVED';
  if (values.every((metric) => metric.source === 'UNSUPPORTED')) return 'UNSUPPORTED';
  return 'NOT_SYNCED';
}

function postMetricValues(metrics: PostMetrics) {
  return [
    metrics.views,
    metrics.likes,
    metrics.comments,
    metrics.shares,
    metrics.reach,
    metrics.impressions,
    metrics.saves,
    metrics.engagement,
    metrics.engagementRate,
    metrics.watchTime,
    metrics.avgWatchTime,
    metrics.completionRate,
    metrics.clicks,
    metrics.linkClicks,
  ];
}

function rawMetrics(metrics: PostMetrics): Prisma.InputJsonValue | undefined {
  return metrics.raw === undefined ? undefined : (metrics.raw as Prisma.InputJsonValue);
}

function metricDate(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return new Date(Date.UTC(year, month - 1, day));
}

function mergeMetricsState(state: Prisma.JsonValue | null, metrics: PostMetrics) {
  const current = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    ...current,
    metrics,
    metricsRefreshedAt: new Date().toISOString(),
  };
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: SyncPostMetricsPayload,
  job: { attemptsMade?: number; opts?: { attempts?: number } },
  status: 'RUNNING',
) {
  await prisma.backgroundJob.upsert({
    where: { queueName_jobId: { queueName, jobId } },
    create: {
      workspaceId: payload.workspaceId,
      queueName,
      jobId,
      status,
      payload,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      correlationId: jobId,
    },
    update: {
      status,
      payload,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      isDead: false,
      correlationId: jobId,
    },
  });
}

async function finishJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  startedAt: Date,
  status: 'COMPLETED' | 'FAILED' | 'DEAD',
  error?: { errorCode?: string; errorMessage?: string; isDead?: boolean },
) {
  const finishedAt = new Date();
  await prisma.backgroundJob.update({
    where: { queueName_jobId: { queueName, jobId } },
    data: {
      status,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCode: error?.errorCode,
      errorMessage: error?.errorMessage,
      isDead: error?.isDead ?? status === 'DEAD',
    },
  });
}

export function createSyncPostMetricsPrisma(
  databaseUrl: string,
  logQueries: boolean,
): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
