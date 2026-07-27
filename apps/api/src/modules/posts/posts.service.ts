import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { deriveContentPostStatus, buildJobId } from '@socialhub/shared';
import type { Platform, PlatformPostStatus } from '@socialhub/shared';
import { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type {
  CreatePostInput,
  ListPostsQuery,
  PublishPostInputDto,
  SchedulePostInput,
  UpdatePostInput,
} from './posts.schemas';

@Injectable()
export class PostsService implements OnModuleDestroy {
  private readonly publishQueue: Queue;
  private readonly s3: S3Client;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.publishQueue = new Queue('publish-post', {
      connection: this.redis.getClient(),
    });
    this.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.publishQueue.close();
  }

  async list(workspaceId: string, query: ListPostsQuery) {
    const posts = await this.prisma.contentPost.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: query.status,
        platformPosts: query.platform ? { some: { platform: query.platform } } : undefined,
      },
      include: {
        platformPosts: { include: { socialAccount: true }, orderBy: { createdAt: 'asc' } },
        media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return { items: await Promise.all(posts.map((post) => this.toPostView(post))) };
  }

  async get(workspaceId: string, postId: string) {
    const post = await this.findPost(workspaceId, postId);
    return this.toPostView(post);
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: CreatePostInput,
    auditContext: AuditContext,
  ) {
    const status = input.scheduledAt ? 'SCHEDULED' : 'DRAFT';
    if (input.scheduledAt && input.scheduledAt <= new Date()) {
      throw AppError.validation('Thời gian lên lịch phải nằm trong tương lai.');
    }
    const post = await this.prisma.$transaction(async (tx) => {
      const created = await tx.contentPost.create({
        data: {
          workspaceId,
          createdById: actorUserId,
          status,
          title: input.title,
          body: input.body,
          linkUrl: input.linkUrl,
          hashtags: input.hashtags,
          scheduledAt: input.scheduledAt,
        },
      });

      await this.replaceTargets(tx, workspaceId, created.id, input.socialAccountIds);
      await this.replaceMedia(tx, workspaceId, created.id, input.mediaAssetIds);

      if (input.scheduledAt) {
        await tx.postSchedule.create({
          data: {
            contentPostId: created.id,
            scheduledAt: input.scheduledAt,
            timezone: await this.workspaceTimezone(workspaceId),
          },
        });
      }

      return created;
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_CREATED',
      resourceType: 'ContentPost',
      resourceId: post.id,
    });

    if (input.scheduledAt) {
      await this.enqueuePost(post.id, workspaceId, auditContext.requestId, input.scheduledAt);
    }

    return this.get(workspaceId, post.id);
  }

  async update(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    input: UpdatePostInput,
    auditContext: AuditContext,
  ) {
    const existing = await this.findPost(workspaceId, postId);
    if (!['DRAFT', 'SCHEDULED', 'FAILED'].includes(existing.status)) {
      throw AppError.conflict('Chỉ sửa được draft, bài đã lên lịch hoặc bài thất bại.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.contentPost.update({
        where: { id: postId },
        data: {
          title: input.title,
          body: input.body,
          linkUrl: input.linkUrl,
          hashtags: input.hashtags,
        },
      });

      if (input.socialAccountIds) {
        await this.replaceTargets(tx, workspaceId, postId, input.socialAccountIds);
      }
      if (input.mediaAssetIds) {
        await this.replaceMedia(tx, workspaceId, postId, input.mediaAssetIds);
      }
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'ContentPost',
      resourceId: postId,
    });

    return this.get(workspaceId, postId);
  }

  async deletePost(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const post = await this.findPost(workspaceId, postId);
    if (!['DRAFT', 'FAILED', 'SCHEDULED'].includes(post.status)) {
      throw AppError.conflict('Chỉ xóa được draft, bài đã lên lịch hoặc bài thất bại.');
    }

    await this.removeScheduledJobs(post.id, workspaceId, auditContext.requestId);

    await this.prisma.$transaction([
      this.prisma.platformPost.updateMany({
        where: {
          contentPostId: postId,
          status: { in: ['PENDING', 'QUEUED', 'FAILED', 'CANCELLED'] },
        },
        data: { status: 'CANCELLED' },
      }),
      this.prisma.postSchedule.updateMany({
        where: { contentPostId: postId },
        data: { cancelledAt: new Date() },
      }),
      this.prisma.contentPost.update({
        where: { id: postId },
        data: { status: 'CANCELLED', deletedAt: new Date() },
      }),
    ]);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_DELETED',
      resourceType: 'ContentPost',
      resourceId: postId,
      metadata: { previousStatus: post.status },
    });

    return { deleted: true };
  }

  async publishNow(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    input: PublishPostInputDto,
    auditContext: AuditContext,
  ) {
    const queued = await this.prepareForPublishing(workspaceId, postId, input.socialAccountIds);
    await this.enqueuePlatformPosts(queued.id, workspaceId, auditContext.requestId);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'ContentPost',
      resourceId: postId,
      metadata: { action: 'publish_now' },
    });

    return this.get(workspaceId, postId);
  }

  async schedule(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    input: SchedulePostInput,
    auditContext: AuditContext,
  ) {
    if (input.scheduledAt <= new Date()) {
      throw AppError.validation('Thời gian lên lịch phải nằm trong tương lai.');
    }

    const scheduled = await this.prisma.$transaction(async (tx) => {
      const post = await tx.contentPost.findFirst({
        where: { id: postId, workspaceId, deletedAt: null },
        include: { platformPosts: true },
      });
      if (!post) throw AppError.notFound('post');
      if (!['DRAFT', 'SCHEDULED', 'FAILED'].includes(post.status)) {
        throw AppError.conflict('Chỉ lên lịch được draft hoặc bài thất bại.');
      }

      if (input.socialAccountIds) {
        await this.replaceTargets(tx, workspaceId, postId, input.socialAccountIds);
      }

      const targetCount = input.socialAccountIds?.length ?? post.platformPosts.length;
      if (targetCount === 0) throw AppError.validation('Cần chọn ít nhất một social account.');

      await tx.contentPost.update({
        where: { id: postId },
        data: { status: 'SCHEDULED', scheduledAt: input.scheduledAt },
      });

      await tx.postSchedule.upsert({
        where: { contentPostId: postId },
        create: {
          contentPostId: postId,
          scheduledAt: input.scheduledAt,
          timezone: await this.workspaceTimezone(workspaceId),
        },
        update: {
          scheduledAt: input.scheduledAt,
          cancelledAt: null,
          enqueuedAt: null,
        },
      });

      return { id: postId };
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_SCHEDULED',
      resourceType: 'ContentPost',
      resourceId: postId,
      metadata: { scheduledAt: input.scheduledAt.toISOString() },
    });

    await this.enqueuePost(scheduled.id, workspaceId, auditContext.requestId, input.scheduledAt);
    return this.get(workspaceId, postId);
  }

  async retry(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const post = await this.findPost(workspaceId, postId);
    const failed = post.platformPosts.filter((item) => item.status === 'FAILED');
    if (failed.length === 0) throw AppError.validation('Không có platform post thất bại để retry.');

    await this.prisma.$transaction([
      this.prisma.contentPost.update({
        where: { id: postId },
        data: { status: 'QUEUED' },
      }),
      this.prisma.platformPost.updateMany({
        where: { id: { in: failed.map((item) => item.id) } },
        data: { status: 'QUEUED', errorCode: null, errorMessage: null },
      }),
    ]);

    await Promise.all(
      failed.map((item) =>
        this.enqueuePlatformPost(item.id, workspaceId, auditContext.requestId, true),
      ),
    );

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'ContentPost',
      resourceId: postId,
      metadata: { action: 'retry_failed_platform_posts' },
    });

    return this.get(workspaceId, postId);
  }

  async duplicate(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const post = await this.findPost(workspaceId, postId);
    const created = await this.prisma.$transaction(async (tx) => {
      const copy = await tx.contentPost.create({
        data: {
          workspaceId,
          createdById: actorUserId,
          status: 'DRAFT',
          title: post.title ? `${post.title} (copy)` : null,
          body: post.body,
          linkUrl: post.linkUrl,
          hashtags: post.hashtags,
        },
      });

      await this.replaceTargets(
        tx,
        workspaceId,
        copy.id,
        post.platformPosts.map((item) => item.socialAccountId),
      );
      await this.replaceMedia(
        tx,
        workspaceId,
        copy.id,
        post.media.map((item) => item.mediaAssetId),
      );
      return copy;
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_CREATED',
      resourceType: 'ContentPost',
      resourceId: created.id,
      metadata: { duplicatedFrom: postId },
    });

    return this.get(workspaceId, created.id);
  }

  private async prepareForPublishing(
    workspaceId: string,
    postId: string,
    socialAccountIds: string[] | undefined,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const post = await tx.contentPost.findFirst({
        where: { id: postId, workspaceId, deletedAt: null },
        include: { platformPosts: true },
      });
      if (!post) throw AppError.notFound('post');
      if (!['DRAFT', 'SCHEDULED', 'FAILED', 'PARTIALLY_PUBLISHED'].includes(post.status)) {
        throw AppError.conflict('Bài này không ở trạng thái có thể publish.');
      }

      if (socialAccountIds) {
        await this.replaceTargets(tx, workspaceId, postId, socialAccountIds);
      }

      const targets =
        socialAccountIds ??
        post.platformPosts
          .filter((item) => item.status !== 'PUBLISHED')
          .map((item) => item.socialAccountId);
      if (targets.length === 0) throw AppError.validation('Cần chọn ít nhất một social account.');

      await tx.contentPost.update({
        where: { id: postId },
        data: { status: 'QUEUED', scheduledAt: null },
      });
      await tx.postSchedule.deleteMany({ where: { contentPostId: postId } });
      await tx.platformPost.updateMany({
        where: {
          contentPostId: postId,
          socialAccountId: { in: targets },
          status: { not: 'PUBLISHED' },
        },
        data: { status: 'QUEUED', errorCode: null, errorMessage: null },
      });

      return { id: postId };
    });
  }

  private async enqueuePost(
    contentPostId: string,
    workspaceId: string,
    correlationId = 'manual',
    runAt?: Date,
  ): Promise<void> {
    const post = await this.prisma.contentPost.findFirst({
      where: { id: contentPostId, workspaceId, deletedAt: null },
      include: { platformPosts: true },
    });
    if (!post) throw AppError.notFound('post');

    if (runAt) {
      const delay = Math.max(0, runAt.getTime() - Date.now());
      for (const platformPost of post.platformPosts) {
        const payload = { platformPostId: platformPost.id, workspaceId, correlationId };
        await this.publishQueue.add('publish-post', payload, {
          jobId: buildJobId('publish-post', payload),
          delay,
        });
      }
      await this.prisma.postSchedule.updateMany({
        where: { contentPostId },
        data: { enqueuedAt: new Date() },
      });
      return;
    }

    await this.enqueuePlatformPosts(contentPostId, workspaceId, correlationId);
  }

  private async enqueuePlatformPosts(
    contentPostId: string,
    workspaceId: string,
    correlationId = 'manual',
  ): Promise<void> {
    const platformPosts = await this.prisma.platformPost.findMany({
      where: { contentPostId, workspaceId, status: 'QUEUED' },
    });
    await Promise.all(
      platformPosts.map((item) =>
        this.enqueuePlatformPost(item.id, workspaceId, correlationId, false),
      ),
    );
  }

  private async enqueuePlatformPost(
    platformPostId: string,
    workspaceId: string,
    correlationId = 'manual',
    retry: boolean,
  ): Promise<void> {
    const payload = { platformPostId, workspaceId, correlationId };
    await this.publishQueue.add(retry ? 'retry-failed-post' : 'publish-post', payload, {
      jobId: buildJobId('publish-post', payload),
    });
  }

  private async removeScheduledJobs(
    contentPostId: string,
    workspaceId: string,
    correlationId = 'manual',
  ): Promise<void> {
    const platformPosts = await this.prisma.platformPost.findMany({
      where: { contentPostId, workspaceId },
      select: { id: true },
    });

    await Promise.all(
      platformPosts.map(async (platformPost) => {
        const payload = {
          platformPostId: platformPost.id,
          workspaceId,
          correlationId,
        };
        const job = await this.publishQueue.getJob(buildJobId('publish-post', payload));
        if (job) await job.remove();
      }),
    );
  }

  private async replaceTargets(
    tx: Pick<PrismaService, 'socialAccount' | 'platformPost'>,
    workspaceId: string,
    contentPostId: string,
    socialAccountIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(socialAccountIds)];
    const accounts = await tx.socialAccount.findMany({
      where: { id: { in: uniqueIds }, workspaceId, deletedAt: null, status: 'CONNECTED' },
    });
    if (accounts.length !== uniqueIds.length) {
      throw AppError.validation('Một hoặc nhiều social account không hợp lệ hoặc chưa kết nối.');
    }

    await tx.platformPost.deleteMany({
      where: { contentPostId, status: { in: ['PENDING', 'QUEUED', 'FAILED', 'CANCELLED'] } },
    });

    if (accounts.length > 0) {
      await tx.platformPost.createMany({
        data: accounts.map((account) => ({
          workspaceId,
          contentPostId,
          socialAccountId: account.id,
          platform: account.platform,
          status: 'PENDING',
        })),
      });
    }
  }

  private async replaceMedia(
    tx: Pick<PrismaService, 'mediaAsset' | 'contentPostMedia'>,
    workspaceId: string,
    contentPostId: string,
    mediaAssetIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(mediaAssetIds)];
    const mediaAssets = await tx.mediaAsset.findMany({
      where: { id: { in: uniqueIds }, workspaceId, deletedAt: null, status: 'READY' },
    });
    if (mediaAssets.length !== uniqueIds.length) {
      throw AppError.validation('Một hoặc nhiều media asset chưa sẵn sàng hoặc không hợp lệ.');
    }

    await tx.contentPostMedia.deleteMany({ where: { contentPostId } });
    if (uniqueIds.length > 0) {
      await tx.contentPostMedia.createMany({
        data: uniqueIds.map((mediaAssetId, position) => ({
          contentPostId,
          mediaAssetId,
          position,
        })),
      });
    }
  }

  private async workspaceTimezone(workspaceId: string): Promise<string> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    return workspace?.timezone ?? 'UTC';
  }

  private async findPost(workspaceId: string, postId: string) {
    const post = await this.prisma.contentPost.findFirst({
      where: { id: postId, workspaceId, deletedAt: null },
      include: {
        platformPosts: { include: { socialAccount: true }, orderBy: { createdAt: 'asc' } },
        media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
      },
    });
    if (!post) throw AppError.notFound('post');
    return post;
  }

  private async toPostView(post: Awaited<ReturnType<typeof this.findPost>>) {
    const platformStatuses = post.platformPosts.map((item) => item.status as PlatformPostStatus);
    return {
      id: post.id,
      status: post.status,
      title: post.title,
      body: post.body,
      linkUrl: post.linkUrl,
      hashtags: post.hashtags,
      scheduledAt: post.scheduledAt,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      derivedStatus: deriveContentPostStatus(platformStatuses),
      platformPosts: post.platformPosts.map((item) => ({
        id: item.id,
        platform: item.platform as Platform,
        status: item.status,
        socialAccountId: item.socialAccountId,
        socialAccountName: item.socialAccount.name,
        externalPostId: item.externalPostId,
        externalUrl: item.externalUrl,
        publishedAt: item.publishedAt,
        attemptCount: item.attemptCount,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
      })),
      media: await Promise.all(
        post.media.map(async (item) => ({
          id: item.mediaAsset.id,
          type: item.mediaAsset.type,
          status: item.mediaAsset.status,
          originalFileName: item.mediaAsset.originalFileName,
          mimeType: item.mediaAsset.mimeType,
          sizeBytes: item.mediaAsset.sizeBytes,
          width: item.mediaAsset.width,
          height: item.mediaAsset.height,
          durationSec: item.mediaAsset.durationSec,
          position: item.position,
          readUrl:
            item.mediaAsset.status === 'READY'
              ? await getSignedUrl(
                  this.s3,
                  new GetObjectCommand({
                    Bucket: this.env.S3_BUCKET,
                    Key: item.mediaAsset.storageKey,
                  }),
                  { expiresIn: 10 * 60 },
                )
              : null,
        })),
      ),
      links: {
        web: `${this.env.WEB_BASE_URL.replace(/\/$/, '')}/posts/${post.id}`,
      },
    };
  }
}
