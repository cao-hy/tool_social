import { AdapterRegistry, isPlatformError } from '@socialhub/platform-adapters';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPrismaClient, type PrismaClientInstance } from '@socialhub/db';
import { decryptToken, type Keyring } from '@socialhub/security';
import {
  deriveContentPostStatus,
  type MediaType,
  type PlatformPostStatus,
} from '@socialhub/shared';
import { z } from 'zod';
import { logger } from '../logger';
import { decideOnError } from '../queue/error-policy';
import { JobLockService } from '../queue/job-lock';

const publishPostPayloadSchema = z.object({
  platformPostId: z.string().min(1),
  workspaceId: z.string().min(1),
  correlationId: z.string().min(1),
});

export function createPublishPostProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapters: AdapterRegistry;
  locks: JobLockService;
  storage: { client: S3Client; bucket: string };
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
        async () => publishPlatformPost(input, payload, job),
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
      await markBackgroundJobFinished(input.prisma, jobName, jobId, startedAt, {
        status: attempt >= maxAttempts ? 'DEAD' : 'FAILED',
        payload,
        errorCode: isPlatformError(error) ? error.kind : 'UNKNOWN',
        errorMessage: error instanceof Error ? error.message : 'Lỗi không xác định khi publish.',
        isDead: attempt >= maxAttempts,
      });
      throw error;
    }
  };
}

async function publishPlatformPost(
  input: {
    prisma: PrismaClientInstance;
    keyring: Keyring;
    adapters: AdapterRegistry;
    storage: { client: S3Client; bucket: string };
  },
  payload: z.infer<typeof publishPostPayloadSchema>,
  job: { id?: string; attemptsMade?: number; opts?: { attempts?: number } },
) {
  const platformPost = await input.prisma.platformPost.findFirst({
    where: { id: payload.platformPostId, workspaceId: payload.workspaceId },
    include: {
      socialAccount: { include: { token: true } },
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

  const adapter = input.adapters.get(platformPost.platform);
  const accessToken = decryptToken(platformPost.socialAccount.token.accessToken, input.keyring);

  try {
    const media = await Promise.all(
      platformPost.contentPost.media
        .filter((item) => item.mediaAsset.status === 'READY')
        .map(async (item) => ({
          type: item.mediaAsset.type as MediaType,
          url: item.mediaAsset.storageKey,
          bytes: await readObjectBytes(
            input.storage.client,
            input.storage.bucket,
            item.mediaAsset.storageKey,
          ),
          mimeType: item.mediaAsset.mimeType ?? 'application/octet-stream',
          sizeBytes: item.mediaAsset.sizeBytes ?? 0,
          width: item.mediaAsset.width ?? undefined,
          height: item.mediaAsset.height ?? undefined,
          durationSec: item.mediaAsset.durationSec ?? undefined,
        })),
    );

    const publishInput = {
      caption: platformPost.caption ?? platformPost.contentPost.body ?? undefined,
      title: platformPost.title ?? platformPost.contentPost.title ?? undefined,
      description: platformPost.description ?? platformPost.contentPost.body ?? undefined,
      linkUrl: platformPost.contentPost.linkUrl ?? undefined,
      hashtags: platformPost.contentPost.hashtags,
      media,
    };

    const validation = adapter.validatePost(publishInput);
    if (!validation.valid) {
      await markFailed(
        input.prisma,
        platformPost.id,
        'VALIDATION',
        validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '),
      );
      await updateParentStatus(input.prisma, platformPost.contentPostId);
      return { published: false, reason: 'validation' };
    }

    const result = await adapter.publishPost(
      {
        accessToken,
        externalAccountId: platformPost.socialAccount.externalAccountId,
        externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
        correlationId: payload.correlationId,
      },
      publishInput,
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
          },
        },
      }),
      input.prisma.notification.create({
        data: {
          workspaceId: payload.workspaceId,
          userId: platformPost.contentPost.createdById,
          type: 'POST_PUBLISHED',
          title: 'Bài đăng đã publish',
          body: `${platformPost.socialAccount.name} đã publish thành công.`,
          linkUrl: `/posts/${platformPost.contentPostId}`,
          data: { platformPostId: platformPost.id, platform: platformPost.platform },
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

    await input.prisma.platformPost.update({
      where: { id: platformPost.id },
      data: {
        status: decision.action === 'RETRY' ? 'QUEUED' : 'FAILED',
        errorCode: code,
        errorMessage: message,
      },
    });

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
          body: message,
          linkUrl: `/posts/${platformPost.contentPostId}`,
          data: { platformPostId: platformPost.id, platform: platformPost.platform, code },
        },
      });
    }

    await updateParentStatus(input.prisma, platformPost.contentPostId);

    if (decision.action === 'RETRY') throw error;
    return { published: false, reason: decision.reason };
  }
}

async function readObjectBytes(client: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return new Uint8Array((await object.Body?.transformToByteArray()) ?? []);
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
