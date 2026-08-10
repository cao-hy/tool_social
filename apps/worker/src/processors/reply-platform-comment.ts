import { isPlatformError } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { PLATFORM_LABELS, RemoteRequestError, type QueuePayload } from '@socialhub/shared';
import { z } from 'zod';
import { logger } from '../logger';

import { getFreshAccessToken } from './token-refresh';
import {
  beginOutboundAttempt,
  markLocalCommittedInTransaction,
  markRemoteConfirmed,
  markRemoteUnknown,
  rollbackBeforeConnect,
  type OutboundAttemptOwnership,
} from './outbound-operation';

const replyPlatformCommentPayloadSchema = z.object({
  commentId: z.string().min(1),
  workspaceId: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
  replyRecordId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
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
      if (!(await hasDurableRemoteOutcome(input.prisma, payload.operationId))) {
        await markReplyFailed(input.prisma, payload, error);
      }
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
    let ownership: OutboundAttemptOwnership | null = null;
    let result: Awaited<ReturnType<typeof replyToComment>>;
    try {
      const currentAccount = await input.prisma.socialAccount.findUnique({
        where: { id: account.id },
        select: { status: true, disconnectGeneration: true },
      });
      if (
        !currentAccount ||
        currentAccount.status !== 'CONNECTED' ||
        currentAccount.disconnectGeneration !== account.disconnectGeneration
      ) {
        throw new Error('ACCOUNT_DISCONNECTED');
      }

      const start = await beginOutboundAttempt(input.prisma, payload.operationId);
      if (start.action === 'LOCAL_COMMIT') {
        return await commitReplyLocally(input.prisma, {
          payload,
          comment,
          reply,
          account,
          ownership: start.ownership,
        });
      }
      if (start.action !== 'DISPATCH_REMOTE') {
        return { replied: false, reason: start.reason };
      }
      ownership = start.ownership;
      const accountStillEligible = await input.prisma.socialAccount.findUnique({
        where: { id: account.id },
        select: { status: true, disconnectGeneration: true },
      });
      if (
        !accountStillEligible ||
        accountStillEligible.status !== 'CONNECTED' ||
        accountStillEligible.disconnectGeneration !== account.disconnectGeneration
      ) {
        await rollbackBeforeConnect(input.prisma, ownership, {
          code: 'ACCOUNT_DISCONNECTED',
          message: 'Social account disconnected before remote reply dispatch.',
        });
        return { replied: false, reason: 'account_disconnected' };
      }
      result = await replyToComment(
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
      await markRemoteConfirmed(input.prisma, ownership, {
        remoteId: result.externalReplyId,
        checkpoint: {
          externalReplyId: result.externalReplyId,
          sentAt: result.sentAt.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof RemoteRequestError && !error.requestMayHaveReachedRemote && ownership) {
        await rollbackBeforeConnect(input.prisma, ownership, {
          code: error.phase,
          message: error.message,
        });
      } else if (
        ownership &&
        ((error instanceof RemoteRequestError && error.requestMayHaveReachedRemote) ||
          (isPlatformError(error) && error.kind === 'NETWORK'))
      ) {
        await markRemoteUnknown(input.prisma, ownership, {
          code: 'REMOTE_RESULT_UNKNOWN',
          message: error instanceof Error ? error.message : 'Unknown remote outcome',
          providerRequestId:
            error instanceof RemoteRequestError ? error.providerRequestId : undefined,
        });
      }
      throw error;
    }

    const committed = await commitReplyLocally(input.prisma, {
      payload,
      comment,
      reply,
      account,
      ownership,
      result,
    });

    logger.info(
      {
        commentId: comment.id,
        externalReplyId: committed.externalReplyId,
        platform: account.platform,
      },
      'Đã reply comment trên platform',
    );

    return {
      replied: true,
      commentId: comment.id,
      externalReplyId: committed.externalReplyId,
      platform: PLATFORM_LABELS[account.platform],
    };
  } finally {
    await adapterCtx.release();
  }
}

async function commitReplyLocally(
  prisma: PrismaClientInstance,
  input: {
    payload: ReplyPlatformCommentPayload;
    comment: {
      id: string;
      platformPostId: string;
      workspaceId: string;
    };
    reply: { id: string };
    account: {
      id: string;
      platform: keyof typeof PLATFORM_LABELS;
      externalAccountId: string;
      externalPageId: string | null;
      name: string;
      avatarUrl: string | null;
    };
    ownership: OutboundAttemptOwnership | null;
    result?: { externalReplyId: string; sentAt: Date };
  },
): Promise<{ replied: true; commentId: string; externalReplyId: string; platform: string }> {
  const result = input.result ?? (await loadReplyCheckpoint(prisma, input.ownership));
  await prisma.$transaction(async (tx) => {
    await tx.commentReply.update({
      where: { id: input.reply.id },
      data: { status: 'SENT', externalReplyId: result.externalReplyId, sentAt: result.sentAt },
    });
    await tx.comment.update({
      where: { id: input.comment.id },
      data: { status: 'RESOLVED' },
    });
    await tx.comment.upsert({
      where: {
        socialAccountId_externalCommentId: {
          socialAccountId: input.account.id,
          externalCommentId: result.externalReplyId,
        },
      },
      create: {
        workspaceId: input.payload.workspaceId,
        platformPostId: input.comment.platformPostId,
        socialAccountId: input.account.id,
        platform: input.account.platform,
        externalCommentId: result.externalReplyId,
        parentId: input.comment.id,
        authorExternalId: input.account.externalPageId ?? input.account.externalAccountId,
        authorName: input.account.name,
        authorAvatarUrl: input.account.avatarUrl,
        message: input.payload.message,
        likeCount: 0,
        postedAt: result.sentAt,
        status: 'RESOLVED',
        isHidden: false,
        isFromPage: true,
      },
      update: {
        parentId: input.comment.id,
        message: input.payload.message,
        postedAt: result.sentAt,
        isFromPage: true,
        deletedAt: null,
      },
    });
    if (input.ownership) await markLocalCommittedInTransaction(tx, input.ownership);
  });

  return {
    replied: true,
    commentId: input.comment.id,
    externalReplyId: result.externalReplyId,
    platform: PLATFORM_LABELS[input.account.platform],
  };
}

async function loadReplyCheckpoint(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership | null,
): Promise<{ externalReplyId: string; sentAt: Date }> {
  if (!ownership) throw new Error('Cannot recover reply commit without operation ownership');
  const operation = await prisma.outboundOperation.findUnique({
    where: { id: ownership.operationId },
    select: { remoteCheckpoint: true },
  });
  const checkpoint = jsonObject(operation?.remoteCheckpoint);
  const externalReplyId =
    typeof checkpoint?.externalReplyId === 'string' ? checkpoint.externalReplyId : null;
  const sentAt = typeof checkpoint?.sentAt === 'string' ? new Date(checkpoint.sentAt) : null;
  if (!externalReplyId || !sentAt || Number.isNaN(sentAt.getTime())) {
    throw new Error('REMOTE_CONFIRMED reply operation is missing durable checkpoint');
  }
  return { externalReplyId, sentAt };
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

async function hasDurableRemoteOutcome(
  prisma: PrismaClientInstance,
  operationId: string | undefined,
): Promise<boolean> {
  if (!operationId) return false;
  const operation = await prisma.outboundOperation
    .findUnique({
      where: { id: operationId },
      select: { state: true },
    })
    .catch(() => null);
  return (
    operation?.state === 'REMOTE_CONFIRMED' ||
    operation?.state === 'REMOTE_UNKNOWN' ||
    operation?.state === 'LOCAL_COMMITTED' ||
    operation?.state === 'MANUAL_REVIEW'
  );
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
