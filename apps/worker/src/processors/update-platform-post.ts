import { isPlatformError, type AdapterLogger } from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext, WorkspaceRouteOptions } from '@socialhub/social-runtime';
import { type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import {
  PLATFORM_LABELS,
  RemoteRequestError,
  type MediaType,
  type Platform,
  type QueuePayload,
} from '@socialhub/shared';
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
  type OutboundAttemptOwnership,
} from './outbound-operation';
import { getFreshAccessToken } from './token-refresh';

const updatePlatformPostPayloadSchema = z.object({
  platformPostId: z.string().min(1),
  contentPostId: z.string().min(1),
  workspaceId: z.string().min(1),
  requestedByUserId: z.string().min(1),
  correlationId: z.string().min(1),
  operationId: z.string().min(1).optional(),
  desired: z.object({
    title: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    linkUrl: z.string().nullable().optional(),
    hashtags: z.array(z.string()).optional(),
    options: z.record(z.unknown()).nullable().optional(),
  }),
  updateContentPostFields: z
    .object({
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      linkUrl: z.string().nullable().optional(),
      hashtags: z.array(z.string()).optional(),
    })
    .optional(),
});

type UpdatePlatformPostPayload = QueuePayload<'update-platform-post'>;

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

export function createUpdatePlatformPostProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: {
    forWorkspace(
      workspaceId: string,
      route?: WorkspaceRouteOptions,
    ): Promise<WorkspaceAdapterContext>;
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
    const payload = updatePlatformPostPayloadSchema.parse(job.data) as UpdatePlatformPostPayload;
    const jobName = job.name ?? 'update-platform-post';
    const jobId = job.id ?? `update-platform-post-${payload.platformPostId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await input.locks.withLock(
        `publish-post:${payload.platformPostId}`,
        90_000,
        async () => updatePlatformPost(input, payload),
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
        error instanceof Error ? error.message : 'Lỗi không xác định khi cập nhật bài đăng.';

      await finishJob(input.prisma, jobName, jobId, startedAt, isDead ? 'DEAD' : 'FAILED', {
        errorCode,
        errorMessage,
        isDead,
      });

      if (isDead) {
        await markUpdateFailedState(input.prisma, payload, errorCode, errorMessage);
        throw new UnrecoverableError(errorMessage);
      }

      throw error;
    }
  };
}

async function updatePlatformPost(
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
  },
  payload: UpdatePlatformPostPayload,
) {
  const platformPost = await input.prisma.platformPost.findFirst({
    where: {
      id: payload.platformPostId,
      workspaceId: payload.workspaceId,
    },
    include: {
      socialAccount: { include: { token: true } },
      media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
      contentPost: {
        include: {
          media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
        },
      },
    },
  });

  if (!platformPost || platformPost.contentPost.deletedAt !== null) {
    return { updated: false, reason: 'post_not_found' };
  }

  const currentState = jsonObject(platformPost.platformState);
  const pendingDelete = jsonObject(
    (currentState.pendingDelete as Prisma.JsonValue | undefined) ?? null,
  );
  if (
    platformPost.status === 'DELETED' ||
    pendingDelete.state === 'QUEUED' ||
    pendingDelete.state === 'PROCESSING'
  ) {
    return { updated: false, reason: 'post_deleting_or_deleted' };
  }

  if (platformPost.status !== 'PUBLISHED' || !platformPost.externalPostId) {
    return { updated: false, reason: 'not_published' };
  }

  const start = await beginOutboundAttempt(input.prisma, payload.operationId, {
    expected: {
      workspaceId: payload.workspaceId,
      operationType: 'UPDATE_POST',
      resourceType: 'PlatformPost',
      resourceId: platformPost.id,
    },
  });

  if (start.action === 'LOCAL_COMMIT') {
    await commitUpdateLocally(input.prisma, platformPost, payload, start.ownership);
    return {
      updated: true,
      platformPostId: platformPost.id,
      contentPostId: platformPost.contentPostId,
    };
  }

  if (start.action !== 'DISPATCH_REMOTE') {
    return { updated: false, reason: start.reason };
  }

  const ownership = start.ownership;
  const account = platformPost.socialAccount;

  if (!account.token || account.status !== 'CONNECTED') {
    await markPreTargetFailed(input.prisma, ownership, {
      code: 'ACCOUNT_DISCONNECTED',
      message: 'Social account chưa kết nối hoặc thiếu token.',
    });
    await markUpdateFailedState(
      input.prisma,
      payload,
      'ACCOUNT_DISCONNECTED',
      'Social account chưa kết nối hoặc thiếu token.',
    );
    throw new UnrecoverableError('Social account chưa kết nối hoặc thiếu token.');
  }

  await input.prisma.platformPost.update({
    where: { id: platformPost.id },
    data: {
      platformState: {
        ...currentState,
        pendingUpdate: {
          state: 'PROCESSING',
          desired: payload.desired,
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
      'editPublishedPost',
    );
    if (!adapter.editPost) {
      await markPreTargetFailed(input.prisma, ownership, {
        code: 'CAPABILITY_UNSUPPORTED',
        message: `${platformPost.platform} không hỗ trợ sửa bài đã đăng.`,
      });
      throw new UnrecoverableError(`${platformPost.platform} không hỗ trợ sửa bài đã đăng.`);
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

    const mediaTypes =
      platformPost.media.length > 0
        ? platformPost.media.map((item) => item.mediaAsset.type as MediaType)
        : platformPost.contentPost.media.map((item) => item.mediaAsset.type as MediaType);

    try {
      await adapter.editPost(
        {
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: payload.correlationId,
          logger: adapterLogger,
        },
        platformPost.externalPostId,
        {
          caption: payload.desired.caption ?? undefined,
          title: payload.desired.title ?? undefined,
          description: payload.desired.description ?? undefined,
          linkUrl: payload.desired.linkUrl ?? undefined,
          hashtags: payload.desired.hashtags,
          mediaTypes,
          options: payload.desired.options ?? undefined,
        },
      );
    } catch (error) {
      if (error instanceof RemoteRequestError && !error.requestMayHaveReachedRemote) {
        await rollbackBeforeConnect(input.prisma, ownership, {
          code: error.phase,
          message: error.message,
        });
        throw error;
      }
      await rollbackBeforeConnect(input.prisma, ownership, {
        code: isPlatformError(error) ? error.kind : 'EDIT_POST_FAILED',
        message: error instanceof Error ? error.message : 'Không thể sửa bài trên nền tảng.',
      });
      throw error;
    }

    await markRemoteConfirmed(input.prisma, ownership, {
      remoteId: platformPost.externalPostId,
    });

    await commitUpdateLocally(input.prisma, platformPost, payload, ownership);

    return {
      updated: true,
      platformPostId: platformPost.id,
      contentPostId: platformPost.contentPostId,
      platform: platformPost.platform,
    };
  } finally {
    await adapterCtx.release();
  }
}

async function commitUpdateLocally(
  prisma: PrismaClientInstance,
  platformPost: {
    id: string;
    contentPostId: string;
    platformState: Prisma.JsonValue | null;
  },
  payload: UpdatePlatformPostPayload,
  ownership: OutboundAttemptOwnership,
) {
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.platformPost.findUnique({
      where: { id: platformPost.id },
      select: { platformState: true },
    });
    const nextState = { ...jsonObject(fresh?.platformState ?? platformPost.platformState) };
    delete nextState.pendingUpdate;
    nextState.lastEditedOnPlatformAt = new Date().toISOString();

    await tx.platformPost.update({
      where: { id: platformPost.id },
      data: {
        ...(payload.desired.caption !== undefined ? { caption: payload.desired.caption } : {}),
        ...(payload.desired.title !== undefined ? { title: payload.desired.title } : {}),
        ...(payload.desired.description !== undefined
          ? { description: payload.desired.description }
          : {}),
        ...(payload.desired.linkUrl !== undefined ? { linkUrl: payload.desired.linkUrl } : {}),
        ...(payload.desired.options !== undefined
          ? { options: payload.desired.options as Prisma.InputJsonValue }
          : {}),
        errorCode: null,
        errorMessage: null,
        platformState: nextState as Prisma.InputJsonValue,
      },
    });

    if (payload.updateContentPostFields) {
      await tx.contentPost.updateMany({
        where: { id: platformPost.contentPostId, workspaceId: payload.workspaceId },
        data: {
          ...(payload.updateContentPostFields.title !== undefined
            ? { title: payload.updateContentPostFields.title }
            : {}),
          ...(payload.updateContentPostFields.body !== undefined
            ? { body: payload.updateContentPostFields.body }
            : {}),
          ...(payload.updateContentPostFields.linkUrl !== undefined
            ? { linkUrl: payload.updateContentPostFields.linkUrl }
            : {}),
          ...(payload.updateContentPostFields.hashtags !== undefined
            ? { hashtags: payload.updateContentPostFields.hashtags }
            : {}),
        },
      });
    }

    await markLocalCommittedInTransaction(tx, ownership);
  });
}

async function markUpdateFailedState(
  prisma: PrismaClientInstance,
  payload: UpdatePlatformPostPayload,
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
          pendingUpdate: {
            state: 'FAILED',
            desired: payload.desired,
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
        title: 'Cập nhật bài đã đăng thất bại',
        body: `${PLATFORM_LABELS[existing.platform as Platform]} · ${existing.socialAccount.name}: ${errorMessage}`,
        linkUrl: `/posts/${existing.contentPostId}`,
        data: {
          platformPostId: existing.id,
          contentPostId: existing.contentPostId,
          platform: existing.platform,
          accountName: existing.socialAccount.name,
          code: errorCode,
          action: 'UPDATE_POST',
        },
      },
    });
  });
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: UpdatePlatformPostPayload,
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
