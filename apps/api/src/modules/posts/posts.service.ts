import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Prisma } from '@socialhub/db';
import {
  type AdapterContext,
  type AdapterRegistry,
  type SocialPlatformAdapter,
  type YouTubeVideoPlatformState,
} from '@socialhub/platform-adapters';
import { decryptToken, type Keyring } from '@socialhub/security';
import { deriveContentPostStatus, buildJobId } from '@socialhub/shared';
import type { Platform, PlatformPostStatus } from '@socialhub/shared';
import { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error';
import { ADAPTER_REGISTRY, KEYRING } from '../../infrastructure/infrastructure.module';
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
  private readonly publicS3: S3Client;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(ADAPTER_REGISTRY) private readonly adapters: AdapterRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.publishQueue = new Queue('publish-post', {
      connection: this.redis.getClient(),
    });
    this.publicS3 = new S3Client({
      endpoint: env.S3_PUBLIC_BASE_URL ?? env.S3_ENDPOINT,
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
    const platformPostWhere =
      query.platform || query.socialAccountId
        ? {
            platform: query.platform,
            socialAccountId: query.socialAccountId,
          }
        : undefined;
    const cursor = query.cursor ? decodePostCursor(query.cursor) : null;
    const where: Prisma.ContentPostWhereInput = {
      workspaceId,
      deletedAt: null,
      status: query.status,
      platformPosts: platformPostWhere ? { some: platformPostWhere } : undefined,
      createdAt:
        query.dateFrom || query.dateTo ? { gte: query.dateFrom, lte: query.dateTo } : undefined,
      OR: query.q
        ? [
            { title: { contains: query.q, mode: 'insensitive' } },
            { body: { contains: query.q, mode: 'insensitive' } },
            { linkUrl: { contains: query.q, mode: 'insensitive' } },
          ]
        : undefined,
      AND: cursor ? [buildCursorWhere(cursor, query.sortBy, query.direction)] : undefined,
    };

    const posts = await this.prisma.contentPost.findMany({
      where,
      include: {
        platformPosts: {
          include: {
            socialAccount: true,
            media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
          },
          orderBy: { createdAt: 'asc' },
        },
        media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
      },
      orderBy: [{ [query.sortBy]: query.direction }, { id: query.direction }],
      take: query.limit + 1,
    });

    const page = posts.slice(0, query.limit);
    const last = page.at(-1);
    const hasMore = posts.length > query.limit;

    return {
      items: await Promise.all(page.map((post) => this.toPostView(post))),
      nextCursor:
        hasMore && last
          ? encodePostCursor({
              sortBy: query.sortBy,
              direction: query.direction,
              id: last.id,
              value: last[query.sortBy].toISOString(),
            })
          : null,
    };
  }

  async get(workspaceId: string, postId: string) {
    const post = await this.findPost(workspaceId, postId);
    return this.toPostView(post, await this.jobHistory(workspaceId, post.platformPosts));
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

      await this.replaceTargets(
        tx,
        workspaceId,
        created.id,
        input.socialAccountIds,
        input.platformOverrides,
      );
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
        await this.replaceTargets(
          tx,
          workspaceId,
          postId,
          input.socialAccountIds,
          input.platformOverrides ?? [],
        );
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
        post.platformPosts.map((item) => ({
          socialAccountId: item.socialAccountId,
          caption: item.caption ?? undefined,
          title: item.title ?? undefined,
          description: item.description ?? undefined,
          linkUrl: item.linkUrl ?? undefined,
          options: item.options as Record<string, unknown> | undefined,
          mediaAssetIds: item.media.map((media) => media.mediaAssetId),
        })),
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

  async refreshPlatformPostState(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const state = await this.fetchYouTubePlatformState(workspaceId, postId, platformPostId);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'PlatformPost',
      resourceId: platformPostId,
      metadata: { action: 'refresh_platform_state', platform: 'YOUTUBE' },
    });

    return {
      post: await this.get(workspaceId, postId),
      platformState: state,
    };
  }

  async makeYouTubePublic(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const { platformPost, adapter, ctx } = await this.youtubePlatformPostContext(
      workspaceId,
      postId,
      platformPostId,
    );

    const current = await adapter.getVideoPlatformState(ctx, platformPost.externalPostId);
    assertYouTubeReadyForPublic(current);

    const state = await adapter.makeVideoPublic(ctx, platformPost.externalPostId);
    await this.prisma.platformPost.update({
      where: { id: platformPost.id },
      data: {
        platformState: state as unknown as Prisma.InputJsonValue,
        errorCode: null,
        errorMessage: null,
      },
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'PlatformPost',
      resourceId: platformPostId,
      metadata: { action: 'youtube_make_public', platformState: state },
    });

    return {
      post: await this.get(workspaceId, postId),
      platformState: state,
    };
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
    tx: Prisma.TransactionClient,
    workspaceId: string,
    contentPostId: string,
    socialAccountIds: string[],
    platformOverrides:
      CreatePostInput['platformOverrides'] | NonNullable<UpdatePostInput['platformOverrides']> = [],
  ): Promise<void> {
    const uniqueIds = [...new Set(socialAccountIds)];
    const overrideByAccountId = new Map(
      platformOverrides.map((override) => [override.socialAccountId, override]),
    );
    for (const override of platformOverrides) {
      if (!uniqueIds.includes(override.socialAccountId)) {
        throw AppError.validation('Platform override phải thuộc một social account đã chọn.');
      }
    }

    const accounts = await tx.socialAccount.findMany({
      where: { id: { in: uniqueIds }, workspaceId, deletedAt: null, status: 'CONNECTED' },
    });
    if (accounts.length !== uniqueIds.length) {
      throw AppError.validation('Một hoặc nhiều social account không hợp lệ hoặc chưa kết nối.');
    }

    await tx.platformPost.deleteMany({
      where: { contentPostId, status: { in: ['PENDING', 'QUEUED', 'FAILED', 'CANCELLED'] } },
    });

    for (const account of accounts) {
      const override = overrideByAccountId.get(account.id);
      const platformPost = await tx.platformPost.create({
        data: {
          workspaceId,
          contentPostId,
          socialAccountId: account.id,
          platform: account.platform,
          status: 'PENDING',
          caption: override?.caption,
          title: override?.title,
          description: override?.description,
          linkUrl: override?.linkUrl,
          options: override?.options as Prisma.InputJsonValue | undefined,
        },
      });

      if (override?.mediaAssetIds && override.mediaAssetIds.length > 0) {
        const mediaAssetIds = await this.validateMediaAssetIds(
          tx,
          workspaceId,
          override.mediaAssetIds,
        );
        await tx.platformPostMedia.createMany({
          data: mediaAssetIds.map((mediaAssetId, position) => ({
            platformPostId: platformPost.id,
            mediaAssetId,
            position,
          })),
        });
      }
    }
  }

  private async replaceMedia(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    contentPostId: string,
    mediaAssetIds: string[],
  ): Promise<void> {
    const uniqueIds = await this.validateMediaAssetIds(tx, workspaceId, mediaAssetIds);

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

  private async validateMediaAssetIds(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    mediaAssetIds: string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(mediaAssetIds)];
    const mediaAssets = await tx.mediaAsset.findMany({
      where: { id: { in: uniqueIds }, workspaceId, deletedAt: null, status: 'READY' },
    });
    if (mediaAssets.length !== uniqueIds.length) {
      throw AppError.validation('Một hoặc nhiều media asset chưa sẵn sàng hoặc không hợp lệ.');
    }
    return uniqueIds;
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
        platformPosts: {
          include: {
            socialAccount: true,
            media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
          },
          orderBy: { createdAt: 'asc' },
        },
        media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
      },
    });
    if (!post) throw AppError.notFound('post');
    return post;
  }

  private async jobHistory(
    workspaceId: string,
    platformPosts: Array<{ id: string }>,
  ): Promise<
    Array<{
      id: string;
      queueName: string;
      jobId: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      startedAt: Date | null;
      finishedAt: Date | null;
      durationMs: number | null;
      errorCode: string | null;
      errorMessage: string | null;
      isDead: boolean;
      correlationId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    if (platformPosts.length === 0) return [];

    const jobIds = platformPosts.map((platformPost) =>
      buildJobId('publish-post', {
        platformPostId: platformPost.id,
        workspaceId,
        correlationId: 'lookup',
      }),
    );

    return this.prisma.backgroundJob.findMany({
      where: {
        workspaceId,
        queueName: { in: ['publish-post', 'retry-failed-post'] },
        jobId: { in: jobIds },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private async toPostView(
    post: Awaited<ReturnType<typeof this.findPost>>,
    jobs: Awaited<ReturnType<typeof this.jobHistory>> = [],
  ) {
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
      platformPosts: await Promise.all(
        post.platformPosts.map(async (item) => ({
          id: item.id,
          platform: item.platform as Platform,
          status: item.status,
          socialAccountId: item.socialAccountId,
          socialAccountName: item.socialAccount.name,
          caption: item.caption,
          title: item.title,
          description: item.description,
          linkUrl: item.linkUrl,
          options: item.options,
          media: await Promise.all(
            item.media.map((media) => this.toMediaAssetView(media.mediaAsset, media.position)),
          ),
          externalPostId: item.externalPostId,
          externalUrl: item.externalUrl,
          publishedAt: item.publishedAt,
          attemptCount: item.attemptCount,
          errorCode: item.errorCode,
          errorMessage: item.errorMessage,
          platformState: item.platformState,
        })),
      ),
      media: await Promise.all(
        post.media.map((item) => this.toMediaAssetView(item.mediaAsset, item.position)),
      ),
      jobs: jobs.map((job) => ({
        id: job.id,
        queueName: job.queueName,
        jobId: job.jobId,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs: job.durationMs,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        isDead: job.isDead,
        correlationId: job.correlationId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
      links: {
        web: `${this.env.WEB_BASE_URL.replace(/\/$/, '')}/posts/${post.id}`,
      },
    };
  }

  private async toMediaAssetView(
    mediaAsset: {
      id: string;
      type: unknown;
      status: string;
      originalFileName: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      width: number | null;
      height: number | null;
      durationSec: number | null;
      storageKey: string;
    },
    position?: number,
  ) {
    return {
      id: mediaAsset.id,
      type: mediaAsset.type,
      status: mediaAsset.status,
      originalFileName: mediaAsset.originalFileName,
      mimeType: mediaAsset.mimeType,
      sizeBytes: mediaAsset.sizeBytes,
      width: mediaAsset.width,
      height: mediaAsset.height,
      durationSec: mediaAsset.durationSec,
      position,
      readUrl:
        mediaAsset.status === 'READY'
          ? await getSignedUrl(
              this.publicS3,
              new GetObjectCommand({
                Bucket: this.env.S3_BUCKET,
                Key: mediaAsset.storageKey,
              }),
              { expiresIn: 10 * 60 },
            )
          : null,
    };
  }

  private async fetchYouTubePlatformState(
    workspaceId: string,
    postId: string,
    platformPostId: string,
  ): Promise<YouTubeVideoPlatformState> {
    const { platformPost, adapter, ctx } = await this.youtubePlatformPostContext(
      workspaceId,
      postId,
      platformPostId,
    );
    const state = await adapter.getVideoPlatformState(ctx, platformPost.externalPostId);
    await this.prisma.platformPost.update({
      where: { id: platformPost.id },
      data: {
        platformState: state as unknown as Prisma.InputJsonValue,
        errorCode: null,
        errorMessage: null,
      },
    });
    return state;
  }

  private async youtubePlatformPostContext(
    workspaceId: string,
    postId: string,
    platformPostId: string,
  ): Promise<{
    platformPost: {
      id: string;
      platform: Platform;
      externalPostId: string;
      socialAccount: {
        externalAccountId: string;
        externalPageId: string | null;
        status: string;
        token: { accessToken: string } | null;
      };
    };
    adapter: SocialPlatformAdapter & YouTubeStatusAdapter;
    ctx: AdapterContext;
  }> {
    const platformPost = await this.prisma.platformPost.findFirst({
      where: {
        id: platformPostId,
        workspaceId,
        contentPostId: postId,
      },
      include: { socialAccount: { include: { token: true } } },
    });
    if (!platformPost) throw AppError.notFound('platform post');
    if (platformPost.platform !== 'YOUTUBE') {
      throw AppError.capabilityUnsupported(platformPost.platform, 'youtube_video_state');
    }
    if (!platformPost.externalPostId) {
      throw AppError.conflict('YouTube video chưa có externalPostId để kiểm tra trạng thái.');
    }
    if (!platformPost.socialAccount.token || platformPost.socialAccount.status !== 'CONNECTED') {
      throw AppError.conflict('YouTube account chưa kết nối hoặc token không khả dụng.');
    }

    const adapter = this.adapters.get('YOUTUBE');
    if (!hasYouTubeStatusMethods(adapter)) {
      throw AppError.capabilityUnsupported('YOUTUBE', 'youtube_video_state');
    }

    const ctx = {
      accessToken: decryptToken(platformPost.socialAccount.token.accessToken, this.keyring),
      externalAccountId: platformPost.socialAccount.externalAccountId,
      externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
      correlationId: `youtube-state:${platformPostId}`,
    } satisfies AdapterContext;

    return {
      platformPost: {
        id: platformPost.id,
        platform: platformPost.platform as Platform,
        externalPostId: platformPost.externalPostId,
        socialAccount: platformPost.socialAccount,
      },
      adapter,
      ctx,
    };
  }
}

interface YouTubeStatusAdapter {
  getVideoPlatformState(
    ctx: AdapterContext,
    externalPostId: string,
  ): Promise<YouTubeVideoPlatformState>;
  makeVideoPublic(ctx: AdapterContext, externalPostId: string): Promise<YouTubeVideoPlatformState>;
}

function hasYouTubeStatusMethods(
  adapter: SocialPlatformAdapter,
): adapter is SocialPlatformAdapter & YouTubeStatusAdapter {
  return (
    adapter.platform === 'YOUTUBE' &&
    'getVideoPlatformState' in adapter &&
    'makeVideoPublic' in adapter
  );
}

function assertYouTubeReadyForPublic(state: YouTubeVideoPlatformState): void {
  const status = state.processingStatus?.toLowerCase();
  if (status === 'processing') {
    throw AppError.conflict('YouTube vẫn đang xử lý video. Hãy refresh trạng thái rồi thử lại.');
  }
  if (status === 'failed') {
    throw AppError.conflict(
      `YouTube xử lý video thất bại${state.processingFailureReason ? `: ${state.processingFailureReason}` : ''}.`,
    );
  }
}

interface PostCursor {
  sortBy: 'createdAt' | 'updatedAt';
  direction: 'asc' | 'desc';
  value: string;
  id: string;
}

function encodePostCursor(cursor: PostCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodePostCursor(cursor: string): PostCursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<PostCursor>;
    if (
      (decoded.sortBy === 'createdAt' || decoded.sortBy === 'updatedAt') &&
      (decoded.direction === 'asc' || decoded.direction === 'desc') &&
      typeof decoded.value === 'string' &&
      typeof decoded.id === 'string'
    ) {
      return decoded as PostCursor;
    }
  } catch {
    return null;
  }
  return null;
}

function buildCursorWhere(
  cursor: PostCursor,
  sortBy: 'createdAt' | 'updatedAt',
  direction: 'asc' | 'desc',
): Prisma.ContentPostWhereInput {
  if (cursor.sortBy !== sortBy || cursor.direction !== direction) {
    throw AppError.validation('Cursor không khớp với sort hiện tại.');
  }

  const value = new Date(cursor.value);
  if (Number.isNaN(value.getTime())) {
    throw AppError.validation('Cursor không hợp lệ.');
  }

  const comparator = direction === 'desc' ? 'lt' : 'gt';
  return {
    OR: [
      { [sortBy]: { [comparator]: value } },
      {
        [sortBy]: value,
        id: { [comparator]: cursor.id },
      },
    ],
  };
}
