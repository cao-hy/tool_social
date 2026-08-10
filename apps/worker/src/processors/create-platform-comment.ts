import { isPlatformError } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import {
  PLATFORM_LABELS,
  RemoteRequestError,
  type Platform,
  type QueuePayload,
} from '@socialhub/shared';
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

type CreateCommentRemoteResult = {
  externalCommentId: string;
  postedAt: Date;
};

const createPlatformCommentPayloadSchema = z.object({
  commandId: z.string().min(1),
  platformPostId: z.string().min(1),
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
  operationId: z.string().min(1).optional(),
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

  const command = await input.prisma.commentCreateCommand.findFirst({
    where: { id: payload.commandId, workspaceId: payload.workspaceId },
  });
  if (!command) return { created: false, reason: 'comment_command_not_found' };

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

    let ownership: OutboundAttemptOwnership | null = null;
    let result: Awaited<ReturnType<typeof createComment>>;
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
        return await commitCreateCommentLocally(input.prisma, {
          payload,
          account,
          platformPostId: platformPost.id,
          ownership: start.ownership,
        });
      }
      if (start.action !== 'DISPATCH_REMOTE') {
        return { created: false, reason: start.reason };
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
          message: 'Social account disconnected before remote comment dispatch.',
        });
        return { created: false, reason: 'account_disconnected' };
      }
      result = await createComment(
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
      await markRemoteConfirmed(input.prisma, ownership, {
        remoteId: result.externalCommentId,
        checkpoint: {
          externalCommentId: result.externalCommentId,
          postedAt: result.postedAt.toISOString(),
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

    const comment = await commitCreateCommentLocally(input.prisma, {
      payload,
      account,
      platformPostId: platformPost.id,
      ownership,
      result,
    });

    logger.info(
      {
        platformPostId: platformPost.id,
        commentId: comment.commentId,
        externalCommentId: comment.externalCommentId,
        platform: account.platform,
      },
      'Đã tạo top-level comment trên platform',
    );

    return {
      created: true,
      commentId: comment.commentId,
      externalCommentId: comment.externalCommentId,
      platform: PLATFORM_LABELS[account.platform],
    };
  } finally {
    await adapterCtx.release();
  }
}

async function commitCreateCommentLocally(
  prisma: PrismaClientInstance,
  input: {
    payload: CreatePlatformCommentPayload;
    account: {
      id: string;
      platform: Platform;
      externalAccountId: string;
      externalPageId: string | null;
      name: string;
      avatarUrl: string | null;
    };
    platformPostId: string;
    ownership: OutboundAttemptOwnership | null;
    result?: CreateCommentRemoteResult;
  },
): Promise<{ created: true; commentId: string; externalCommentId: string; platform: string }> {
  const result = input.result ?? (await loadCreateCommentCheckpoint(prisma, input.ownership));
  const comment = await prisma.$transaction(async (tx) => {
    const comment = await tx.comment.upsert({
      where: {
        socialAccountId_externalCommentId: {
          socialAccountId: input.account.id,
          externalCommentId: result.externalCommentId,
        },
      },
      create: {
        workspaceId: input.payload.workspaceId,
        platformPostId: input.platformPostId,
        socialAccountId: input.account.id,
        platform: input.account.platform,
        externalCommentId: result.externalCommentId,
        parentId: null,
        authorExternalId: input.account.externalPageId ?? input.account.externalAccountId,
        authorName: input.account.name,
        authorAvatarUrl: input.account.avatarUrl,
        message: input.payload.message,
        likeCount: 0,
        postedAt: result.postedAt,
        status: 'RESOLVED',
        isHidden: false,
        isFromPage: true,
      },
      update: {
        message: input.payload.message,
        postedAt: result.postedAt,
        isFromPage: true,
        deletedAt: null,
      },
    });
    await tx.commentCreateCommand.update({
      where: { id: input.payload.commandId },
      data: {
        status: 'SENT',
        externalCommentId: result.externalCommentId,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (input.ownership) await markLocalCommittedInTransaction(tx, input.ownership);
    return comment;
  });

  return {
    created: true,
    commentId: comment.id,
    externalCommentId: result.externalCommentId,
    platform: PLATFORM_LABELS[input.account.platform],
  };
}

async function loadCreateCommentCheckpoint(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership | null,
): Promise<CreateCommentRemoteResult> {
  if (!ownership) throw new Error('Cannot recover comment commit without operation ownership');
  const operation = await prisma.outboundOperation.findUnique({
    where: { id: ownership.operationId },
    select: { remoteCheckpoint: true },
  });
  const checkpoint = jsonObject(operation?.remoteCheckpoint);
  const externalCommentId =
    typeof checkpoint?.externalCommentId === 'string' ? checkpoint.externalCommentId : null;
  const postedAt = typeof checkpoint?.postedAt === 'string' ? new Date(checkpoint.postedAt) : null;
  if (!externalCommentId || !postedAt || Number.isNaN(postedAt.getTime())) {
    throw new Error('REMOTE_CONFIRMED create-comment operation is missing durable checkpoint');
  }
  return { externalCommentId, postedAt };
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
