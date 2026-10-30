import { isPlatformError, type AdapterLogger } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext, WorkspaceRouteOptions } from '@socialhub/social-runtime';
import { type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import {
  buildJobId,
  buildQueueJobOptions,
  deriveContentPostStatus,
  PLATFORM_LABELS,
  RemoteRequestError,
  type Platform,
  type PlatformPostStatus,
  type QueuePayload,
} from '@socialhub/shared';
import { UnrecoverableError, type Queue } from 'bullmq';
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
  type OutboundAttemptOwnership,
} from './outbound-operation';
import { getFreshAccessToken } from './token-refresh';

const deletePlatformPostPayloadSchema = z.object({
  platformPostId: z.string().min(1),
  contentPostId: z.string().min(1),
  workspaceId: z.string().min(1),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
  operationId: z.string().min(1).optional(),
  deleteContentPostWhenDone: z.boolean(),
});

type DeletePlatformPostPayload = QueuePayload<'delete-platform-post'>;

const adapterLogger: AdapterLogger = {
  debug: (message, context) => logger.debug(context ?? {}, message),
  info: (message, context) => logger.info(context ?? {}, message),
  warn: (message, context) => logger.warn(context ?? {}, message),
  error: (message, context) => logger.error(context ?? {}, message),
};

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mediaAssetIdsFromOptions(options: Prisma.JsonValue | null | undefined): string[] {
  const obj = jsonObject(options);
  const id = obj.thumbnailMediaAssetId;
  return typeof id === 'string' && id.length > 0 ? [id] : [];
}

function isRemoteAlreadyDeletedError(error: unknown): boolean {
  if (isPlatformError(error) && error.kind === 'NOT_FOUND') return true;
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes('does not exist') ||
    lower.includes('not found') ||
    lower.includes('already deleted') ||
    lower.includes('cannot be loaded') ||
    lower.includes('unsupported delete request')
  );
}

