import { AdapterRegistry, isPlatformError } from '@socialhub/platform-adapters';
import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import type { AccountMetrics, MetricSource, QueuePayload } from '@socialhub/shared';
import { z } from 'zod';

import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';

const syncAccountMetricsPayloadSchema = z.object({
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
  syncRunId: z.string().min(1).optional(),
});

type SyncAccountMetricsPayload = QueuePayload<'sync-account-metrics'>;

export function createSyncAccountMetricsProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: { forWorkspace(workspaceId: string): Promise<AdapterRegistry> };
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = syncAccountMetricsPayloadSchema.parse(job.data) as SyncAccountMetricsPayload;
    const jobName = job.name ?? 'sync-account-metrics';
    const jobId = job.id ?? `sync-account-metrics-${payload.socialAccountId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await syncAccountMetrics(input, payload);
      await finishJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');
      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      await finishJob(
        input.prisma,
        jobName,
        jobId,
        startedAt,
        attempt >= maxAttempts ? 'DEAD' : 'FAILED',
        {
          errorCode: isPlatformError(error) ? error.kind : 'UNKNOWN',
          errorMessage:
            error instanceof Error ? error.message : 'Lỗi không xác định khi sync account metrics.',
          isDead: attempt >= maxAttempts,
        },
      );
      throw error;
    }
  };
}

async function syncAccountMetrics(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: { forWorkspace(workspaceId: string): Promise<AdapterRegistry> };
  },
  payload: SyncAccountMetricsPayload,
) {
  const account = await input.prisma.socialAccount.findFirst({
    where: {
      id: payload.socialAccountId,
      workspaceId: payload.workspaceId,
      deletedAt: null,
    },
    include: { token: true, workspace: { select: { timezone: true } } },
  });
  if (!account) return { synced: false, reason: 'account_not_found' };
  if (!account.token || account.status !== 'CONNECTED') {
    return { synced: false, reason: 'account_disconnected' };
  }

  const adapters = await input.adapterFactory.forWorkspace(payload.workspaceId);
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

  const now = new Date();
  const today = metricDate(now, account.workspace.timezone);
  const metrics = adapter.getAccountMetrics
    ? await adapter.getAccountMetrics(
        {
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: `sync-account-metrics-${account.id}`,
        },
        { from: addDays(today, -30), to: today },
      )
    : emptyAccountMetrics('UNSUPPORTED');

  await input.prisma.metricSnapshot.upsert({
    where: {
      socialAccountId_metricDate: {
        socialAccountId: account.id,
        metricDate: today,
      },
    },
    create: {
      workspaceId: payload.workspaceId,
      socialAccountId: account.id,
      capturedAt: now,
      metricDate: today,
      followers: metrics.followers.value,
      reach: metrics.reach.value,
      impressions: metrics.impressions.value,
      source: dominantSource(metrics),
      raw: rawMetrics(metrics),
    },
    update: {
      capturedAt: now,
      followers: metrics.followers.value,
      reach: metrics.reach.value,
      impressions: metrics.impressions.value,
      source: dominantSource(metrics),
      raw: rawMetrics(metrics),
    },
  });

  logger.info(
    { socialAccountId: account.id, platform: account.platform },
    'Đã sync account metrics',
  );
  return { synced: true, socialAccountId: account.id };
}

function emptyAccountMetrics(source: MetricSource): AccountMetrics {
  const metric = { value: null, source };
  return {
    followers: { ...metric },
    followersGained: { ...metric },
    reach: { ...metric },
    impressions: { ...metric },
    profileViews: { ...metric },
  };
}

function dominantSource(metrics: AccountMetrics): MetricSource {
  const values = [
    metrics.followers,
    metrics.followersGained,
    metrics.reach,
    metrics.impressions,
    metrics.profileViews,
  ];
  if (values.some((metric) => metric.source === 'PLATFORM_API')) return 'PLATFORM_API';
  if (values.some((metric) => metric.source === 'DERIVED')) return 'DERIVED';
  if (values.every((metric) => metric.source === 'UNSUPPORTED')) return 'UNSUPPORTED';
  return 'NOT_SYNCED';
}

function rawMetrics(metrics: AccountMetrics): Prisma.InputJsonValue | undefined {
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

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: SyncAccountMetricsPayload,
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
  await prisma.backgroundJob.updateMany({
    where: { queueName, jobId },
    data: {
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      errorCode: error?.errorCode,
      errorMessage: error?.errorMessage,
      isDead: error?.isDead ?? status === 'DEAD',
    },
  });
}

export function createSyncAccountMetricsPrisma(
  databaseUrl: string,
  logQueries: boolean,
): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
