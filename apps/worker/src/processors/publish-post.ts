import {
  DevelopmentFixtureAdapter,
  createPlatformError,
  isPlatformError,
  type AdapterContext,
  type AdapterLogger,
  type MediaInput,
  type SocialPlatformAdapter,
  type TikTokPublishPlatformState,
  type YouTubeVideoPlatformState,
} from '@socialhub/platform-adapters';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { createPrismaClient, type Prisma, type PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { randomUUID } from 'node:crypto';
import {
  deriveContentPostStatus,
  PLATFORM_LABELS,
  RemoteRequestError,
  type MediaType,
  type Platform,
  type PlatformPostStatus,
} from '@socialhub/shared';
import sharp from 'sharp';
import type { Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { logger } from '../logger';
import { decideOnError } from '../queue/error-policy';
import { JobLockService } from '../queue/job-lock';

import { getFreshAccessToken } from './token-refresh';

const publishPostPayloadSchema = z
  .object({
    platformPostId: z.string().min(1),
    workspaceId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    requestedByUserId: z.string().min(1).optional(),
  })
  .transform((payload) => ({
    ...payload,
    correlationId:
      payload.correlationId ??
      `retry:${payload.requestedByUserId ?? 'unknown'}:${payload.platformPostId}`,
  }));

import type { ProxyAttestation } from '@socialhub/security';

const adapterLogger: AdapterLogger = {
  debug: (message, context) => logger.debug(context ?? {}, message),
  info: (message, context) => logger.info(context ?? {}, message),
  warn: (message, context) => logger.warn(context ?? {}, message),
  error: (message, context) => logger.error(context ?? {}, message),
};

export function createPublishPostProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
  locks: JobLockService;
  storage: { client: S3Client; bucket: string; publicBaseUrl?: string };
  reconcileQueue?: Queue;
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
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
        // Cập nhật post thành FAILED để người dùng biết
        await markFailed(input.prisma, payload.platformPostId, errorCode, decision.reason);
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
    adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
    locks: JobLockService;
    storage: { client: S3Client; bucket: string; publicBaseUrl?: string };
    reconcileQueue?: Queue;
  },
  payload: z.infer<typeof publishPostPayloadSchema>,
  job: { id?: string; attemptsMade?: number; opts?: { attempts?: number } },
) {
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

  if (!platformPost) {
    logger.warn({ jobId: job.id, payload }, 'Không tìm thấy PlatformPost để publish');
    return { published: false, reason: 'not_found' };
  }

  if (platformPost.externalPostId || platformPost.status === 'PUBLISHED') {
    return { published: false, reason: 'already_published' };
  }

  if (!platformPost.socialAccount.token || platformPost.socialAccount.status !== 'CONNECTED') {
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

  const adaptersContext = await input.adapterFactory.forWorkspace(payload.workspaceId);
  try {
    const adapters = adaptersContext.adapters;
    const adapter = adapters.get(platformPost.platform);
    if (
      platformPost.socialAccount.scopes.includes('development-fixture') &&
      !(adapter instanceof DevelopmentFixtureAdapter)
    ) {
      const message =
        'Social account này được tạo bằng development fixture. Hãy disconnect và kết nối lại bằng OAuth thật trước khi publish.';
      await markFailed(input.prisma, platformPost.id, 'ACCOUNT_RECONNECT_REQUIRED', message);
      await input.prisma.socialAccount.update({
        where: { id: platformPost.socialAccountId },
        data: { status: 'DISCONNECTED', lastErrorAt: new Date(), lastErrorMessage: message },
      });
      await updateParentStatus(input.prisma, platformPost.contentPostId);
      return { published: false, reason: 'fixture_account_with_real_adapter' };
    }

    const publishNetworkProof = adaptersContext.proxy?.attestation || null;

    try {
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
      const sourceMedia =
        platformPost.media.length > 0 ? platformPost.media : platformPost.contentPost.media;
      const options = jsonObject(platformPost.options);
      const media = await Promise.all(
        sourceMedia
          .filter((item) => item.mediaAsset.status === 'READY')
          .map((item) => mediaInputFromAsset(input.storage, item.mediaAsset)),
      );
      const thumbnail = await thumbnailInputFromOptions({
        storage: input.storage,
        prisma: input.prisma,
        workspaceId: payload.workspaceId,
        platform: platformPost.platform,
        options,
        sourceMedia,
      });
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
        await markFailed(
          input.prisma,
          platformPost.id,
          'VALIDATION',
          validation.issues
            .map((issue: { field: string; message: string }) => `${issue.field}: ${issue.message}`)
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
      } satisfies AdapterContext;

      // (Proxy validity is already attested by ProxyRuntimeService)

      const publishAttemptId = randomUUID();
      await input.prisma.platformPost.update({
        where: { id: platformPost.id },
        data: {
          publishAttemptId,
          publishAttemptStartedAt: new Date(),
          publishFence: { increment: 1 },
        },
      });

      const result = await adapter.publishPost(adapterContext, publishInput);
      const platformState = await platformStateAfterPublish(
        adapter,
        adapterContext,
        result.externalPostId,
      );
      const platformStateWithNetwork = mergePlatformStateWithNetworkProof(
        platformState,
        publishNetworkProof,
      );

      await input.prisma.$transaction([
        input.prisma.platformPost.update({
          where: { id: platformPost.id },
          data: {
            status: 'PUBLISHED',
            externalPostId: result.externalPostId,
            externalUrl: result.externalUrl,
            publishedAt: result.publishedAt,
            errorCode: null,
            errorMessage: null,
            platformState: platformStateWithNetwork as Prisma.InputJsonValue,
          },
        }),
        input.prisma.auditLog.create({
          data: {
            workspaceId: payload.workspaceId,
            actorUserId: platformPost.contentPost.createdById,
            action: 'POST_PUBLISHED',
            resourceType: 'PlatformPost',
            resourceId: platformPost.id,
            metadata: {
              platform: platformPost.platform,
              externalPostId: result.externalPostId,
              jobId: job.id,
              publishNetwork: publishNetworkProof,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        input.prisma.notification.create({
          data: {
            workspaceId: payload.workspaceId,
            userId: platformPost.contentPost.createdById,
            type: 'POST_PUBLISHED',
            title: 'Bài đăng đã publish',
            body: `${PLATFORM_LABELS[platformPost.platform]} · ${platformPost.socialAccount.name} đã publish thành công.`,
            linkUrl: `/posts/${platformPost.contentPostId}`,
            data: {
              platformPostId: platformPost.id,
              platform: platformPost.platform,
              accountName: platformPost.socialAccount.name,
              socialAccountId: platformPost.socialAccountId,
              externalPostId: result.externalPostId,
              postTitle: platformPost.contentPost.title,
            },
          },
        }),
      ]);

      await updateParentStatus(input.prisma, platformPost.contentPostId);
      return { published: true, externalPostId: result.externalPostId };
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      const decision = decideOnError(error, attempt, maxAttempts);
      const code = isPlatformError(error) ? error.kind : 'UNKNOWN';
      const message = error instanceof Error ? error.message : 'Lỗi không xác định khi publish.';

      const isRemoteUnknown =
        (error instanceof RemoteRequestError && error.requestMayHaveReachedRemote) ||
        (isPlatformError(error) && error.kind === 'NETWORK');

      const targetStatus: PlatformPostStatus = isRemoteUnknown
        ? 'REMOTE_RESULT_UNKNOWN'
        : decision.action === 'RETRY'
          ? 'QUEUED'
          : 'FAILED';

      const targetCode = isRemoteUnknown ? 'REMOTE_RESULT_UNKNOWN' : code;

      await input.prisma.platformPost.update({
        where: { id: platformPost.id },
        data: {
          status: targetStatus,
          errorCode: targetCode,
          errorMessage: message,
          platformState: publishNetworkProof
            ? (mergePlatformStateWithNetworkProof(
                jsonObject(platformPost.platformState),
                publishNetworkProof,
              ) as Prisma.InputJsonValue)
            : undefined,
        },
      });

      if (isRemoteUnknown && input.reconcileQueue) {
        const reconcileJobId = `reconcile-${platformPost.id}-${job.id ?? 'attempt'}`;
        await input.reconcileQueue.add(
          'reconcile-platform-post',
          {
            platformPostId: platformPost.id,
            workspaceId: payload.workspaceId,
            publishAttemptId: job.id ?? 'attempt',
          },
          {
            jobId: reconcileJobId,
            delay: 60_000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 60_000 },
          },
        );
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

      if (decision.action === 'RETRY') throw error;
      return { published: false, reason: decision.reason };
    }
  } finally {
    await adaptersContext.release();
  }
}

function jsonObject(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// capturePublishNetworkProof removed to avoid double checking

function mergePlatformStateWithNetworkProof(
  platformState:
    TikTokPublishPlatformState | YouTubeVideoPlatformState | Record<string, unknown> | undefined,
  publishNetwork: ProxyAttestation | null,
): Record<string, unknown> {
  return {
    ...(platformState ?? {}),
    publishNetwork,
  };
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

async function mediaInputFromAsset(
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
): Promise<MediaInput> {
  return {
    type: mediaAsset.type as MediaType,
    url: publicMediaUrl(storage.publicBaseUrl, storage.bucket, mediaAsset.storageKey),
    bytes: await readObjectBytes(storage.client, storage.bucket, mediaAsset.storageKey),
    mimeType: mediaAsset.mimeType ?? 'application/octet-stream',
    sizeBytes: mediaAsset.sizeBytes ?? 0,
    width: mediaAsset.width ?? undefined,
    height: mediaAsset.height ?? undefined,
    durationSec: mediaAsset.durationSec ?? undefined,
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
  return !['already_published', 'locked', 'not_found'].includes(reason);
}

async function markFailed(
  prisma: PrismaClientInstance,
  platformPostId: string,
  code: string,
  message: string,
): Promise<void> {
  await prisma.platformPost.update({
    where: { id: platformPostId },
    data: { status: 'FAILED', errorCode: code, errorMessage: message },
  });
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
