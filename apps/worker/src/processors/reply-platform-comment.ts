import { isPlatformError } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { PLATFORM_LABELS, type QueuePayload } from '@socialhub/shared';
import { z } from 'zod';
import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';

const replyPlatformCommentPayloadSchema = z.object({
  commentId: z.string().min(1),
  workspaceId: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
  replyRecordId: z.string().min(1).optional(),
});

type ReplyPlatformCommentPayload = QueuePayload<'reply-platform-comment'>;

export function createReplyPlatformCommentProcessor(input: {
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
    const payload = replyPlatformCommentPayloadSchema.parse(
      job.data,
    ) as ReplyPlatformCommentPayload;
    const jobName = job.name ?? 'reply-platform-comment';
    const jobId = job.id ?? `reply-platform-comment-${payload.commentId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await replyPlatformComment(input, payload);
      await finishJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');
      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      const platformError = isPlatformError(error) ? error : null;
      const isDead = platformError
        ? !platformError.retryable || attempt >= maxAttempts
        : attempt >= maxAttempts;
      await markReplyFailed(input.prisma, payload, error);
      let errorCode: string =
        platformError?.kind ?? (error instanceof Error ? error.name : 'UNKNOWN');
      let errorMessage =
        error instanceof Error ? error.message : 'Lỗi không xác định khi reply comment.';
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
            commentId: payload.commentId,
            workspaceId: payload.workspaceId,
            kind: platformError.kind,
            message: platformError.message,
          },
          'Bỏ retry reply comment vì lỗi platform không thể tự khắc phục',
        );
        return { replied: false, reason: platformError.kind };
      }
      throw error;
    }
  };
}

async function replyPlatformComment(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: {
      forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext>;
    };
  },
  payload: ReplyPlatformCommentPayload,
) {
  const comment = await input.prisma.comment.findFirst({
    where: { id: payload.commentId, workspaceId: payload.workspaceId, deletedAt: null },
    include: {
      parent: { select: { externalCommentId: true } },
      socialAccount: { include: { token: true } },
      platformPost: true,
    },
  });
  if (!comment) return { replied: false, reason: 'comment_not_found' };

  const account = comment.socialAccount;
  if (!account.token || account.status !== 'CONNECTED') {
    return { replied: false, reason: 'account_disconnected' };
  }

  const adapterCtx = await input.adapterFactory.forWorkspace(payload.workspaceId);
  try {
    const { adapters } = adapterCtx;
    const adapter = adapters.requireCapability(account.platform, 'replyToComment');
    const replyToComment = adapter.replyToComment?.bind(adapter);
    if (!replyToComment) return { replied: false, reason: 'capability_unsupported' };

    const reply = payload.replyRecordId
      ? await input.prisma.commentReply.findFirst({
          where: { id: payload.replyRecordId, workspaceId: payload.workspaceId },
        })
      : await input.prisma.commentReply.create({
          data: {
            workspaceId: payload.workspaceId,
            commentId: comment.id,
            message: payload.message,
            sentById: payload.requestedByUserId,
          },
        });
    if (!reply) return { replied: false, reason: 'reply_record_not_found' };

    const targetExternalCommentId =
      account.platform === 'YOUTUBE' && comment.parent?.externalCommentId
        ? comment.parent.externalCommentId
        : comment.externalCommentId;
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
    const result = await replyToComment(
      {
        accessToken,
        externalAccountId: account.externalAccountId,
        externalPageId: account.externalPageId ?? undefined,
        correlationId: payload.correlationId,
        logger,
      },
      targetExternalCommentId,
      payload.message,
    );

    await input.prisma.$transaction([
      input.prisma.commentReply.update({
        where: { id: reply.id },
        data: { status: 'SENT', externalReplyId: result.externalReplyId, sentAt: result.sentAt },
      }),
      input.prisma.comment.update({
        where: { id: comment.id },
        data: { status: 'RESOLVED' },
      }),
      input.prisma.comment.upsert({
        where: {
          socialAccountId_externalCommentId: {
            socialAccountId: account.id,
            externalCommentId: result.externalReplyId,
          },
        },
        create: {
          workspaceId: payload.workspaceId,
          platformPostId: comment.platformPostId,
          socialAccountId: account.id,
          platform: account.platform,
          externalCommentId: result.externalReplyId,
          parentId: comment.id,
          authorExternalId: account.externalPageId ?? account.externalAccountId,
          authorName: account.name,
          authorAvatarUrl: account.avatarUrl,
          message: payload.message,
          likeCount: 0,
          postedAt: result.sentAt,
          status: 'RESOLVED',
          isHidden: false,
          isFromPage: true,
        },
        update: {
          parentId: comment.id,
          message: payload.message,
          postedAt: result.sentAt,
          isFromPage: true,
          deletedAt: null,
        },
      }),
    ]);

    logger.info(
      {
        commentId: comment.id,
        externalReplyId: result.externalReplyId,
        platform: account.platform,
      },
      'Đã reply comment trên platform',
    );

    return {
      replied: true,
      commentId: comment.id,
      externalReplyId: result.externalReplyId,
      platform: PLATFORM_LABELS[account.platform],
    };
  } finally {
    await adapterCtx.release();
  }
}

async function markReplyFailed(
  prisma: PrismaClientInstance,
  payload: ReplyPlatformCommentPayload,
  error: unknown,
) {
  if (!payload.replyRecordId) return;
  await prisma.commentReply
    .update({
      where: { id: payload.replyRecordId },
      data: {
        status: 'FAILED',
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        errorMessage: error instanceof Error ? error.message : 'Lỗi không xác định khi gửi reply.',
      },
    })
    .catch(() => undefined);
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: ReplyPlatformCommentPayload,
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

export function createReplyPlatformCommentPrisma(
  databaseUrl: string,
  logQueries: boolean,
): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
