import { isPlatformError } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { RemoteRequestError, type Platform, type QueuePayload } from '@socialhub/shared';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { logger } from '../logger';
import { decideOnError } from '../queue/error-policy';
import { JobLockService } from '../queue/job-lock';
import {
  beginOutboundAttempt,
  markLocalCommittedInTransaction,
  markPreTargetFailed,
  markRemoteConfirmed,
  recordRouteMetadata,
  rollbackBeforeConnect,
} from './outbound-operation';
import { getFreshAccessToken } from './token-refresh';

const moderatePlatformCommentPayloadSchema = z.object({
  commentId: z.string().min(1),
  platformPostId: z.string().min(1),
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
  operationId: z.string().min(1).optional(),
  action: z.enum(['EDIT_MESSAGE', 'SET_VISIBILITY', 'DELETE_COMMENT']),
  message: z.string().optional(),
  previousMessage: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  previousHidden: z.boolean().optional(),
});

type ModeratePlatformCommentPayload = QueuePayload<'moderate-platform-comment'>;

function isCommentAlreadyAbsentError(error: unknown): boolean {
  if (isPlatformError(error) && error.kind === 'NOT_FOUND') return true;
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes('does not exist') ||
    lower.includes('not found') ||
    lower.includes('unsupported delete request') ||
    lower.includes('cannot be loaded')
  );
}