export function createDeletePlatformPostProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: {
    forWorkspace(
      workspaceId: string,
      route?: WorkspaceRouteOptions,
    ): Promise<WorkspaceAdapterContext>;
  };
  locks: JobLockService;
  cleanupMediaQueue: Queue;
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = deletePlatformPostPayloadSchema.parse(job.data) as DeletePlatformPostPayload;
    const jobName = job.name ?? 'delete-platform-post';
    const jobId = job.id ?? `delete-platform-post-${payload.platformPostId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await input.locks.withLock(
        `publish-post:${payload.platformPostId}`,
        90_000,
        async () => deletePlatformPost(input, payload),
      );

      if (result === null) {
        throw new Error('PlatformPost đang được xử lý bởi tác vụ khác, sẽ tự động thử lại.');
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
        error instanceof Error ? error.message : 'Lỗi không xác định khi xóa bài trên nền tảng.';

      await finishJob(input.prisma, jobName, jobId, startedAt, isDead ? 'DEAD' : 'FAILED', {
        errorCode,
        errorMessage,
        isDead,
      });

      if (isDead) {
        await markDeleteFailedState(input.prisma, payload, errorCode, errorMessage);
        throw new UnrecoverableError(errorMessage);
      }

      throw error;
    }
  };
}

async function deletePlatformPost(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapterFactory: {
      forWorkspace(
        workspaceId: string,
        route?: WorkspaceRouteOptions,
      ): Promise<WorkspaceAdapterContext>;
    };
    locks: JobLockService;
    cleanupMediaQueue: Queue;
  },
  payload: DeletePlatformPostPayload,
) {
  const platformPost = await input.prisma.platformPost.findFirst({
    where: {
      id: payload.platformPostId,
      workspaceId: payload.workspaceId,
    },
    include: {
      socialAccount: { include: { token: true } },
      contentPost: true,
    },
  });

  if (!platformPost) {
    return { deleted: true, contentDeleted: true, reason: 'already_deleted' };
  }

  if (platformPost.status === 'DELETED' || !platformPost.externalPostId) {
    const finalized = await finalizeDeletedTarget(
      input.prisma,
      input.cleanupMediaQueue,
      payload,
      null,
    );
    return { deleted: true, ...finalized };
  }

  const start = await beginOutboundAttempt(input.prisma, payload.operationId, {
    expected: {
      workspaceId: payload.workspaceId,
      operationType: 'DELETE_POST',
      resourceType: 'PlatformPost',
      resourceId: platformPost.id,
    },
  });

  if (start.action === 'LOCAL_COMMIT') {
    const finalized = await finalizeDeletedTarget(
      input.prisma,
      input.cleanupMediaQueue,
      payload,
      start.ownership,
    );
    return { deleted: true, ...finalized };
  }

  if (start.action !== 'DISPATCH_REMOTE') {
    return { deleted: false, reason: start.reason };
  }

  const ownership = start.ownership;
  const account = platformPost.socialAccount;

  if (!account.token || account.status !== 'CONNECTED') {
    await markPreTargetFailed(input.prisma, ownership, {
      code: 'ACCOUNT_DISCONNECTED',
      message: 'Social account chưa kết nối hoặc thiếu token.',
    });
    await markDeleteFailedState(
      input.prisma,
      payload,
      'ACCOUNT_DISCONNECTED',
      'Social account chưa kết nối hoặc thiếu token. Bạn có thể chọn "Chỉ xóa khỏi hệ thống" nếu không còn quyền truy cập kênh.',
    );
    throw new UnrecoverableError('Social account chưa kết nối hoặc thiếu token.');
  }

  const currentState = jsonObject(platformPost.platformState);
  await input.prisma.platformPost.update({
    where: { id: platformPost.id },
    data: {
      platformState: {
        ...currentState,
        pendingDelete: {
          state: 'PROCESSING',
          deleteContentPostWhenDone: payload.deleteContentPostWhenDone,
          startedAt: new Date().toISOString(),
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  const adapterCtx = await input.adapterFactory
    .forWorkspace(payload.workspaceId, {
      storeId: account.storeId ?? null,
      target: platformPost.platform as Platform,
    })
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

    const adapter = adapterCtx.adapters.requireCapability(
      platformPost.platform as Platform,
      'deletePublishedPost',
    );
    if (!adapter.deletePost) {
      await markPreTargetFailed(input.prisma, ownership, {
        code: 'CAPABILITY_UNSUPPORTED',
        message: `${platformPost.platform} không hỗ trợ xóa bài từ API. Hãy xóa thủ công trên ứng dụng hoặc chọn "Chỉ xóa khỏi hệ thống".`,
      });
      throw new UnrecoverableError(
        `${platformPost.platform} không hỗ trợ xóa bài từ API. Hãy chọn "Chỉ xóa khỏi hệ thống".`,
      );
    }

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

    try {
      await adapter.deletePost(
        {
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: payload.correlationId,
          logger: adapterLogger,
        },
        platformPost.externalPostId,
      );
    } catch (error) {
      if (!isRemoteAlreadyDeletedError(error)) {
        if (error instanceof RemoteRequestError && !error.requestMayHaveReachedRemote) {
          await rollbackBeforeConnect(input.prisma, ownership, {
            code: error.phase,
            message: error.message,
          });
          throw error;
        }
        await rollbackBeforeConnect(input.prisma, ownership, {
          code: isPlatformError(error) ? error.kind : 'DELETE_POST_FAILED',
          message: error instanceof Error ? error.message : 'Không xóa được bài trên nền tảng.',
        });
        throw error;
      }
      logger.info(
        { platformPostId: platformPost.id, externalPostId: platformPost.externalPostId },
        'Bài viết đã không còn tồn tại trên nền tảng (404), ghi nhận xóa thành công (idempotent)',
      );
    }

    await markRemoteConfirmed(input.prisma, ownership, {
      remoteId: platformPost.externalPostId,
    });

    const finalized = await finalizeDeletedTarget(
      input.prisma,
      input.cleanupMediaQueue,
      payload,
      ownership,
    );

    return {
      deleted: true,
      platformPostId: platformPost.id,
      contentPostId: platformPost.contentPostId,
      ...finalized,
    };
  } finally {
    await adapterCtx.release();
  }
}

async function finalizeDeletedTarget(
  prisma: PrismaClientInstance,
  cleanupMediaQueue: Queue,
  payload: DeletePlatformPostPayload,
  ownership: OutboundAttemptOwnership | null,
): Promise<{ contentDeleted: boolean; mediaMarkedForCleanup: number }> {
  const postBefore = await prisma.contentPost.findFirst({
    where: { id: payload.contentPostId, workspaceId: payload.workspaceId },
    include: {
      media: { select: { mediaAssetId: true } },
      platformPosts: {
        include: { media: { select: { mediaAssetId: true } } },
      },
    },
  });

  if (!postBefore) {
    if (ownership) {
      await prisma.outboundOperation.updateMany({
        where: { id: ownership.operationId },
        data: { state: 'LOCAL_COMMITTED', completedAt: new Date() },
      });
    }
    return { contentDeleted: true, mediaMarkedForCleanup: 0 };
  }

  const candidateMediaIds = [
    ...new Set([
      ...postBefore.media.map((m) => m.mediaAssetId),
      ...postBefore.platformPosts.flatMap((pp) => pp.media.map((m) => m.mediaAssetId)),
      ...postBefore.platformPosts.flatMap((pp) => mediaAssetIdsFromOptions(pp.options)),
    ]),
  ];

  let contentDeleted = false;

  await prisma.$transaction(async (tx) => {
    const target = await tx.platformPost.findUnique({
      where: { id: payload.platformPostId },
      select: { id: true, platformState: true },
    });

    if (target) {
      const nextState = { ...jsonObject(target.platformState) };
      delete nextState.pendingDelete;

      await tx.platformPostMedia.deleteMany({
        where: { platformPostId: target.id },
      });
      await tx.comment.deleteMany({
        where: { platformPostId: target.id, workspaceId: payload.workspaceId },
      });
      await tx.postMetric.deleteMany({
        where: { platformPostId: target.id, workspaceId: payload.workspaceId },
      });
      await tx.metricSnapshot.deleteMany({
        where: { platformPostId: target.id, workspaceId: payload.workspaceId },
      });
      await tx.platformPost.update({
        where: { id: target.id },
        data: {
          status: 'DELETED',
          externalPostId: null,
          errorCode: null,
          errorMessage: null,
          platformState: nextState as Prisma.InputJsonValue,
        },
      });
    }

    if (ownership) {
      await markLocalCommittedInTransaction(tx, ownership);
    }

    const siblings = await tx.platformPost.findMany({
      where: { contentPostId: payload.contentPostId, workspaceId: payload.workspaceId },
      select: { id: true, status: true },
    });

    const allDeleted = siblings.every((sibling) => sibling.status === 'DELETED');
    if (payload.deleteContentPostWhenDone && allDeleted) {
      await tx.contentPost.deleteMany({
        where: { id: payload.contentPostId, workspaceId: payload.workspaceId },
      });
      contentDeleted = true;
    } else if (siblings.length > 0) {
      const nextStatus = deriveContentPostStatus(
        siblings.map((sibling) => sibling.status as PlatformPostStatus),
      );
      await tx.contentPost.updateMany({
        where: { id: payload.contentPostId, workspaceId: payload.workspaceId },
        data: { status: nextStatus },
      });
    }
  });

  const mediaMarkedForCleanup = await markUnusedMediaDeletePending(
    prisma,
    cleanupMediaQueue,
    payload.workspaceId,
    candidateMediaIds,
  );

  return { contentDeleted, mediaMarkedForCleanup };
}

async function markUnusedMediaDeletePending(
  prisma: PrismaClientInstance,
  cleanupMediaQueue: Queue,
  workspaceId: string,
  mediaAssetIds: string[],
): Promise<number> {
  if (mediaAssetIds.length === 0) return 0;

  const [contentRefs, platformRefs, mediaAssets] = await Promise.all([
    prisma.contentPostMedia.findMany({
      where: {
        mediaAssetId: { in: mediaAssetIds },
        contentPost: { workspaceId, deletedAt: null },
      },
      select: { mediaAssetId: true },
    }),
    prisma.platformPostMedia.findMany({
      where: {
        mediaAssetId: { in: mediaAssetIds },
        platformPost: {
          workspaceId,
          status: { not: 'DELETED' },
          contentPost: { deletedAt: null },
        },
      },
      select: { mediaAssetId: true },
    }),
    prisma.mediaAsset.findMany({
      where: { id: { in: mediaAssetIds }, workspaceId, deletedAt: null },
      select: { id: true },
    }),
  ]);

  const activeIds = new Set([
    ...contentRefs.map((r) => r.mediaAssetId),
    ...platformRefs.map((r) => r.mediaAssetId),
  ]);
  const deletableIds = mediaAssets.map((m) => m.id).filter((id) => !activeIds.has(id));
  if (deletableIds.length === 0) return 0;

  await prisma.mediaAsset.updateMany({
    where: { id: { in: deletableIds }, workspaceId },
    data: { status: 'DELETE_PENDING', deletedAt: new Date() },
  });

  const cleanupPayload: QueuePayload<'cleanup-unused-media'> = {
    olderThanDays: 1,
    triggerKey: `post-delete-${Date.now()}`,
  };
  const cleanupJobId = buildJobId('cleanup-unused-media', cleanupPayload);
  await cleanupMediaQueue
    .add(
      'cleanup-unused-media',
      cleanupPayload,
      buildQueueJobOptions('cleanup-unused-media', cleanupJobId),
    )
    .catch((err) => logger.warn({ err }, 'Không thể enqueue cleanup-unused-media ngay lập tức'));

  return deletableIds.length;
}

async function markDeleteFailedState(
  prisma: PrismaClientInstance,
  payload: DeletePlatformPostPayload,
  errorCode: string,
  errorMessage: string,
) {
  const existing = await prisma.platformPost.findFirst({
    where: { id: payload.platformPostId, workspaceId: payload.workspaceId },
    include: {
      socialAccount: { select: { name: true } },
      contentPost: { select: { createdById: true, title: true } },
    },
  });
  if (!existing) return;

  const state = jsonObject(existing.platformState);
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

    await tx.platformPost.update({
      where: { id: existing.id },
      data: {
        platformState: {
          ...state,
          pendingDelete: {
            state: 'FAILED',
            deleteContentPostWhenDone: payload.deleteContentPostWhenDone,
            errorCode,
            errorMessage,
            failedAt: new Date().toISOString(),
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.notification.create({
      data: {
        workspaceId: payload.workspaceId,
        userId: payload.requestedByUserId || existing.contentPost.createdById,
        type: 'POST_FAILED',
        title: 'Xóa bài trên mạng xã hội thất bại',
        body: `${PLATFORM_LABELS[existing.platform as Platform]} · ${existing.socialAccount.name}: ${errorMessage}`,
        linkUrl: `/posts/${existing.contentPostId}`,
        data: {
          platformPostId: existing.id,
          contentPostId: existing.contentPostId,
          platform: existing.platform,
          accountName: existing.socialAccount.name,
          code: errorCode,
          action: 'DELETE_POST',
        },
      },
    });
  });
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: DeletePlatformPostPayload,
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
