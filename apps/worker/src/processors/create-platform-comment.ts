import { isPlatformError } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { PLATFORM_LABELS, type QueuePayload } from '@socialhub/shared';
import { z } from 'zod';
import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';

const createPlatformCommentPayloadSchema = z.object({
  platformPostId: z.string().min(1),
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
});

type CreatePlatformCommentPayload = QueuePayload<'create-platform-comment'>;

export function createCreatePlatformCommentProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: {
    forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext>;
  };
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = createPlatformCommentPayloadSchema.parse(
      job.data,
    ) as CreatePlatformCommentPayload;
    const jobName = job.name ?? 'create-platform-comment';
    const jobId = job.id ?? `create-platform-comment-${payload.platformPostId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await createPlatformComment(input, payload);
      await finishJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');
      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      const platformError = isPlatformError(error) ? error : null;
      const isDead = platformError
        ? !platformError.retryable || attempt >= maxAttempts
        : attempt >= maxAttempts;
      let errorCode: string =
        platformError?.kind ?? (error instanceof Error ? error.name : 'UNKNOWN');
      let errorMessage =
        error instanceof Error ? error.message : 'Lỗi không xác định khi tạo comment.';
      if (isDead && errorCode === 'NETWORK') {
        errorCode = 'REMOTE_RESULT_UNKNOWN';
        errorMessage =
          'Mất kết nối mạng khi đang gửi comment, không thể xác định nền tảng đã nhận được chưa.';
      }

      await finishJob(input.prisma, jobName, jobId, startedAt, isDead ? 'DEAD' : 'FAILED', {
        errorCode,
        errorMessage,
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
          'Bỏ retry tạo comment vì lỗi platform không thể tự khắc phục',
        );
        return { created: false, reason: platformError.kind };
      }
      throw error;
    }
  };
}

async function createPlatformComment(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: {
      forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext>;
    };
  },
  payload: CreatePlatformCommentPayload,
) {
  const platformPost = await input.prisma.platformPost.findFirst({
    where: {
      id: payload.platformPostId,
      workspaceId: payload.workspaceId,
      socialAccountId: payload.socialAccountId,
      status: 'PUBLISHED',
      externalPostId: { not: null },
    },
    include: {
      socialAccount: { include: { token: true } },
      contentPost: true,
    },
  });
  if (!platformPost?.externalPostId) {
    return { created: false, reason: 'platform_post_not_found' };
  }

  const account = platformPost.socialAccount;
  if (!account.token || account.status !== 'CONNECTED') {
    return { created: false, reason: 'account_disconnected' };
  }

  const adapterCtx = await input.adapterFactory.forWorkspace(payload.workspaceId);
  try {
    const { adapters } = adapterCtx;
    const adapter = adapters.requireCapability(account.platform, 'createComment');
    const createComment = adapter.createComment?.bind(adapter);
    if (!createComment) return { created: false, reason: 'capability_unsupported' };

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

    const result = await createComment(
      {
        accessToken,
        externalAccountId: account.externalAccountId,
        externalPageId: account.externalPageId ?? undefined,
        correlationId: payload.correlationId,
        logger,
      },
      platformPost.externalPostId,
      payload.message,
    );

    const comment = await input.prisma.comment.upsert({
      where: {
        socialAccountId_externalCommentId: {
          socialAccountId: account.id,
          externalCommentId: result.externalCommentId,
        },
      },
      create: {
        workspaceId: payload.workspaceId,
        platformPostId: platformPost.id,
        socialAccountId: account.id,
        platform: account.platform,
        externalCommentId: result.externalCommentId,
        parentId: null,
        authorExternalId: account.externalPageId ?? account.externalAccountId,
        authorName: account.name,
        authorAvatarUrl: account.avatarUrl,
        message: payload.message,
        likeCount: 0,
        postedAt: result.postedAt,
        status: 'RESOLVED',
        isHidden: false,
        isFromPage: true,
      },
      update: {
        message: payload.message,
        postedAt: result.postedAt,
        isFromPage: true,
        deletedAt: null,
      },
    });

    logger.info(
      {
        platformPostId: platformPost.id,
        commentId: comment.id,
        externalCommentId: result.externalCommentId,
        platform: account.platform,
      },
      'Đã tạo top-level comment trên platform',
    );

    return {
      created: true,
      commentId: comment.id,
      externalCommentId: result.externalCommentId,
      platform: PLATFORM_LABELS[account.platform],
    };
  } finally {
    await adapterCtx.release();
  }
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: CreatePlatformCommentPayload,
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
      payload: payload as Prisma.InputJsonValue,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      correlationId: payload.correlationId,
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

export function createCreatePlatformCommentPrisma(
  databaseUrl: string,
  logQueries: boolean,
): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