export function createModeratePlatformCommentProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: {
    forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext>;
  };
  locks: JobLockService;
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = moderatePlatformCommentPayloadSchema.parse(
      job.data,
    ) as ModeratePlatformCommentPayload;
    const jobName = job.name ?? 'moderate-platform-comment';
    const jobId = job.id ?? `moderate-platform-comment-${payload.commentId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await input.locks.withLock(
        `moderate-comment:${payload.commentId}`,
        60_000,
        async () => moderatePlatformComment(input, payload),
      );

      if (result === null) {
        throw new Error('Comment đang được xử lý bởi tác vụ khác, sẽ tự động thử lại.');
      }

      await finishJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');
      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      const decision = decideOnError(error, attempt, maxAttempts);
      const isDead = decision.action === 'FAIL_PERMANENTLY';
      const errorCode = isPlatformError(error)
        ? error.kind
        : error instanceof Error
          ? error.name
          : 'UNKNOWN';
      const errorMessage =
        error instanceof Error ? error.message : 'Lỗi không xác định khi thao tác bình luận.';

      await finishJob(input.prisma, jobName, jobId, startedAt, isDead ? 'DEAD' : 'FAILED', {
        errorCode,
        errorMessage,
        isDead,
      });

      if (isDead) {
        await rollbackOptimisticCommentState(input.prisma, payload, errorCode, errorMessage);
        throw new UnrecoverableError(errorMessage);
      }

      throw error;
    }
  };
}

async function moderatePlatformComment(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: {
      forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext>;
    };
    locks: JobLockService;
  },
  payload: ModeratePlatformCommentPayload,
) {
  // Lưu ý: KHÔNG lọc `deletedAt: null` vì DELETE_COMMENT đã soft-delete optimistic ở API
  const comment = await input.prisma.comment.findFirst({
    where: {
      id: payload.commentId,
      workspaceId: payload.workspaceId,
    },
    include: {
      socialAccount: { include: { token: true } },
      platformPost: { select: { id: true, contentPostId: true } },
    },
  });

  if (!comment) {
    return {
      moderated: payload.action === 'DELETE_COMMENT',
      action: payload.action,
      commentId: payload.commentId,
      platformPostId: payload.platformPostId,
      reason: 'comment_not_found',
    };
  }

  const start = await beginOutboundAttempt(input.prisma, payload.operationId, {
    expected: {
      workspaceId: payload.workspaceId,
      operationType: 'MODERATE_COMMENT',
      resourceType: 'Comment',
      resourceId: comment.id,
    },
  });

  if (start.action === 'LOCAL_COMMIT') {
    await commitCommentModerationLocally(input.prisma, payload, comment.id, start.ownership);
    return {
      moderated: true,
      action: payload.action,
      commentId: comment.id,
      platformPostId: comment.platformPostId,
      contentPostId: comment.platformPost.contentPostId,
    };
  }

  if (start.action !== 'DISPATCH_REMOTE') {
    return {
      moderated: false,
      action: payload.action,
      commentId: comment.id,
      platformPostId: comment.platformPostId,
      reason: start.reason,
    };
  }

  const ownership = start.ownership;
  const account = comment.socialAccount;

  if (!account.token || account.status !== 'CONNECTED') {
    await markPreTargetFailed(input.prisma, ownership, {
      code: 'ACCOUNT_DISCONNECTED',
      message: 'Social account chưa kết nối hoặc thiếu token.',
    });
    throw new UnrecoverableError('Social account chưa kết nối hoặc thiếu token.');
  }

  const adapterCtx = await input.adapterFactory
    .forWorkspace(payload.workspaceId)
    .catch(async (error) => {
      await rollbackBeforeConnect(input.prisma, ownership, {
        code: error instanceof Error ? error.name : 'ADAPTER_PREPARE_FAILED',
        message: error instanceof Error ? error.message : 'Adapter preparation failed.',
      });
      throw error;
    });

  try {
    await recordRouteMetadata(input.prisma, ownership, {
      routeConfigVersion: adapterCtx.proxy?.configVersion ?? null,
      routeProxyFingerprint: adapterCtx.proxy?.routeFingerprint ?? null,
      routeCountryCode: adapterCtx.proxy?.attestation?.countryCode ?? null,
    });

    const usesModerationDelete =
      payload.action === 'DELETE_COMMENT' && comment.platform === 'YOUTUBE' && !comment.isFromPage;
    const capability =
      payload.action === 'EDIT_MESSAGE'
        ? 'editComment'
        : payload.action === 'SET_VISIBILITY' || usesModerationDelete
          ? 'hideComment'
          : 'deleteComment';

    const adapter = adapterCtx.adapters.requireCapability(comment.platform as Platform, capability);
    const accessToken = await getFreshAccessToken({
      prisma: input.prisma,
      keyring: input.keyring,
      locks: input.locks,
      adapter,
      account: {
        id: account.id,
        workspaceId: account.workspaceId,
        platform: account.platform,
        token: account.token,
      },
    }).catch(async (error) => {
      await rollbackBeforeConnect(input.prisma, ownership, {
        code: error instanceof Error ? error.name : 'TOKEN_PREPARE_FAILED',
        message: error instanceof Error ? error.message : 'Token preparation failed.',
      });
      throw error;
    });

    const ctx = {
      accessToken,
      externalAccountId: account.externalAccountId,
      externalPageId: account.externalPageId ?? undefined,
      correlationId: payload.correlationId,
    };

    try {
      if (payload.action === 'EDIT_MESSAGE') {
        if (!adapter.editComment) {
          throw new UnrecoverableError(`${comment.platform} không hỗ trợ sửa bình luận.`);
        }
        await adapter.editComment(ctx, comment.externalCommentId, payload.message ?? '');
      } else if (payload.action === 'SET_VISIBILITY') {
        if (!adapter.hideComment) {
          throw new UnrecoverableError(`${comment.platform} không hỗ trợ ẩn/hiện bình luận.`);
        }
        await adapter.hideComment(ctx, comment.externalCommentId, Boolean(payload.hidden));
      } else {
        if (usesModerationDelete) {
          if (!adapter.hideComment) {
            throw new UnrecoverableError(`${comment.platform} không hỗ trợ gỡ bình luận.`);
          }
          await adapter.hideComment(ctx, comment.externalCommentId, true);
        } else {
          if (!adapter.deleteComment) {
            throw new UnrecoverableError(`${comment.platform} không hỗ trợ xóa bình luận.`);
          }
          await adapter.deleteComment(ctx, comment.externalCommentId);
        }
      }
    } catch (error) {
      if (payload.action === 'DELETE_COMMENT' && isCommentAlreadyAbsentError(error)) {
        logger.info(
          { commentId: comment.id, externalCommentId: comment.externalCommentId },
          'Comment không còn tồn tại trên nền tảng (404), ghi nhận xóa thành công (idempotent)',
        );
      } else {
        if (error instanceof RemoteRequestError && !error.requestMayHaveReachedRemote) {
          await rollbackBeforeConnect(input.prisma, ownership, {
            code: error.phase,
            message: error.message,
          });
          throw error;
        }
        await rollbackBeforeConnect(input.prisma, ownership, {
          code: isPlatformError(error) ? error.kind : 'COMMENT_MODERATION_FAILED',
          message: error instanceof Error ? error.message : 'Thao tác bình luận thất bại.',
        });
        throw error;
      }
    }

    await markRemoteConfirmed(input.prisma, ownership, {
      remoteId: comment.externalCommentId,
    });

    await commitCommentModerationLocally(input.prisma, payload, comment.id, ownership);

    return {
      moderated: true,
      action: payload.action,
      commentId: comment.id,
      platformPostId: comment.platformPostId,
      contentPostId: comment.platformPost.contentPostId,
      platform: comment.platform,
    };
  } finally {
    await adapterCtx.release();
  }
}

async function commitCommentModerationLocally(
  prisma: PrismaClientInstance,
  payload: ModeratePlatformCommentPayload,
  commentId: string,
  ownership: { operationId: string; attemptId: string; fence: number },
) {
  await prisma.$transaction(async (tx) => {
    if (payload.action === 'DELETE_COMMENT') {
      await tx.comment.deleteMany({
        where: {
          workspaceId: payload.workspaceId,
          OR: [{ id: commentId }, { parentId: commentId }],
        },
      });
    } else if (payload.action === 'EDIT_MESSAGE' && payload.message !== undefined) {
      await tx.comment.updateMany({
        where: { id: commentId, workspaceId: payload.workspaceId, deletedAt: null },
        data: { message: payload.message },
      });
    } else if (payload.action === 'SET_VISIBILITY' && payload.hidden !== undefined) {
      await tx.comment.updateMany({
        where: { id: commentId, workspaceId: payload.workspaceId, deletedAt: null },
        data: { isHidden: payload.hidden },
      });
    }

    await markLocalCommittedInTransaction(tx, ownership);
  });
}

async function rollbackOptimisticCommentState(
  prisma: PrismaClientInstance,
  payload: ModeratePlatformCommentPayload,
  errorCode: string,
  errorMessage: string,
) {
  await prisma.$transaction(async (tx) => {
    if (payload.operationId) {
      await tx.outboundOperation.updateMany({
        where: { id: payload.operationId, state: { in: ['PREPARED', 'DISPATCHING'] } },
        data: {
          state: 'FAILED',
          lastErrorCode: errorCode,
          lastErrorMessage: errorMessage,
        },
      });
    }

    if (payload.action === 'DELETE_COMMENT') {
      await tx.comment.updateMany({
        where: {
          workspaceId: payload.workspaceId,
          OR: [{ id: payload.commentId }, { parentId: payload.commentId }],
        },
        data: { deletedAt: null },
      });
    } else if (payload.action === 'EDIT_MESSAGE' && payload.previousMessage !== undefined) {
      await tx.comment.updateMany({
        where: { id: payload.commentId, workspaceId: payload.workspaceId, deletedAt: null },
        data: { message: payload.previousMessage },
      });
    } else if (payload.action === 'SET_VISIBILITY' && payload.previousHidden !== undefined) {
      await tx.comment.updateMany({
        where: { id: payload.commentId, workspaceId: payload.workspaceId, deletedAt: null },
        data: { isHidden: payload.previousHidden },
      });
    }
  });
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: ModeratePlatformCommentPayload,
  job: { attemptsMade?: number; opts?: { attempts?: number } },
  status: 'RUNNING',
) {
  const now = new Date();
  await prisma.backgroundJob.upsert({
    where: { queueName_jobId: { queueName, jobId } },
    create: {
      workspaceId: payload.workspaceId,
      queueName,
      jobId,
      status,
      payload: payload as unknown as Prisma.InputJsonValue,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 3,
      startedAt: now,
      correlationId: payload.correlationId,
    },
    update: {
      status,
      attempts: (job.attemptsMade ?? 0) + 1,
      startedAt: now,
    },
  });
}

async function finishJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  startedAt: Date,
  status: 'COMPLETED' | 'FAILED' | 'DEAD',
  failure?: { errorCode: string; errorMessage: string; isDead: boolean },
) {
  const finishedAt = new Date();
  await prisma.backgroundJob.updateMany({
    where: { queueName, jobId },
    data: {
      status,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCode: failure?.errorCode ?? null,
      errorMessage: failure?.errorMessage?.slice(0, 1000) ?? null,
      isDead: failure?.isDead ?? false,
    },
  });
}
