import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { isPlatformError, type ExternalPost } from '@socialhub/platform-adapters';
import { Prisma, type Platform, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import type { QueuePayload } from '@socialhub/shared';
import { z } from 'zod';

import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';

const syncExternalPostsPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  socialAccountId: z.string().min(1),
  requestedByUserId: z.string().min(1),
  cutoffDays: z.number().int().min(1).default(365),
  resumeFromJobId: z.string().optional(),
});

type SyncExternalPostsPayload = QueuePayload<'sync-external-posts'>;

export function createSyncExternalPostsProcessor(input: {
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
    const payload = syncExternalPostsPayloadSchema.parse(job.data) as SyncExternalPostsPayload;
    const jobName = job.name ?? 'sync-external-posts';
    const jobId = job.id ?? `sync-external-posts-${payload.socialAccountId}`;
    const startedAt = new Date();
    const syncJobId = payload.resumeFromJobId;

    if (!syncJobId) {
      logger.warn({ payload }, 'Job missing resumeFromJobId');
      return;
    }

    const syncJob = await input.prisma.externalPostSyncJob.findUnique({
      where: { id: syncJobId },
    });

    if (!syncJob || syncJob.status === 'COMPLETED' || syncJob.status === 'FAILED') {
      return; // Already done or dead
    }

    await markBackgroundJob(input.prisma, jobName, jobId, payload, job, 'RUNNING', syncJob.id);

    try {
      await input.prisma.externalPostSyncJob.update({
        where: { id: syncJob.id },
        data: { status: 'RUNNING', startedAt: new Date() },
      });

      const result = await syncPostsLoop(input, payload, syncJob);

      await input.prisma.externalPostSyncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          ...result,
        },
      });
      await finishBackgroundJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');

      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 3;
      const isDead = attempt >= maxAttempts;

      if (isDead) {
        await input.prisma.externalPostSyncJob.update({
          where: { id: syncJob.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            lastError: errorToJson(error),
          },
        });
      }
      await finishBackgroundJob(
        input.prisma,
        jobName,
        jobId,
        startedAt,
        isDead ? 'DEAD' : 'FAILED',
        {
          errorCode: isPlatformError(error) ? error.kind : 'UNKNOWN',
          errorMessage:
            error instanceof Error ? error.message : 'Lỗi không xác định khi kéo bài ngoại lai.',
          isDead,
        },
      );
      throw error;
    }
  };
}

