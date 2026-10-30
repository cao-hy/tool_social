import {
  DevelopmentFixtureAdapter,
  createPlatformError,
  isPlatformError,
  type AdapterContext,
  type AdapterLogger,
  type MediaInput,
  type RemotePublishCheckpoint,
  type SocialPlatformAdapter,
  type TikTokPublishPlatformState,
  type YouTubeVideoPlatformState,
} from '@socialhub/platform-adapters';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  createQueueOutboxEvent,
  operationRequestKey,
  createPrismaClient,
  type Prisma,
  type PrismaClientInstance,
} from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import type { WorkspaceAdapterContext, WorkspaceRouteOptions } from '@socialhub/social-runtime';
import { randomUUID } from 'node:crypto';
import {
  deriveContentPostStatus,
  buildJobId,
  buildQueueJobOptions,
  PLATFORM_LABELS,
  RemoteRequestError,
  buildPublishNetworkProof,
  type MediaType,
  type Platform,
  type PlatformPostStatus,
  type PublishNetworkProof,
} from '@socialhub/shared';
import sharp from 'sharp';
import type { Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { logger } from '../logger';
import { decideOnError } from '../queue/error-policy';
import { JobLockService } from '../queue/job-lock';

import { getFreshAccessToken } from './token-refresh';
import {
  beginOutboundAttempt,
  markLocalCommittedInTransaction,
  markPreTargetFailed,
  markRemoteConfirmed,
  markRemoteUnknown,
  recordRouteMetadata,
  rollbackBeforeConnect,
  type OutboundAttemptOwnership,
} from './outbound-operation';

const publishPostPayloadSchema = z
  .object({
    platformPostId: z.string().min(1),
    workspaceId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    requestedByUserId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
  })
  .transform((payload) => ({
    ...payload,
    correlationId:
      payload.correlationId ??
      `retry:${payload.requestedByUserId ?? 'unknown'}:${payload.platformPostId}`,
  }));

const adapterLogger: AdapterLogger = {
  debug: (message, context) => logger.debug(context ?? {}, message),
  info: (message, context) => logger.info(context ?? {}, message),
  warn: (message, context) => logger.warn(context ?? {}, message),
  error: (message, context) => logger.error(context ?? {}, message),
};

type PublishStageTimings = {
  queueWaitMs: number;
  loadStateMs: number;
  tokenRefreshMs: number;
  prepareRouteMs: number;
  attestationMs: number;
  mediaPrepareMs: number;
  remotePublishMs: number;
  postPublishFollowupMs: number;
  localCommitMs: number;
  totalMs: number;
};

function emptyPublishStageTimings(job: { timestamp?: number }): PublishStageTimings {
  const now = Date.now();
  return {
    queueWaitMs: typeof job.timestamp === 'number' ? Math.max(0, now - job.timestamp) : 0,
    loadStateMs: 0,
    tokenRefreshMs: 0,
    prepareRouteMs: 0,
    attestationMs: 0,
    mediaPrepareMs: 0,
    remotePublishMs: 0,
    postPublishFollowupMs: 0,
    localCommitMs: 0,
    totalMs: 0,
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function logPublishStageTimings(input: {
  timings: PublishStageTimings;
  workspaceId: string;
  platformPostId: string;
  operationId?: string;
  platform?: Platform;
}): void {
  logger.info(
    {
      workspaceId: input.workspaceId,
      platformPostId: input.platformPostId,
      operationId: input.operationId,
      platform: input.platform,
      ...input.timings,
    },
    'Publish processor stage timings',
  );
}

export function createPublishPostProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: {
    forWorkspace(
      workspaceId: string,
      route?: WorkspaceRouteOptions,
    ): Promise<WorkspaceAdapterContext>;
  };
  locks: JobLockService;
  storage: { client: S3Client; bucket: string; publicBaseUrl?: string };
  reconcileQueue?: Queue;
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    timestamp?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = publishPostPayloadSchema.parse(job.data);
    const jobName = job.name ?? 'publish-post';
    const jobId = job.id ?? `publish-post:${payload.platformPostId}`;
    const startedAt = new Date();

    await markBackgroundJobRunning(input.prisma, jobName, jobId, payload, job);

    try {
      const result = await input.locks.withLock(
        `publish-post:${payload.platformPostId}`,
        120_000,
        async () => {
          const timer = setInterval(() => {
            input.prisma.platformPost
              .update({
                where: { id: payload.platformPostId },
                data: { lastAttemptAt: new Date() },
              })
              .catch((err) => logger.error({ err }, 'Lỗi heartbeat'));
          }, 30000);

          try {
            return await publishPlatformPost(input, payload, job);
          } finally {
            clearInterval(timer);
          }
        },
      );

      if (result === null) {
        logger.warn({ jobId: job.id, payload }, 'PlatformPost đang được worker khác xử lý');
        const skipped = { skipped: true, reason: 'locked' };
        await markBackgroundJobFinished(input.prisma, jobName, jobId, startedAt, {
          status: 'COMPLETED',
          payload,
        });
        return skipped;
      }

      await markBackgroundJobFinished(input.prisma, jobName, jobId, startedAt, {
        status: shouldMarkDead(result) ? 'DEAD' : 'COMPLETED',
        payload,
        errorCode: shouldMarkDead(result) ? String(result.reason ?? 'FAILED') : undefined,
      });

      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;

      const decision = decideOnError(error, attempt, maxAttempts);
      const isDead = decision.action === 'FAIL_PERMANENTLY';

      let errorCode: string = isPlatformError(error) ? error.kind : 'UNKNOWN';
      if (isDead && errorCode === 'NETWORK') {
        errorCode = 'REMOTE_RESULT_UNKNOWN';
        decision.reason =
          'Mất kết nối mạng khi đang thực hiện tác vụ, không thể xác định kết quả phía nền tảng.';
      }

      await markBackgroundJobFinished(input.prisma, jobName, jobId, startedAt, {
        status: isDead ? 'DEAD' : 'FAILED',
        payload,
        errorCode,
        errorMessage: decision.reason,
        isDead,
      });

      if (isDead) {
        const recoveryScheduled = await ensurePublishLocalCommitRecovery(input.prisma, {
          payload,
          platformPostId: payload.platformPostId,
          workspaceId: payload.workspaceId,
        });
        if (recoveryScheduled) {
          return { published: false, reason: 'LOCAL_COMMIT_RECOVERY_SCHEDULED' };
        }
        // Cập nhật post thành FAILED để người dùng biết
        const contentPostId = await markFailed(
          input.prisma,
          payload.platformPostId,
          errorCode,
          decision.reason,
        );
        await updateParentStatus(input.prisma, contentPostId);
        throw new UnrecoverableError(decision.reason);
      }

      throw error;
    }
  };
}

async function publishPlatformPost(
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
    storage: { client: S3Client; bucket: string; publicBaseUrl?: string };
    reconcileQueue?: Queue;
  },
  payload: z.infer<typeof publishPostPayloadSchema>,
  job: { id?: string; attemptsMade?: number; timestamp?: number; opts?: { attempts?: number } },
) {
  const totalStartedAt = Date.now();
  const timings = emptyPublishStageTimings(job);
  let timingPlatform: Platform | undefined;
  let timingOperationId = payload.operationId;
  try {
    const loadStateStartedAt = Date.now();
    const platformPost = await input.prisma.platformPost.findFirst({
      where: { id: payload.platformPostId, workspaceId: payload.workspaceId },
      include: {
        socialAccount: { include: { token: true } },
        media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
        contentPost: {
          include: {
            media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
            platformPosts: true,
          },
        },
      },
    });
    timings.loadStateMs = elapsedMs(loadStateStartedAt);
    timingPlatform = platformPost?.platform as Platform | undefined;

    if (!platformPost) {
      logger.warn({ jobId: job.id, payload }, 'Không tìm thấy PlatformPost để publish');
      return { published: false, reason: 'not_found' };
    }

    const initialState = jsonObject(platformPost.platformState);
    const initialPendingDelete = jsonObject(
      (initialState?.pendingDelete as Prisma.JsonValue | undefined) ?? null,
    );
    if (
      platformPost.status === 'DELETED' ||
      Boolean(platformPost.contentPost?.deletedAt) ||
      initialPendingDelete?.state === 'QUEUED' ||
      initialPendingDelete?.state === 'PROCESSING'
    ) {
      logger.info(
        { platformPostId: platformPost.id, status: platformPost.status },
        'Bỏ qua publish vì bài đã bị xóa hoặc đang chờ xóa',
      );
      return { published: false, reason: 'deleted' };
    }

    if (platformPost.externalPostId || platformPost.status === 'PUBLISHED') {
      return { published: false, reason: 'already_published' };
    }

    if (platformPost.status === 'REMOTE_RESULT_UNKNOWN') {
      logger.warn(
        {
          platformPostId: platformPost.id,
          publishAttemptId: platformPost.publishAttemptId,
        },
        'Không publish lại khi remote result chưa được xác định',
      );
      return { published: false, reason: 'REMOTE_RESULT_UNKNOWN' };
    }

    const operationId = await resolvePublishOperationId(
      input.prisma,
      platformPost,
      payload.operationId,
    );
    timingOperationId = operationId;
    const startOperation = await beginOutboundAttempt(input.prisma, operationId, {
      expected: {
        workspaceId: payload.workspaceId,
        operationType: 'PUBLISH_POST',
        resourceType: 'PlatformPost',
        resourceId: platformPost.id,
      },
    });
    if (startOperation.action === 'LOCAL_COMMIT') {
      const localCommitStartedAt = Date.now();
      try {
        return await commitPublishLocally(input.prisma, {
          platformPost,
          payload,
          jobId: job.id,
          ownership: startOperation.ownership,
        });
      } finally {
        timings.localCommitMs = elapsedMs(localCommitStartedAt);
      }
    }
    if (startOperation.action === 'RECONCILE' && startOperation.reason === 'REMOTE_UNKNOWN') {
      await ensurePublishReconciliationIntent(input.prisma, {
        platformPost,
        payload,
        operationId,
      });
      await updateParentStatus(input.prisma, platformPost.contentPostId);
      return { published: false, reason: 'REMOTE_RESULT_UNKNOWN' };
    }
    if (startOperation.action !== 'DISPATCH_REMOTE') {
      return { published: false, reason: startOperation.reason };
    }
    const operationOwnership: OutboundAttemptOwnership | null = startOperation.ownership;

    if (!platformPost.socialAccount.token || platformPost.socialAccount.status !== 'CONNECTED') {
      await rollbackBeforeConnect(input.prisma, operationOwnership, {
        code: 'ACCOUNT_DISCONNECTED',
        message: 'Social account is not connected before remote publish dispatch.',
      });
      await markFailed(
        input.prisma,
        platformPost.id,
        'ACCOUNT_DISCONNECTED',
        'Social account chưa kết nối.',
      );
      await updateParentStatus(input.prisma, platformPost.contentPostId);
      return { published: false, reason: 'account_disconnected' };
    }

    await input.prisma.platformPost.update({
      where: { id: platformPost.id },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    await input.prisma.contentPost.update({
      where: { id: platformPost.contentPostId },
      data: { status: 'PROCESSING' },
    });

    const prepareRouteStartedAt = Date.now();
    const adaptersContext = await input.adapterFactory
      .forWorkspace(payload.workspaceId, {
        storeId: platformPost.socialAccount.storeId ?? null,
        target: platformPost.platform,
      })
      .catch(async (error) => {
        if (operationOwnership) {
          await rollbackBeforeConnect(input.prisma, operationOwnership, {
            code: error instanceof Error ? error.name : 'ADAPTER_PREPARE_FAILED',
            message: error instanceof Error ? error.message : 'Adapter preparation failed.',
          });
        }
        throw error;
      });
    timings.prepareRouteMs = elapsedMs(prepareRouteStartedAt);
    timings.attestationMs = adaptersContext.proxy?.attestation ? timings.prepareRouteMs : 0;
    try {
      await recordRouteMetadata(input.prisma, operationOwnership, {
        routeConfigVersion: adaptersContext.proxy?.configVersion ?? null,
        routeProxyFingerprint: adaptersContext.proxy?.routeFingerprint ?? null,
        routeCountryCode: adaptersContext.proxy?.attestation?.countryCode ?? null,
      });
      const adapters = adaptersContext.adapters;
      const adapter = adapters.get(platformPost.platform);
      if (
        platformPost.socialAccount.scopes.includes('development-fixture') &&
        !(adapter instanceof DevelopmentFixtureAdapter)
      ) {
        const message =
          'Social account này được tạo bằng development fixture. Hãy disconnect và kết nối lại bằng OAuth thật trước khi publish.';
        if (operationOwnership) {
          await markPreTargetFailed(input.prisma, operationOwnership, {
            code: 'ACCOUNT_RECONNECT_REQUIRED',
            message,
          });
        }
        await markFailed(input.prisma, platformPost.id, 'ACCOUNT_RECONNECT_REQUIRED', message);
        await input.prisma.socialAccount.update({
          where: { id: platformPost.socialAccountId },
          data: { status: 'DISCONNECTED', lastErrorAt: new Date(), lastErrorMessage: message },
        });
        await updateParentStatus(input.prisma, platformPost.contentPostId);
        return { published: false, reason: 'fixture_account_with_real_adapter' };
      }

      const publishNetworkProof = buildPublishNetworkProof({
        egressPolicy: adaptersContext.proxy?.egressPolicy ?? null,
        proxyEnabled: adaptersContext.proxy?.config.enabled ?? null,
        proxyActive: adaptersContext.proxy ? Boolean(adaptersContext.proxy.attestation) : null,
        configVersion: adaptersContext.proxy?.configVersion ?? null,
        proxyFingerprint: adaptersContext.proxy?.routeFingerprint ?? null,
        countryLock: adaptersContext.proxy?.config.countryLock ?? null,
        countryLockSatisfied: adaptersContext.proxy?.config.countryLock
          ? adaptersContext.proxy.attestation?.countryCode ===
            adaptersContext.proxy.config.countryLock
          : null,
        attestation: adaptersContext.proxy?.attestation ?? null,
        checkOk: adaptersContext.proxy?.attestation ? true : null,
      });
      let publishAttemptId: string | null = null;
      let remoteReturnedSuccess = false;
      let remoteConfirmationPersisted = false;

      try {
        const tokenRefreshStartedAt = Date.now();
        const accessToken = await getFreshAccessToken({
          prisma: input.prisma,
          keyring: input.keyring,
          locks: input.locks,
          adapter,
          account: {
            id: platformPost.socialAccount.id,
            workspaceId: platformPost.socialAccount.workspaceId,
            platform: platformPost.socialAccount.platform,
            token: platformPost.socialAccount.token,
          },
        });
        timings.tokenRefreshMs = elapsedMs(tokenRefreshStartedAt);
        const sourceMedia =
          platformPost.media.length > 0 ? platformPost.media : platformPost.contentPost.media;
        const options = jsonObject(platformPost.options);
        const mediaPrepareStartedAt = Date.now();
        const media = await Promise.all(
          sourceMedia
            .filter((item) => item.mediaAsset.status === 'READY')
            .map((item) =>
              mediaInputFromAsset(input.storage, item.mediaAsset, platformPost.platform),
            ),
        );
        const thumbnail = await thumbnailInputFromOptions({
          storage: input.storage,
          prisma: input.prisma,
          workspaceId: payload.workspaceId,
          platform: platformPost.platform,
          options,
          sourceMedia,
        });
        timings.mediaPrepareMs = elapsedMs(mediaPrepareStartedAt);
        logger.info(
          {
            correlationId: payload.correlationId,
            platformPostId: platformPost.id,
            platform: platformPost.platform,
            mediaCount: media.length,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            media: platformPost.contentPost.media.map((item: any, index: number) => ({
              index,
              type: item.type,
              mimeType: item.mimeType,
              sizeBytes: item.sizeBytes,
              byteLength: item.bytes?.byteLength ?? 0,
            })),
            thumbnailSelection: {
              mode:
                options?.thumbnailMode ??
                (platformPost.platform === 'FACEBOOK' && thumbnail
                  ? 'GENERATED_FALLBACK'
                  : undefined),
              mediaAssetId: options?.thumbnailMediaAssetId,
            },
            thumbnail: thumbnail
              ? {
                  type: thumbnail.type,
                  mimeType: thumbnail.mimeType,
                  sizeBytes: thumbnail.sizeBytes,
                  byteLength: thumbnail.bytes?.byteLength ?? 0,
                }
              : undefined,
          },
          'Chuẩn bị media trước khi gọi platform publish',
        );

        const publishInput = {
          caption: platformPost.caption ?? platformPost.contentPost.body ?? undefined,
          title: platformPost.title ?? platformPost.contentPost.title ?? undefined,
          description: platformPost.description ?? platformPost.contentPost.body ?? undefined,
          linkUrl: platformPost.linkUrl ?? platformPost.contentPost.linkUrl ?? undefined,
          hashtags: platformPost.contentPost.hashtags,
          media,
          thumbnail,
          options,
        };

        const validation = adapter.validatePost(publishInput);
        if (!validation.valid) {
          if (operationOwnership) {
            await markPreTargetFailed(input.prisma, operationOwnership, {
              code: 'VALIDATION',
              message: validation.issues
                .map(
                  (issue: { field: string; message: string }) => `${issue.field}: ${issue.message}`,
                )
                .join('; '),
            });
          }
          await markFailed(
            input.prisma,
            platformPost.id,
            'VALIDATION',
            validation.issues
              .map(
                (issue: { field: string; message: string }) => `${issue.field}: ${issue.message}`,
              )
              .join('; '),
          );
          await updateParentStatus(input.prisma, platformPost.contentPostId);
          return { published: false, reason: 'validation' };
        }

        const adapterContext = {
          accessToken,
          externalAccountId: platformPost.socialAccount.externalAccountId,
          externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
          correlationId: payload.correlationId,
          logger: adapterLogger,
          onRemoteCheckpoint: async (checkpoint: RemotePublishCheckpoint) => {
            if (!operationOwnership) return;
            await storeRemoteCheckpoint(input.prisma, operationOwnership, checkpoint);
          },
        } satisfies AdapterContext;

        const accountStillEligible = await input.prisma.socialAccount.findUnique({
          where: { id: platformPost.socialAccountId },
          select: { status: true, disconnectGeneration: true },
        });
        if (
          !accountStillEligible ||
          accountStillEligible.status !== 'CONNECTED' ||
          accountStillEligible.disconnectGeneration !==
            platformPost.socialAccount.disconnectGeneration
        ) {
          await rollbackBeforeConnect(input.prisma, operationOwnership, {
            code: 'ACCOUNT_DISCONNECTED',
            message: 'Social account disconnected before remote publish dispatch.',
          });
          await markFailed(
            input.prisma,
            platformPost.id,
            'ACCOUNT_DISCONNECTED',
            'Social account disconnected before remote publish dispatch.',
          );
          await updateParentStatus(input.prisma, platformPost.contentPostId);
          return { published: false, reason: 'account_disconnected' };
        }

        publishAttemptId = operationOwnership.attemptId || randomUUID();
        await input.prisma.platformPost.update({
          where: { id: platformPost.id },
          data: {
            publishAttemptId,
            publishAttemptStartedAt: new Date(),
            publishFence: { increment: 1 },
          },
        });

        const remotePublishStartedAt = Date.now();
        const result = await adapter.publishPost(adapterContext, publishInput);
        timings.remotePublishMs = elapsedMs(remotePublishStartedAt);
        remoteReturnedSuccess = true;
        if ((result as { pending?: boolean }).pending) {
          await markRemoteUnknown(input.prisma, operationOwnership, {
            code: 'REMOTE_PROCESSING_PENDING',
            message: 'Provider accepted publish request but final public post id is pending.',
            providerRequestId: result.externalPostId,
            requiresManualReview: false,
            checkpoint: {
              remotePublishId: result.externalPostId,
              externalUrl: result.externalUrl,
              acceptedAt: result.publishedAt.toISOString(),
              publishNetwork: publishNetworkProof,
              pending: true,
            },
          });
          remoteConfirmationPersisted = true;
          publishAttemptId = operationOwnership.attemptId;
          await persistRemoteUnknownPublishState(input.prisma, {
            platformPost,
            payload,
            publishAttemptId,
            operationId: operationOwnership.operationId,
            code: 'REMOTE_PROCESSING_PENDING',
            message: 'Provider accepted publish request but final public post id is pending.',
            platformState: mergePlatformStateWithNetworkProof(
              jsonObject(platformPost.platformState),
              publishNetworkProof,
            ),
          });
          await updateParentStatus(input.prisma, platformPost.contentPostId);
          return { published: false, reason: 'REMOTE_PROCESSING_PENDING' };
        }
        await markRemoteConfirmed(input.prisma, operationOwnership, {
          remoteId: result.externalPostId,
          checkpoint: {
            externalPostId: result.externalPostId,
            externalUrl: result.externalUrl,
            publishedAt: result.publishedAt.toISOString(),
            publishNetwork: publishNetworkProof,
          },
        });
        remoteConfirmationPersisted = true;

        const postUploadCheck =
          typeof input.prisma.platformPost.findUnique === 'function'
            ? await input.prisma.platformPost.findUnique({
                where: { id: platformPost.id },
                select: {
                  status: true,
                  platformState: true,
                  contentPost: { select: { deletedAt: true } },
                },
              })
            : undefined;
        const postUploadState = jsonObject(postUploadCheck?.platformState);
        const postUploadPendingDelete = jsonObject(
          (postUploadState?.pendingDelete as Prisma.JsonValue | undefined) ?? null,
        );
        if (
          postUploadCheck === null ||
          postUploadCheck?.status === 'DELETED' ||
          Boolean(postUploadCheck?.contentPost?.deletedAt) ||
          postUploadPendingDelete?.state === 'QUEUED' ||
          postUploadPendingDelete?.state === 'PROCESSING'
        ) {
          logger.warn(
            {
              platformPostId: platformPost.id,
              externalPostId: result.externalPostId,
            },
            'Phát hiện yêu cầu xóa bài trong lúc đang publish — tiến hành thu hồi bài vừa đăng',
          );
          if ('deletePost' in adapter && typeof adapter.deletePost === 'function') {
            await adapter
              .deletePost(adapterContext, result.externalPostId)
              .catch((deleteErr: unknown) => {
                logger.warn(
                  {
                    err: deleteErr,
                    platformPostId: platformPost.id,
                    externalPostId: result.externalPostId,
                  },
                  'Không thể thu hồi ngay bài vừa đăng sau khi user bấm xóa giữa chừng',
                );
              });
          }
          if (postUploadCheck) {
            await input.prisma.$transaction(async (tx) => {
              await tx.platformPost.update({
                where: { id: platformPost.id },
                data: {
                  status: 'DELETED',
                  externalPostId: null,
                  errorCode: null,
                  errorMessage: null,
                },
              });
              await markLocalCommittedInTransaction(tx, operationOwnership);
            });
            await updateParentStatus(input.prisma, platformPost.contentPostId);
          }
          return { published: false, reason: 'deleted_during_publish' };
        }

        const postPublishFollowupStartedAt = Date.now();
        const platformState = await platformStateAfterPublish(
          adapter,
          adapterContext,
          result.externalPostId,
        );
        timings.postPublishFollowupMs = elapsedMs(postPublishFollowupStartedAt);
        const platformStateWithNetwork = mergePlatformStateWithNetworkProof(
          platformState,
          publishNetworkProof,
        );

        const localCommitStartedAt = Date.now();
        try {
          return await commitPublishLocally(input.prisma, {
            platformPost,
            payload,
            jobId: job.id,
            ownership: operationOwnership,
            result: {
              externalPostId: result.externalPostId,
              externalUrl: result.externalUrl,
              publishedAt: result.publishedAt,
              platformState: platformStateWithNetwork,
              publishNetworkProof,
            },
          });
        } finally {
          timings.localCommitMs = elapsedMs(localCommitStartedAt);
        }
      } catch (error) {
        const attempt = (job.attemptsMade ?? 0) + 1;
        const maxAttempts = job.opts?.attempts ?? 1;
        const code = isPlatformError(error) ? error.kind : 'UNKNOWN';
        const message = error instanceof Error ? error.message : 'Lỗi không xác định khi publish.';

        if (error instanceof RemoteRequestError && !error.requestMayHaveReachedRemote) {
          if (operationOwnership) {
            const rolledBack = await rollbackBeforeConnect(input.prisma, operationOwnership, {
              code: error.phase,
              message,
            });
            if (!rolledBack) throw error;
          }
          await input.prisma.platformPost.update({
            where: { id: platformPost.id },
            data: {
              status: 'QUEUED',
              errorCode: error.phase,
              errorMessage: message,
              platformState: publishNetworkProof
                ? (mergePlatformStateWithNetworkProof(
                    jsonObject(platformPost.platformState),
                    publishNetworkProof,
                  ) as Prisma.InputJsonValue)
                : undefined,
            },
          });
          await updateParentStatus(input.prisma, platformPost.contentPostId);
          throw error;
        }

        if (remoteConfirmationPersisted) {
          logger.error(
            {
              err: error,
              platformPostId: platformPost.id,
              operationId: operationOwnership?.operationId,
            },
            'Publish remote confirmation is durable; retrying local commit only',
          );
          throw error;
        }

        const decision = decideOnError(error, attempt, maxAttempts);
        const isRemoteUnknown =
          (remoteReturnedSuccess && !remoteConfirmationPersisted) ||
          error instanceof RemoteCheckpointPersistenceError ||
          (error instanceof RemoteRequestError && error.requestMayHaveReachedRemote) ||
          (isPlatformError(error) && error.kind === 'NETWORK');

        if (isRemoteUnknown && operationOwnership) {
          await markRemoteUnknown(input.prisma, operationOwnership, {
            code: 'REMOTE_RESULT_UNKNOWN',
            message,
            providerRequestId:
              error instanceof RemoteRequestError ? error.providerRequestId : undefined,
          });
        } else if (operationOwnership && !remoteReturnedSuccess) {
          await rollbackBeforeConnect(input.prisma, operationOwnership, {
            code,
            message,
          });
        }

        const targetStatus: PlatformPostStatus = isRemoteUnknown
          ? 'REMOTE_RESULT_UNKNOWN'
          : decision.action === 'RETRY'
            ? 'QUEUED'
            : 'FAILED';

        const targetCode = isRemoteUnknown ? 'REMOTE_RESULT_UNKNOWN' : code;
        const currentPostState = publishNetworkProof
          ? await input.prisma.platformPost.findUnique({
              where: { id: platformPost.id },
              select: { platformState: true },
            })
          : null;

        const nextPlatformState = publishNetworkProof
          ? mergePlatformStateWithNetworkProof(
              jsonObject(currentPostState?.platformState) ?? jsonObject(platformPost.platformState),
              publishNetworkProof,
            )
          : undefined;

        if (isRemoteUnknown) {
          if (publishAttemptId && operationOwnership) {
            await persistRemoteUnknownPublishState(input.prisma, {
              platformPost,
              payload,
              publishAttemptId,
              operationId: operationOwnership.operationId,
              code: targetCode,
              message,
              platformState: nextPlatformState,
            });
          } else {
            logger.error(
              {
                platformPostId: platformPost.id,
                publishAttemptId,
                hasReconcileQueue: Boolean(input.reconcileQueue),
              },
              'Không thể lên lịch reconciliation cho remote result unknown',
            );
            await input.prisma.platformPost.update({
              where: { id: platformPost.id },
              data: {
                status: targetStatus,
                errorCode: targetCode,
                errorMessage: message,
                platformState: nextPlatformState
                  ? (nextPlatformState as Prisma.InputJsonValue)
                  : undefined,
                requiresManualReview: true,
                reconciliationError: 'Không thể lên lịch đối soát tự động.',
              },
            });
          }
        } else {
          await input.prisma.platformPost.update({
            where: { id: platformPost.id },
            data: {
              status: targetStatus,
              errorCode: targetCode,
              errorMessage: message,
              platformState: nextPlatformState
                ? (nextPlatformState as Prisma.InputJsonValue)
                : undefined,
            },
          });
        }

        if (decision.markAccountDisconnected) {
          await input.prisma.socialAccount.update({
            where: { id: platformPost.socialAccountId },
            data: { status: 'DISCONNECTED', lastErrorAt: new Date(), lastErrorMessage: message },
          });
        }

        if (decision.notifyUser) {
          await input.prisma.notification.create({
            data: {
              workspaceId: payload.workspaceId,
              userId: platformPost.contentPost.createdById,
              type: 'POST_FAILED',
              title: 'Publish thất bại',
              body: `${PLATFORM_LABELS[platformPost.platform]} · ${platformPost.socialAccount.name}: ${message}`,
              linkUrl: `/posts/${platformPost.contentPostId}`,
              data: {
                platformPostId: platformPost.id,
                platform: platformPost.platform,
                accountName: platformPost.socialAccount.name,
                socialAccountId: platformPost.socialAccountId,
                code,
                postTitle: platformPost.contentPost.title,
              },
            },
          });
        }

        await updateParentStatus(input.prisma, platformPost.contentPostId);

        if (isRemoteUnknown) return { published: false, reason: 'REMOTE_RESULT_UNKNOWN' };
        if (decision.action === 'RETRY') throw error;
        return { published: false, reason: decision.reason };
      }
    } finally {
      await adaptersContext.release();
    }
  } finally {
    timings.totalMs = elapsedMs(totalStartedAt);
    logPublishStageTimings({
      timings,
      workspaceId: payload.workspaceId,
      platformPostId: payload.platformPostId,
      operationId: timingOperationId,
      platform: timingPlatform,
    });
  }
}

function jsonObject(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function mergePlatformStateWithNetworkProof(
  platformState:
    TikTokPublishPlatformState | YouTubeVideoPlatformState | Record<string, unknown> | undefined,
  publishNetwork: PublishNetworkProof | null,
): Record<string, unknown> {
  return {
    ...(platformState ?? {}),
    publishNetwork,
  };
}

async function resolvePublishOperationId(
  prisma: PrismaClientInstance,
  platformPost: {
    id: string;
    workspaceId: string;
    status: PlatformPostStatus;
    publishAttemptId: string | null;
    publishAttemptStartedAt: Date | null;
    publishFence: number;
  },
  payloadOperationId: string | undefined,
): Promise<string> {
  if (payloadOperationId) return payloadOperationId;

  const latest = await prisma.outboundOperation.findFirst({
    where: {
      operationType: 'PUBLISH_POST',
      resourceType: 'PlatformPost',
      resourceId: platformPost.id,
    },
    orderBy: { operationGeneration: 'desc' },
  });
  if (latest) return latest.id;

  const operationGeneration = 1;
  const requestKey = operationRequestKey({
    operationType: 'PUBLISH_POST',
    resourceType: 'PlatformPost',
    resourceId: platformPost.id,
    operationGeneration,
  });
  const mayHaveDispatched =
    platformPost.status === 'PROCESSING' ||
    Boolean(platformPost.publishAttemptId || platformPost.publishAttemptStartedAt);

  const operation = await prisma.outboundOperation.upsert({
    where: {
      operationType_resourceType_resourceId_operationGeneration: {
        operationType: 'PUBLISH_POST',
        resourceType: 'PlatformPost',
        resourceId: platformPost.id,
        operationGeneration,
      },
    },
    create: {
      workspaceId: platformPost.workspaceId,
      operationType: 'PUBLISH_POST',
      resourceType: 'PlatformPost',
      resourceId: platformPost.id,
      operationGeneration,
      requestKey,
      state: mayHaveDispatched ? 'REMOTE_UNKNOWN' : 'PREPARED',
      attemptId: platformPost.publishAttemptId,
      fence: mayHaveDispatched ? Math.max(platformPost.publishFence, 1) : 0,
      requiresManualReview: mayHaveDispatched,
      lastErrorCode: mayHaveDispatched ? 'LEGACY_MAY_HAVE_DISPATCHED' : null,
      lastErrorMessage: mayHaveDispatched
        ? 'Legacy publish job had no operationId and may already have dispatched.'
        : null,
      remoteStartedAt: platformPost.publishAttemptStartedAt,
    },
    update: {},
  });
  return operation.id;
}

async function commitPublishLocally(
  prisma: PrismaClientInstance,
  input: {
    platformPost: {
      id: string;
      workspaceId: string;
      contentPostId: string;
      platform: Platform;
      socialAccountId: string;
      socialAccount: { name: string };
      contentPost: { createdById: string; title: string | null };
    };
    payload: z.infer<typeof publishPostPayloadSchema>;
    jobId?: string;
    ownership: OutboundAttemptOwnership;
    result?: {
      externalPostId: string;
      externalUrl?: string;
      publishedAt: Date;
      platformState?: Record<string, unknown>;
      publishNetworkProof: PublishNetworkProof | null;
    };
  },
): Promise<{ published: true; externalPostId: string }> {
  const result = input.result ?? (await loadPublishCheckpoint(prisma, input.ownership));

  await prisma.$transaction(async (tx) => {
    await tx.platformPost.update({
      where: { id: input.platformPost.id },
      data: {
        status: 'PUBLISHED',
        externalPostId: result.externalPostId,
        externalUrl: result.externalUrl,
        publishedAt: result.publishedAt,
        errorCode: null,
        errorMessage: null,
        platformState: (result.platformState ??
          mergePlatformStateWithNetworkProof(
            undefined,
            result.publishNetworkProof,
          )) as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: input.payload.workspaceId,
        actorUserId: input.platformPost.contentPost.createdById,
        action: 'POST_PUBLISHED',
        resourceType: 'PlatformPost',
        resourceId: input.platformPost.id,
        metadata: {
          platform: input.platformPost.platform,
          externalPostId: result.externalPostId,
          jobId: input.jobId,
          publishNetwork: result.publishNetworkProof,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.notification.create({
      data: {
        workspaceId: input.payload.workspaceId,
        userId: input.platformPost.contentPost.createdById,
        type: 'POST_PUBLISHED',
        title: 'Bài đăng đã publish',
        body: `${PLATFORM_LABELS[input.platformPost.platform]} · ${input.platformPost.socialAccount.name} đã publish thành công.`,
        linkUrl: `/posts/${input.platformPost.contentPostId}`,
        data: {
          platformPostId: input.platformPost.id,
          platform: input.platformPost.platform,
          accountName: input.platformPost.socialAccount.name,
          socialAccountId: input.platformPost.socialAccountId,
          externalPostId: result.externalPostId,
          postTitle: input.platformPost.contentPost.title,
        },
      },
    });
    await markLocalCommittedInTransaction(tx, input.ownership);
  });

  await updateParentStatus(prisma, input.platformPost.contentPostId);
  return { published: true, externalPostId: result.externalPostId };
}

async function persistRemoteUnknownPublishState(
  prisma: PrismaClientInstance,
  input: {
    platformPost: {
      id: string;
      workspaceId: string;
      contentPostId: string;
    };
    payload: z.infer<typeof publishPostPayloadSchema>;
    publishAttemptId: string;
    operationId: string;
    code: string;
    message: string;
    platformState?: Record<string, unknown>;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.platformPost.update({
      where: { id: input.platformPost.id },
      data: {
        status: 'REMOTE_RESULT_UNKNOWN',
        errorCode: input.code,
        errorMessage: input.message,
        requiresManualReview: false,
        reconciliationError: null,
        platformState: input.platformState
          ? (input.platformState as Prisma.InputJsonValue)
          : undefined,
      },
    });
    const reconcilePayload = {
      platformPostId: input.platformPost.id,
      workspaceId: input.payload.workspaceId,
      publishAttemptId: input.publishAttemptId,
      operationId: input.operationId,
    };
    const reconcileJobId = buildJobId('reconcile-platform-post', reconcilePayload);
    await createQueueOutboxEvent(tx, {
      workspaceId: input.payload.workspaceId,
      queueName: 'reconcile-platform-post',
      jobId: reconcileJobId,
      payload: reconcilePayload,
      options: buildQueueJobOptions('reconcile-platform-post', reconcileJobId, {
        delay: 60_000,
      }),
      aggregateType: 'OutboundOperation',
      aggregateId: input.operationId,
      dedupeKey: `reconcile-publish:${input.operationId}:${input.publishAttemptId}`,
    });
  });
}

async function ensurePublishReconciliationIntent(
  prisma: PrismaClientInstance,
  input: {
    platformPost: {
      id: string;
      workspaceId: string;
      contentPostId: string;
      status: PlatformPostStatus;
      platformState: Prisma.JsonValue | null;
    };
    payload: z.infer<typeof publishPostPayloadSchema>;
    operationId: string;
  },
): Promise<boolean> {
  const operation = await prisma.outboundOperation.findUnique({
    where: { id: input.operationId },
    select: { id: true, state: true, attemptId: true },
  });
  if (operation?.state !== 'REMOTE_UNKNOWN' || !operation.attemptId) return false;

  await persistRemoteUnknownPublishState(prisma, {
    platformPost: input.platformPost,
    payload: input.payload,
    publishAttemptId: operation.attemptId,
    operationId: operation.id,
    code: 'REMOTE_RESULT_UNKNOWN',
    message: 'Remote publish outcome is unknown and requires reconciliation.',
    platformState: jsonObject(input.platformPost.platformState),
  });
  return true;
}

async function ensurePublishLocalCommitRecovery(
  prisma: PrismaClientInstance,
  input: {
    payload: z.infer<typeof publishPostPayloadSchema>;
    platformPostId: string;
    workspaceId: string;
  },
): Promise<boolean> {
  const operation = await findPublishOperationForPayload(prisma, input);
  if (operation?.state !== 'REMOTE_CONFIRMED' || !operation.attemptId) return false;

  const recoveryPayload = {
    ...input.payload,
    operationId: operation.id,
    workspaceId: input.workspaceId,
    platformPostId: input.platformPostId,
  };
  const recoveryJobId = buildJobId('publish-post', recoveryPayload);
  await createQueueOutboxEvent(prisma, {
    workspaceId: input.workspaceId,
    queueName: 'publish-post',
    jobId: recoveryJobId,
    payload: recoveryPayload,
    options: buildQueueJobOptions('publish-post', recoveryJobId),
    aggregateType: 'OutboundOperation',
    aggregateId: operation.id,
    dedupeKey: `local-commit-publish:${operation.id}:${operation.attemptId}`,
  });
  return true;
}

async function findPublishOperationForPayload(
  prisma: PrismaClientInstance,
  input: {
    payload: z.infer<typeof publishPostPayloadSchema>;
    platformPostId: string;
    workspaceId: string;
  },
): Promise<{ id: string; state: string; attemptId: string | null } | null> {
  if (input.payload.operationId) {
    return await prisma.outboundOperation.findUnique({
      where: { id: input.payload.operationId },
      select: { id: true, state: true, attemptId: true },
    });
  }

  return await prisma.outboundOperation.findFirst({
    where: {
      workspaceId: input.workspaceId,
      operationType: 'PUBLISH_POST',
      resourceType: 'PlatformPost',
      resourceId: input.platformPostId,
    },
    orderBy: { operationGeneration: 'desc' },
    select: { id: true, state: true, attemptId: true },
  });
}

async function loadPublishCheckpoint(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
): Promise<{
  externalPostId: string;
  externalUrl?: string;
  publishedAt: Date;
  platformState?: Record<string, unknown>;
  publishNetworkProof: PublishNetworkProof | null;
}> {
  const operation = await prisma.outboundOperation.findUnique({
    where: { id: ownership.operationId },
    select: { remoteCheckpoint: true },
  });
  const checkpoint = jsonObject(operation?.remoteCheckpoint);
  const externalPostId =
    typeof checkpoint?.externalPostId === 'string' ? checkpoint.externalPostId : null;
  const publishedAt =
    typeof checkpoint?.publishedAt === 'string' ? new Date(checkpoint.publishedAt) : null;
  if (!externalPostId || !publishedAt || Number.isNaN(publishedAt.getTime())) {
    throw new Error('REMOTE_CONFIRMED publish operation is missing durable checkpoint');
  }
  return {
    externalPostId,
    externalUrl: typeof checkpoint?.externalUrl === 'string' ? checkpoint.externalUrl : undefined,
    publishedAt,
    publishNetworkProof:
      (jsonObject(
        checkpoint?.publishNetwork as Prisma.JsonValue | null,
      ) as unknown as PublishNetworkProof | null) ?? null,
  };
}

async function storeRemoteCheckpoint(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  checkpoint: RemotePublishCheckpoint,
): Promise<void> {
  const recordedAt = new Date().toISOString();
  const updated = await prisma.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'DISPATCHING',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: {
      remoteCheckpoint: {
        ...checkpoint,
        operationId: ownership.operationId,
        attemptId: ownership.attemptId,
        fence: ownership.fence,
        recordedAt,
      } as Prisma.InputJsonValue,
    },
  });

  if (updated.count === 0) {
    throw new RemoteCheckpointPersistenceError();
  }
}

class RemoteCheckpointPersistenceError extends Error {
  constructor() {
    super('Checkpoint persistence failed after provider initialized remote state');
    this.name = 'RemoteCheckpointPersistenceError';
  }
}

async function platformStateAfterPublish(
  adapter: SocialPlatformAdapter,
  ctx: AdapterContext,
  externalPostId: string,
): Promise<TikTokPublishPlatformState | YouTubeVideoPlatformState | undefined> {
  if (!hasYouTubeStatusMethods(adapter) && !hasTikTokStatusMethods(adapter)) return undefined;
  try {
    if (hasYouTubeStatusMethods(adapter)) {
      return await adapter.getVideoPlatformState(ctx, externalPostId);
    }
    return await adapter.getPublishPlatformState(ctx, externalPostId);
  } catch (error) {
    logger.warn(
      {
        platform: adapter.platform,
        externalPostId,
        err: isPlatformError(error) ? error.toLogObject() : error,
      },
      'Không lấy được trạng thái xử lý sau khi publish; video đã được tạo nên không fail job',
    );
    return undefined;
  }
}

function hasYouTubeStatusMethods(
  adapter: SocialPlatformAdapter,
): adapter is SocialPlatformAdapter & {
  getVideoPlatformState: (
    ctx: AdapterContext,
    externalPostId: string,
  ) => Promise<YouTubeVideoPlatformState>;
} {
  return adapter.platform === 'YOUTUBE' && 'getVideoPlatformState' in adapter;
}

function hasTikTokStatusMethods(
  adapter: SocialPlatformAdapter,
): adapter is SocialPlatformAdapter & {
  getPublishPlatformState: (
    ctx: AdapterContext,
    externalPostId: string,
  ) => Promise<TikTokPublishPlatformState>;
} {
  return adapter.platform === 'TIKTOK' && 'getPublishPlatformState' in adapter;
}

type MediaAssetForInput = {
  id: string;
  workspaceId: string;
  type: unknown;
  status: unknown;
  storageKey: string;
  thumbnailKey: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
};

async function thumbnailInputFromOptions(input: {
  storage: { client: S3Client; bucket: string; publicBaseUrl?: string };
  prisma: PrismaClientInstance;
  workspaceId: string;
  platform: Platform;
  options: Record<string, unknown> | undefined;
  sourceMedia: Array<{ mediaAsset: MediaAssetForInput }>;
}): Promise<MediaInput | undefined> {
  if (!platformSupportsExternalThumbnail(input.platform)) {
    return undefined;
  }

  const mode = input.options?.thumbnailMode;
  if (mode === 'GENERATED' || shouldUseGeneratedThumbnailByDefault(input.platform, mode)) {
    const video = input.sourceMedia.find(
      (item) => item.mediaAsset.type === 'VIDEO' && item.mediaAsset.thumbnailKey,
    )?.mediaAsset;
    if (!video?.thumbnailKey) {
      if (mode !== 'GENERATED') return undefined;
      throw createPlatformError(
        'VALIDATION',
        input.platform,
        'Đã chọn thumbnail tự tạo nhưng video chưa có thumbnail sẵn. Hãy chờ job tạo thumbnail xong rồi publish lại.',
      );
    }
    const thumbnail = await generatedThumbnailInputFromKey(input.storage, video.thumbnailKey);
    return normalizeThumbnailForPlatform(input.platform, thumbnail);
  }

  if (mode === 'MEDIA_ASSET' || mode === 'VIDEO_FRAME') {
    const mediaAssetId =
      typeof input.options?.thumbnailMediaAssetId === 'string'
        ? input.options.thumbnailMediaAssetId
        : null;
    if (!mediaAssetId) {
      throw createPlatformError(
        'VALIDATION',
        input.platform,
        'Đã chọn dùng ảnh cover/thumbnail riêng nhưng chưa chọn media ảnh.',
      );
    }

    const localAsset = input.sourceMedia.find(
      (item) => item.mediaAsset.id === mediaAssetId,
    )?.mediaAsset;
    const mediaAsset =
      localAsset ??
      (await input.prisma.mediaAsset.findFirst({
        where: {
          id: mediaAssetId,
          workspaceId: input.workspaceId,
          type: 'IMAGE',
          status: 'READY',
          deletedAt: null,
        },
      }));

    if (!mediaAsset || mediaAsset.type !== 'IMAGE' || mediaAsset.status !== 'READY') {
      throw createPlatformError(
        'VALIDATION',
        input.platform,
        'Ảnh cover/thumbnail đã chọn không tồn tại, chưa xử lý xong hoặc không phải ảnh.',
      );
    }
    const thumbnail = await mediaInputFromAsset(input.storage, mediaAsset);
    return normalizeThumbnailForPlatform(input.platform, thumbnail);
  }

  return undefined;
}

function platformSupportsExternalThumbnail(platform: Platform): boolean {
  return (
    platform === 'FACEBOOK' ||
    platform === 'INSTAGRAM' ||
    platform === 'PINTEREST' ||
    platform === 'YOUTUBE'
  );
}

function shouldUseGeneratedThumbnailByDefault(platform: Platform, mode: unknown): boolean {
  return platform === 'FACEBOOK' && (mode === undefined || mode === 'AUTO');
}

async function normalizeThumbnailForPlatform(
  platform: Platform,
  thumbnail: MediaInput,
): Promise<MediaInput> {
  if (platform !== 'FACEBOOK') return thumbnail;
  if (!thumbnail.bytes || thumbnail.bytes.byteLength === 0) {
    throw createPlatformError(
      'VALIDATION',
      platform,
      'Thumbnail Facebook cần có dữ liệu ảnh để upload.',
    );
  }

  const bytes = new Uint8Array(
    await sharp(Buffer.from(thumbnail.bytes), { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer(),
  );

  return {
    ...thumbnail,
    url: thumbnail.url.replace(/\.[a-z0-9]+(?=($|\?))/i, '-facebook-thumbnail.jpg'),
    bytes,
    mimeType: 'image/jpeg',
    sizeBytes: bytes.byteLength,
  };
}

async function generatedThumbnailInputFromKey(
  storage: { client: S3Client; bucket: string; publicBaseUrl?: string },
  key: string,
): Promise<MediaInput> {
  const sourceBytes = await readObjectBytes(storage.client, storage.bucket, key);
  const bytes = new Uint8Array(
    await sharp(Buffer.from(sourceBytes)).jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
  );
  const jpegKey = platformCoverKey(key);
  await storage.client.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: jpegKey,
      Body: bytes,
      ContentType: 'image/jpeg',
      ContentLength: bytes.byteLength,
    }),
  );
  return {
    type: 'IMAGE',
    url: publicMediaUrl(storage.publicBaseUrl, storage.bucket, jpegKey),
    bytes,
    mimeType: 'image/jpeg',
    sizeBytes: bytes.byteLength,
  };
}

function platformCoverKey(thumbnailKey: string): string {
  return thumbnailKey.replace(/\.[a-z0-9]+$/i, '-platform-cover.jpg');
}

async function readObjectBytes(client: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return new Uint8Array((await object.Body?.transformToByteArray()) ?? []);
}

async function readObjectRange(
  client: S3Client,
  bucket: string,
  key: string,
  start: number,
  endInclusive: number,
): Promise<Uint8Array> {
  const object = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${start}-${endInclusive}`,
    }),
  );
  return new Uint8Array((await object.Body?.transformToByteArray()) ?? []);
}

export async function mediaInputFromAsset(
  storage: { client: S3Client; bucket: string; publicBaseUrl?: string },
  mediaAsset: {
    type: unknown;
    storageKey: string;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
  },
  platform?: Platform,
): Promise<MediaInput> {
  const base = {
    type: mediaAsset.type as MediaType,
    url: publicMediaUrl(storage.publicBaseUrl, storage.bucket, mediaAsset.storageKey),
    mimeType: mediaAsset.mimeType ?? 'application/octet-stream',
    sizeBytes: mediaAsset.sizeBytes ?? 0,
    width: mediaAsset.width ?? undefined,
    height: mediaAsset.height ?? undefined,
    durationSec: mediaAsset.durationSec ?? undefined,
  };

  if (
    (platform === 'TIKTOK' ||
      platform === 'YOUTUBE' ||
      platform === 'PINTEREST' ||
      platform === 'FACEBOOK') &&
    mediaAsset.type === 'VIDEO'
  ) {
    return {
      ...base,
      readRange: (start, endInclusive) =>
        readObjectRange(storage.client, storage.bucket, mediaAsset.storageKey, start, endInclusive),
    };
  }

  return {
    ...base,
    bytes: await readObjectBytes(storage.client, storage.bucket, mediaAsset.storageKey),
  };
}

function publicMediaUrl(publicBaseUrl: string | undefined, bucket: string, key: string): string {
  if (!publicBaseUrl) return key;
  const url = new URL(publicBaseUrl);
  const existingSegments = url.pathname.split('/').filter(Boolean);
  const keySegments = key.split('/').filter(Boolean).map(encodeURIComponent);
  const needsBucket = !existingSegments.includes(bucket);
  url.pathname = [...existingSegments, ...(needsBucket ? [bucket] : []), ...keySegments].join('/');
  return url.toString();
}

async function markBackgroundJobRunning(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: z.infer<typeof publishPostPayloadSchema>,
  job: { attemptsMade?: number; opts?: { attempts?: number } },
): Promise<void> {
  await prisma.backgroundJob.upsert({
    where: { queueName_jobId: { queueName, jobId } },
    create: {
      workspaceId: payload.workspaceId,
      queueName,
      jobId,
      status: 'RUNNING',
      payload,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      correlationId: payload.correlationId,
    },
    update: {
      status: 'RUNNING',
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

async function markBackgroundJobFinished(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  startedAt: Date,
  input: {
    status: 'COMPLETED' | 'FAILED' | 'DEAD';
    payload: z.infer<typeof publishPostPayloadSchema>;
    errorCode?: string;
    errorMessage?: string;
    isDead?: boolean;
  },
): Promise<void> {
  const finishedAt = new Date();
  await prisma.backgroundJob.update({
    where: { queueName_jobId: { queueName, jobId } },
    data: {
      status: input.status,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      isDead: input.isDead ?? input.status === 'DEAD',
    },
  });
}

function shouldMarkDead(result: unknown): result is { reason: string } {
  if (!result || typeof result !== 'object') return false;
  const reason = (result as { reason?: unknown }).reason;
  if (typeof reason !== 'string') return false;
  return !['already_published', 'locked', 'not_found', 'REMOTE_RESULT_UNKNOWN'].includes(reason);
}

async function markFailed(
  prisma: PrismaClientInstance,
  platformPostId: string,
  code: string,
  message: string,
): Promise<string> {
  const current = await prisma.platformPost.findUnique({
    where: { id: platformPostId },
    select: { contentPostId: true, status: true, externalPostId: true },
  });
  if (!current) throw new Error('PlatformPost not found');
  if (
    current.externalPostId ||
    current.status === 'PUBLISHED' ||
    current.status === 'REMOTE_RESULT_UNKNOWN'
  ) {
    return current.contentPostId;
  }
  await prisma.platformPost.updateMany({
    where: {
      id: platformPostId,
      externalPostId: null,
      status: { notIn: ['PUBLISHED', 'REMOTE_RESULT_UNKNOWN'] },
    },
    data: { status: 'FAILED', errorCode: code, errorMessage: message },
  });
  return current.contentPostId;
}

async function updateParentStatus(
  prisma: PrismaClientInstance,
  contentPostId: string,
): Promise<void> {
  const children = await prisma.platformPost.findMany({
    where: { contentPostId },
    select: { status: true },
  });
  const status = deriveContentPostStatus(children.map((item) => item.status as PlatformPostStatus));
  await prisma.contentPost.update({
    where: { id: contentPostId },
    data: {
      status,
      publishedAt: status === 'PUBLISHED' ? new Date() : undefined,
    },
  });
}

export function createPublishPrisma(
  databaseUrl: string,
  logQueries: boolean,
): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
