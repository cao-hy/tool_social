import { isPlatformError, type SocialPlatformAdapter } from '@socialhub/platform-adapters';
import { createPrismaClient, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';

import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import type { PlatformComment } from '@socialhub/platform-adapters';
import { z } from 'zod';

import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';

const syncCommentsPayloadSchema = z.object({
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
  platformPostId: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  correlationId: z.string().min(1).optional(),
});

export function createSyncCommentsProcessor(input: {
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
    const payload = syncCommentsPayloadSchema.parse(job.data);
    const jobName = job.name ?? 'sync-comments';
    const jobId = job.id ?? `sync-comments:${payload.socialAccountId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await syncComments(input, payload);
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
            error instanceof Error ? error.message : 'Lỗi không xác định khi sync comments.',
          isDead: attempt >= maxAttempts,
        },
      );
      throw error;
    }
  };
}

async function syncComments(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
  },
  payload: z.infer<typeof syncCommentsPayloadSchema>,
) {
  const account = await input.prisma.socialAccount.findFirst({
    where: { id: payload.socialAccountId, workspaceId: payload.workspaceId, deletedAt: null },
    include: { token: true },
  });
  if (!account) return { synced: 0, reason: 'account_not_found' };

  const adapterCtx = await input.adapterFactory.forWorkspace(payload.workspaceId);
  try {
    const { adapters } = adapterCtx;
    const adapter = adapters.get(account.platform);
    const getComments = adapter.getComments?.bind(adapter);
    if (!getComments) {
      await input.prisma.notification.create({
        data: {
          workspaceId: payload.workspaceId,
          userId: await workspaceOwnerId(input.prisma, payload.workspaceId),
          type: 'SYNC_JOB_FAILED',
          title: 'Sync comments chưa khả dụng',
          body: `${account.platform} chưa có adapter getComments được xác minh.`,
          linkUrl: '/inbox',
          data: { socialAccountId: account.id, platform: account.platform },
        },
      });
      logger.warn({ platform: account.platform }, 'Adapter chưa hỗ trợ getComments');
      return { synced: 0, reason: 'capability_unsupported' };
    }

    if (!account.token || account.status !== 'CONNECTED') {
      return { synced: 0, reason: 'account_disconnected' };
    }

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

    const ctx = {
      accessToken,
      externalAccountId: account.externalAccountId,
      externalPageId: account.externalPageId ?? undefined,
      correlationId: payload.correlationId ?? `sync-comments:${account.id}`,
    };

    if (payload.platformPostId) {
      const platformPost = await input.prisma.platformPost.findFirst({
        where: { id: payload.platformPostId, workspaceId: payload.workspaceId },
      });
      if (!platformPost?.externalPostId) return { synced: 0, reason: 'platform_post_not_found' };
      return syncPlatformPostComments(
        input.prisma,
        getComments,
        ctx,
        payload,
        account,
        platformPost,
      );
    }

    const platformPosts = await input.prisma.platformPost.findMany({
      where: {
        workspaceId: payload.workspaceId,
        socialAccountId: account.id,
        externalPostId: { not: null },
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 25,
    });

    let synced = 0;
    let failedPosts = 0;
    let lastErrorMessage: string | null = null;
    for (const platformPost of platformPosts) {
      try {
        const result = await syncPlatformPostComments(
          input.prisma,
          getComments,
          ctx,
          payload,
          account,
          platformPost,
        );
        synced += result.synced;
      } catch (error) {
        failedPosts += 1;
        lastErrorMessage =
          error instanceof Error ? error.message : 'Lỗi không xác định khi sync comment cho post.';
        logger.warn(
          {
            workspaceId: payload.workspaceId,
            socialAccountId: account.id,
            platformPostId: platformPost.id,
            externalPostId: platformPost.externalPostId,
            err: isPlatformError(error) ? error.toLogObject() : error,
          },
          'Bỏ qua một platform post không sync được comments',
        );
      }
    }

    await input.prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        lastSyncedAt: new Date(),
        lastErrorAt: failedPosts > 0 ? new Date() : null,
        lastErrorMessage:
          failedPosts > 0
            ? `Không sync được comments của ${failedPosts}/${platformPosts.length} bài. Lỗi gần nhất: ${lastErrorMessage}`
            : null,
      },
    });

    return { synced, scannedPosts: platformPosts.length, failedPosts };
  } finally {
    await adapterCtx.release();
  }
}

async function syncPlatformPostComments(
  prisma: PrismaClientInstance,
  getComments: NonNullable<SocialPlatformAdapter['getComments']>,
  ctx: {
    accessToken: string;
    externalAccountId: string;
    externalPageId?: string;
    correlationId: string;
  },
  payload: z.infer<typeof syncCommentsPayloadSchema>,
  account: NonNullable<Awaited<ReturnType<PrismaClientInstance['socialAccount']['findFirst']>>>,
  platformPost: NonNullable<Awaited<ReturnType<PrismaClientInstance['platformPost']['findFirst']>>>,
) {
  if (!platformPost.externalPostId) return { synced: 0, hasMore: false, nextCursor: null };

  const result = await getComments(ctx, {
    externalPostId: platformPost.externalPostId,
    since: payload.since ? new Date(payload.since) : undefined,
  });

  let synced = 0;
  const syncedComments = new Map<string, { id: string; parentExternalCommentId?: string }>();
  for (const comment of result.items) {
    const targetPlatformPost = await findPlatformPostForComment(
      prisma,
      payload.workspaceId,
      account.id,
      comment,
    );
    if (!targetPlatformPost) continue;

    const syncedComment = await prisma.comment.upsert({
      where: {
        socialAccountId_externalCommentId: {
          socialAccountId: account.id,
          externalCommentId: comment.externalCommentId,
        },
      },
      create: {
        workspaceId: payload.workspaceId,
        platformPostId: targetPlatformPost.id,
        socialAccountId: account.id,
        platform: account.platform,
        externalCommentId: comment.externalCommentId,
        parentId: null,
        authorExternalId: comment.authorExternalId,
        authorName: comment.authorName,
        authorAvatarUrl: comment.authorAvatarUrl,
        message: comment.message,
        likeCount: comment.likeCount,
        postedAt: comment.postedAt,
        isHidden: comment.isHidden ?? false,
        isFromPage: comment.isFromOwner ?? false,
      },
      update: {
        authorName: comment.authorName,
        authorAvatarUrl: comment.authorAvatarUrl,
        message: comment.message,
        likeCount: comment.likeCount,
        postedAt: comment.postedAt,
        isHidden: comment.isHidden ?? false,
        isFromPage: comment.isFromOwner ?? false,
      },
    });
    syncedComments.set(comment.externalCommentId, {
      id: syncedComment.id,
      parentExternalCommentId: comment.parentExternalCommentId,
    });
    synced += 1;
  }

  for (const [externalCommentId, syncedComment] of syncedComments) {
    if (!syncedComment.parentExternalCommentId) continue;
    const parent =
      syncedComments.get(syncedComment.parentExternalCommentId) ??
      (await prisma.comment.findUnique({
        where: {
          socialAccountId_externalCommentId: {
            socialAccountId: account.id,
            externalCommentId: syncedComment.parentExternalCommentId,
          },
        },
        select: { id: true },
      }));
    if (!parent) continue;
    await prisma.comment.update({
      where: {
        socialAccountId_externalCommentId: {
          socialAccountId: account.id,
          externalCommentId,
        },
      },
      data: { parentId: parent.id },
    });
  }

  return { synced, hasMore: result.hasMore, nextCursor: result.nextCursor };
}

async function findPlatformPostForComment(
  prisma: PrismaClientInstance,
  workspaceId: string,
  socialAccountId: string,
  comment: PlatformComment,
) {
  return prisma.platformPost.findFirst({
    where: {
      workspaceId,
      socialAccountId,
      externalPostId: comment.externalPostId,
    },
  });
}

async function workspaceOwnerId(
  prisma: PrismaClientInstance,
  workspaceId: string,
): Promise<string> {
  const owner = await prisma.workspaceMember.findFirst({
    where: { workspaceId, role: 'OWNER' },
    select: { userId: true },
  });
  return owner?.userId ?? '';
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: z.infer<typeof syncCommentsPayloadSchema>,
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
      correlationId: payload.correlationId,
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
      correlationId: payload.correlationId,
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

export function createSyncCommentsPrisma(
  databaseUrl: string,
  logQueries: boolean,
): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