async function syncPostsLoop(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
  },
  payload: z.infer<typeof syncExternalPostsPayloadSchema>,
  syncJob: NonNullable<
    Awaited<ReturnType<PrismaClientInstance['externalPostSyncJob']['findUnique']>>
  >,
) {
  const account = await input.prisma.socialAccount.findUnique({
    where: { id: payload.socialAccountId, workspaceId: payload.workspaceId, deletedAt: null },
    include: { token: true },
  });
  if (!account) throw new Error('Account not found');

  const { adapters } = await input.adapterFactory.forWorkspace(payload.workspaceId);
  const adapter = adapters.requireCapability(account.platform, 'getPosts');
  const getPosts = adapter.getPosts;
  if (!getPosts) {
    throw new Error(`Adapter ${account.platform} chưa triển khai getPosts.`);
  }

  if (!account.token || account.status !== 'CONNECTED') {
    throw new Error('Account disconnected');
  }

  const accessToken = await getFreshAccessToken({
    prisma: input.prisma,
    keyring: input.keyring,
    adapter: adapter,
    account,
  });

  const ctx = {
    accessToken,
    externalAccountId: account.externalAccountId,
    externalPageId: account.externalPageId ?? undefined,
    correlationId: syncJob.id,
  };

  let cursor = syncJob.cursor;
  let hasMore = true;
  let scannedCount = syncJob.scannedCount;
  let importedCount = syncJob.importedCount;
  let updatedCount = syncJob.updatedCount;
  let skippedCount = syncJob.skippedCount;
  let failedCount = syncJob.failedCount;
  const cutoffDate = syncJob.cutoffDate;

  while (hasMore) {
    const page = await getPosts.call(adapter, ctx, {
      cursor: cursor ?? undefined,
      since: cutoffDate,
      limit: 50,
    });

    let reachedCutoff = false;
    for (const post of page.items) {
      if (post.publishedAt < cutoffDate) {
        reachedCutoff = true;
        skippedCount++;
        continue;
      }

      scannedCount++;
      try {
        const result = await importPost(input.prisma, account, payload.requestedByUserId, post);
        if (result === 'created') importedCount++;
        if (result === 'updated') updatedCount++;
      } catch (error) {
        failedCount++;
        logger.warn(
          {
            syncJobId: syncJob.id,
            socialAccountId: account.id,
            platform: account.platform,
            externalPostId: post.externalPostId,
            err: error,
          },
          'Không import được bài external',
        );
      }
    }

    cursor = page.nextCursor ?? null;
    hasMore = !reachedCutoff && page.hasMore && !!cursor;

    await input.prisma.externalPostSyncJob.update({
      where: { id: syncJob.id },
      data: { cursor, scannedCount, importedCount, updatedCount, skippedCount, failedCount },
    });

    if (hasMore) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await input.prisma.socialAccount.update({
    where: { id: account.id },
    data: { lastSyncedAt: new Date() },
  });

  return { scannedCount, importedCount, updatedCount, skippedCount, failedCount };
}

async function importPost(
  prisma: PrismaClientInstance,
  account: { id: string; workspaceId: string; platform: Platform },
  createdByUserId: string,
  post: ExternalPost,
): Promise<'created' | 'updated'> {
  const existing = await prisma.platformPost.findUnique({
    where: {
      workspaceId_socialAccountId_platform_externalPostId: {
        workspaceId: account.workspaceId,
        socialAccountId: account.id,
        platform: account.platform,
        externalPostId: post.externalPostId,
      },
    },
  });

  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.contentPost.update({
        where: { id: existing.contentPostId },
        data: {
          title: post.title,
          body: post.caption ?? post.description ?? '',
          externalSyncedAt: new Date(),
          externalPermalink: post.permalink,
          externalAuthor: externalAuthorJson(post),
          publishedAt: post.publishedAt,
        },
      });
      await tx.platformPost.update({
        where: { id: existing.id },
        data: {
          title: post.title,
          caption: post.caption ?? post.description,
          externalUrl: post.permalink,
          externalCreatedAt: post.publishedAt,
          externalUpdatedAt: post.updatedAt,
          externalRaw: post.raw as Prisma.InputJsonValue,
          publishedAt: post.publishedAt,
          status: 'PUBLISHED',
        },
      });
    });
    return 'updated';
  }

  await prisma.$transaction(async (tx) => {
    const contentPost = await tx.contentPost.create({
      data: {
        workspaceId: account.workspaceId,
        createdById: createdByUserId,
        status: 'PUBLISHED',
        title: post.title,
        body: post.caption ?? post.description ?? '',
        sourceType: 'EXTERNAL',
        externalSyncedAt: new Date(),
        externalPermalink: post.permalink,
        externalAuthor: externalAuthorJson(post),
        publishedAt: post.publishedAt,
      },
    });

    await tx.platformPost.create({
      data: {
        workspaceId: account.workspaceId,
        contentPostId: contentPost.id,
        socialAccountId: account.id,
        platform: account.platform,
        status: 'PUBLISHED',
        title: post.title,
        caption: post.caption ?? post.description,
        externalPostId: post.externalPostId,
        externalUrl: post.permalink,
        externalCreatedAt: post.publishedAt,
        externalUpdatedAt: post.updatedAt,
        externalRaw: post.raw as Prisma.InputJsonValue,
        syncSource: 'API',
        publishedAt: post.publishedAt,
      },
    });
  });

  return 'created';
}

function externalAuthorJson(post: ExternalPost): Prisma.InputJsonValue | undefined {
  const raw = post.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const maybeRaw = raw as Record<string, unknown>;
  const author =
    maybeRaw.author ?? maybeRaw.owner ?? maybeRaw.user ?? maybeRaw.channelTitle ?? maybeRaw.from;
  return author && typeof author === 'object' ? (author as Prisma.InputJsonValue) : undefined;
}

function errorToJson(error: unknown): Prisma.InputJsonValue {
  if (isPlatformError(error)) return error.toLogObject() as Prisma.InputJsonValue;
  if (error instanceof Error) return { message: error.message };
  return { message: 'Lỗi không xác định' };
}

async function markBackgroundJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: SyncExternalPostsPayload,
  job: { attemptsMade?: number; opts?: { attempts?: number } },
  status: 'RUNNING',
  correlationId: string,
) {
  await prisma.backgroundJob.upsert({
    where: { queueName_jobId: { queueName, jobId } },
    create: {
      workspaceId: payload.workspaceId,
      queueName,
      jobId,
      status,
      payload: payload as Prisma.InputJsonValue,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      correlationId,
    },
    update: {
      status,
      payload: payload as Prisma.InputJsonValue,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      isDead: false,
      correlationId,
    },
  });
}

async function finishBackgroundJob(
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
