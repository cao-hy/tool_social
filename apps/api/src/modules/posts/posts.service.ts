import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  canCreateNextGeneration,
  createQueueOutboxEvent,
  findOrCreateOutboundOperation,
  type Prisma,
} from '@socialhub/db';
import {
  type AdapterContext,
  type PostMetrics,
  type SocialPlatformAdapter,
  type TikTokPublishPlatformState,
  type YouTubeVideoPlatformState,
  isPlatformError,
} from '@socialhub/platform-adapters';
import { decryptToken, type Keyring } from '@socialhub/security';
import { RedisTokenRefreshLock } from '@socialhub/social-runtime';
import { deriveContentPostStatus, buildJobId, buildQueueJobOptions } from '@socialhub/shared';
import type { MediaType, Platform, PlatformPostStatus } from '@socialhub/shared';
import type { QueuePayload } from '@socialhub/shared';
import { Queue } from 'bullmq';
import { AppError, isAppError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { KEYRING } from '../../infrastructure/infrastructure.module';
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { getFreshAccessTokenViaCentralService } from '../../infrastructure/token-refresh';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { MediaService } from '../media/media.service';
import { MEDIA_SERVICE } from '../media/media.tokens';
import type {
  BulkDeletePostsInput,
  CreatePostInput,
  ListPostsQuery,
  ManualReviewResolutionInput,
  PublishPostInputDto,
  SchedulePostInput,
  UpdatePostInput,
} from './posts.schemas';

@Injectable()
export class PostsService implements OnModuleInit, OnModuleDestroy {
  private readonly publishQueue: Queue;
  private readonly retryQueue: Queue;
  private readonly publicS3: S3Client;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MEDIA_SERVICE) private readonly media: MediaService,
  ) {
    this.publishQueue = new Queue('publish-post', {
      connection: this.redis.getClient(),
    });
    this.retryQueue = new Queue('retry-failed-post', {
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

  async onModuleInit(): Promise<void> {
    this.sweepStuckJobs().catch((err) => logger.error({ err }, 'Lỗi khi sweep stuck jobs'));
  }

  private async sweepStuckJobs() {
    // 1. Tìm các bài post kẹt ở trạng thái QUEUED mà chưa được đẩy lên Redis
    // Do hệ thống có thể crash ngay sau prisma.$transaction commit nhưng trước khi gọi enqueuePost
    const stuckPlatformPosts = await this.prisma.platformPost.findMany({
      where: {
        status: 'QUEUED',
        updatedAt: {
          lt: new Date(Date.now() - 5 * 60 * 1000), // Kẹt hơn 5 phút
        },
      },
    });

    if (stuckPlatformPosts.length > 0) {
      logger.info(
        `Tìm thấy ${stuckPlatformPosts.length} platform posts kẹt ở QUEUED. Đang enqueue lại...`,
      );
      for (const post of stuckPlatformPosts) {
        await this.enqueuePlatformPost(post.id, post.workspaceId, 'sweeper');
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.publishQueue.close(), this.retryQueue.close()]);
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
    const countWhere: Prisma.ContentPostWhereInput = {
      ...where,
      status: undefined,
      AND: undefined,
    };

    const [posts, statusCounts] = await Promise.all([
      this.prisma.contentPost.findMany({
        where,
        include: {
          platformPosts: {
            include: {
              socialAccount: { include: { token: true } },
              media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
            },
            orderBy: { createdAt: 'asc' },
          },
          media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
        },
        orderBy: [{ [query.sortBy]: query.direction }, { id: query.direction }],
        take: query.limit + 1,
      }),
      this.prisma.contentPost.groupBy({
        by: ['status'],
        where: countWhere,
        _count: { _all: true },
      }),
    ]);

    const page = posts.slice(0, query.limit);
    const last = page.at(-1);
    const hasMore = posts.length > query.limit;

    return {
      items: await Promise.all(page.map((post) => this.toPostView(post))),
      statusCounts: Object.fromEntries(statusCounts.map((item) => [item.status, item._count._all])),
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

  async getPlatformPostManualReview(workspaceId: string, postId: string, platformPostId: string) {
    const platformPost = await this.prisma.platformPost.findFirst({
      where: { id: platformPostId, workspaceId, contentPostId: postId },
      select: {
        id: true,
        platform: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        reconciliationAttempts: true,
        reconciliationError: true,
        socialAccountId: true,
        socialAccount: { select: { name: true } },
      },
    });
    if (!platformPost) throw AppError.notFound('platform post');

    const operation = await this.prisma.outboundOperation.findFirst({
      where: {
        workspaceId,
        operationType: 'PUBLISH_POST',
        resourceType: 'PlatformPost',
        resourceId: platformPostId,
        state: 'MANUAL_REVIEW',
      },
      orderBy: { operationGeneration: 'desc' },
      select: {
        id: true,
        operationGeneration: true,
        state: true,
        fence: true,
        attemptId: true,
        dispatchAttempts: true,
        reconciliationAttempts: true,
        routeConfigVersion: true,
        routeProxyFingerprint: true,
        routeCountryCode: true,
        providerRequestId: true,
        remoteId: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        remoteStartedAt: true,
        lastReconciledAt: true,
        updatedAt: true,
      },
    });
    if (!operation) throw AppError.conflict('Platform post này không đang chờ manual review.');

    return {
      platformPost,
      operation,
      actions: ['CONFIRM_REMOTE_SUCCESS', 'CONFIRM_REMOTE_ABSENCE'],
    };
  }

  async resolvePlatformPostManualReview(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    actorUserId: string,
    input: ManualReviewResolutionInput,
    auditContext: AuditContext,
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const operation = await tx.outboundOperation.findFirst({
        where: {
          workspaceId,
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: platformPostId,
        },
        orderBy: { operationGeneration: 'desc' },
        select: { id: true, state: true, fence: true, remoteCheckpoint: true },
      });
      if (!operation || operation.state !== 'MANUAL_REVIEW') {
        throw AppError.conflict('Operation này không còn ở trạng thái manual review.');
      }

      const platformPost = await tx.platformPost.findFirst({
        where: { id: platformPostId, workspaceId, contentPostId: postId },
        select: {
          id: true,
          platform: true,
          platformState: true,
          socialAccountId: true,
        },
      });
      if (!platformPost) throw AppError.notFound('platform post');

      const operationUpdate =
        input.action === 'CONFIRM_REMOTE_SUCCESS'
          ? {
              state: 'LOCAL_COMMITTED' as const,
              fence: { increment: 1 },
              remoteId: input.externalPostId,
              remoteCheckpoint: {
                ...(jsonObject(operation.remoteCheckpoint) ?? {}),
                externalPostId: input.externalPostId,
                externalUrl: input.externalUrl,
                manuallyResolvedAt: now.toISOString(),
                manuallyResolvedByUserId: actorUserId,
              } as Prisma.InputJsonValue,
              requiresManualReview: false,
              remoteConfirmedAt: now,
              completedAt: now,
              lastErrorCode: null,
              lastErrorMessage: null,
            }
          : {
              state: 'CONFIRMED_ABSENT' as const,
              fence: { increment: 1 },
              requiresManualReview: false,
              lastReconciledAt: now,
              completedAt: now,
              lastErrorCode: 'CONFIRMED_ABSENT',
              lastErrorMessage: input.reason ?? 'Manual review confirmed no remote post exists.',
            };

      const updated = await tx.outboundOperation.updateMany({
        where: { id: operation.id, state: 'MANUAL_REVIEW', fence: input.fence },
        data: operationUpdate,
      });
      if (updated.count === 0) {
        throw AppError.conflict('Manual review fence đã thay đổi. Tải lại trạng thái mới nhất.');
      }

      if (input.action === 'CONFIRM_REMOTE_SUCCESS') {
        await tx.platformPost.update({
          where: { id: platformPost.id },
          data: {
            status: 'PUBLISHED',
            externalPostId: input.externalPostId,
            externalUrl: input.externalUrl,
            publishedAt: now,
            requiresManualReview: false,
            reconciliationError: null,
            errorCode: null,
            errorMessage: null,
            platformState: {
              ...(jsonObject(platformPost.platformState) ?? {}),
              manualReview: {
                action: input.action,
                resolvedAt: now.toISOString(),
                resolvedByUserId: actorUserId,
              },
            } as Prisma.InputJsonValue,
          },
        });
      } else {
        await tx.platformPost.update({
          where: { id: platformPost.id },
          data: {
            status: 'FAILED',
            requiresManualReview: false,
            reconciliationError: null,
            errorCode: 'CONFIRMED_ABSENT',
            errorMessage: input.reason ?? 'Manual review confirmed no remote post exists.',
            platformState: {
              ...(jsonObject(platformPost.platformState) ?? {}),
              manualReview: {
                action: input.action,
                resolvedAt: now.toISOString(),
                resolvedByUserId: actorUserId,
              },
            } as Prisma.InputJsonValue,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          action: 'POST_UPDATED',
          resourceType: 'PlatformPost',
          resourceId: platformPost.id,
          metadata: {
            manualReviewAction: input.action,
            operationId: operation.id,
            fence: input.fence,
            platform: platformPost.platform,
            socialAccountId: platformPost.socialAccountId,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await this.updateParentStatus(postId);
    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'PlatformPost',
      resourceId: platformPostId,
      metadata: { manualReviewAction: input.action },
    });

    return this.get(workspaceId, postId);
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
    const publishedEdit = ['PUBLISHED', 'PARTIALLY_PUBLISHED'].includes(existing.status);
    if (
      !['DRAFT', 'SCHEDULED', 'FAILED', 'PUBLISHED', 'PARTIALLY_PUBLISHED'].includes(
        existing.status,
      )
    ) {
      throw AppError.conflict('Bài này không ở trạng thái có thể sửa.');
    }

    if (publishedEdit) {
      if (input.socialAccountIds || input.mediaAssetIds) {
        throw AppError.conflict(
          'Bài đã publish chỉ sửa được nội dung/caption/link/options, không đổi target hoặc media.',
        );
      }
      await this.editPublishedPlatformPosts(existing, input, auditContext.requestId);
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
      if (publishedEdit && input.platformOverrides) {
        await this.updatePublishedOverrides(tx, workspaceId, postId, input.platformOverrides);
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
    options: { deleteFromPlatforms?: boolean; platformPostIds?: string[] },
    auditContext: AuditContext,
  ) {
    const post = await this.findPost(workspaceId, postId);
    const candidateMediaAssetIds = this.mediaAssetIdsFromPost(post);
    const deletePublished = ['PUBLISHED', 'PARTIALLY_PUBLISHED'].includes(post.status);
    if (
      ![
        'DRAFT',
        'FAILED',
        'SCHEDULED',
        'PUBLISHED',
        'PARTIALLY_PUBLISHED',
        'QUEUED',
        'PROCESSING',
        'CANCELLED',
      ].includes(post.status)
    ) {
      throw AppError.conflict('Bài này không ở trạng thái có thể xóa.');
    }

    const requestedPlatformPostIds =
      options.platformPostIds === undefined
        ? null
        : new Set(options.platformPostIds.filter(Boolean));
    if (requestedPlatformPostIds) {
      const postPlatformPostIds = new Set(post.platformPosts.map((item) => item.id));
      const invalidIds = [...requestedPlatformPostIds].filter((id) => !postPlatformPostIds.has(id));
      if (invalidIds.length > 0) {
        throw AppError.validation('Một hoặc nhiều platform post không thuộc bài viết này.');
      }
    }
    const publishedRemoteTargets = post.platformPosts.filter(
      (item) =>
        item.status === 'PUBLISHED' &&
        item.externalPostId &&
        (!requestedPlatformPostIds || requestedPlatformPostIds.has(item.id)),
    );
    const remoteDeletePlatformPostIds =
      deletePublished && options.deleteFromPlatforms !== false
        ? publishedRemoteTargets.map((item) => item.id)
        : [];
    const activePlatformPostIds = post.platformPosts
      .filter((item) => item.status !== 'DELETED')
      .map((item) => item.id);
    const contentDeleteRequested =
      requestedPlatformPostIds === null ||
      activePlatformPostIds.every((id) => requestedPlatformPostIds.has(id));

    const remoteDeleteResults =
      remoteDeletePlatformPostIds.length > 0
        ? await this.deletePublishedPlatformPosts(
            post,
            auditContext.requestId,
            remoteDeletePlatformPostIds,
          )
        : [];
    const remoteDeletedPlatformPostIds = remoteDeleteResults
      .filter((result) => result.deleted)
      .map((result) => result.platformPostId);
    const remoteFailedResults = remoteDeleteResults.filter((result) => !result.deleted);
    const remoteFailedPlatformPostIds = new Set(
      remoteFailedResults.map((result) => result.platformPostId),
    );
    const localDeletedPlatformPostIds =
      requestedPlatformPostIds === null
        ? remoteDeletedPlatformPostIds
        : [...requestedPlatformPostIds].filter((id) => !remoteFailedPlatformPostIds.has(id));

    if (!contentDeleteRequested || remoteFailedResults.length > 0) {
      if (localDeletedPlatformPostIds.length > 0) {
        await this.markPlatformPostsDeleted(workspaceId, postId, localDeletedPlatformPostIds);
      }
      await this.updateParentStatus(postId);
      const mediaCleanup = await this.deleteUnusedPostMedia(
        workspaceId,
        candidateMediaAssetIds,
        auditContext.requestId ?? 'manual',
      );

      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'POST_DELETED',
        resourceType: 'ContentPost',
        resourceId: postId,
        metadata: {
          previousStatus: post.status,
          contentDeleted: false,
          platformOnlyDelete: true,
          remoteDeleteResults,
          mediaCleanup,
        },
      });

      return {
        deleted: false,
        contentDeleted: false,
        platformOnlyDelete: true,
        remoteDeleteResults,
        mediaCleanup,
      };
    }

    await this.removeScheduledJobs(post.id, workspaceId, auditContext.requestId);
    if (remoteDeletePlatformPostIds.length > 0) {
      const deletedIdSet = new Set(remoteDeletedPlatformPostIds);
      const missingDeletedIds = remoteDeletePlatformPostIds.filter((id) => !deletedIdSet.has(id));
      if (missingDeletedIds.length > 0) {
        throw AppError.conflict('Một hoặc nhiều social chưa được xóa thành công.');
      }
    }

    await this.prisma.contentPost.delete({
      where: { id: postId },
    });

    const mediaCleanup = await this.deleteUnusedPostMedia(
      workspaceId,
      candidateMediaAssetIds,
      auditContext.requestId ?? 'manual',
    );

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_DELETED',
      resourceType: 'ContentPost',
      resourceId: postId,
      metadata: {
        previousStatus: post.status,
        contentDeleted: true,
        remoteDeleteResults,
        mediaCleanup,
      },
    });

    return {
      deleted: true,
      contentDeleted: true,
      remoteDeleteResults,
      mediaCleanup,
    };
  }

  async bulkDeletePosts(
    workspaceId: string,
    actorUserId: string,
    input: BulkDeletePostsInput,
    auditContext: AuditContext,
  ) {
    const uniquePostIds = [...new Set(input.postIds)];
    const results: Array<{
      postId: string;
      deleted: boolean;
      errorCode?: string;
      errorMessage?: string;
    }> = [];

    for (const postId of uniquePostIds) {
      try {
        const result = await this.deletePost(
          workspaceId,
          postId,
          actorUserId,
          { deleteFromPlatforms: input.deleteFromPlatforms },
          auditContext,
        );
        if (result.deleted) {
          results.push({ postId, deleted: true });
        } else {
          const failureSummary = summarizePlatformDeleteFailures(result.remoteDeleteResults);
          results.push({
            postId,
            deleted: false,
            errorCode: 'PARTIAL_DELETE',
            errorMessage: failureSummary
              ? `Chưa xóa bài khỏi workspace. Lỗi: ${failureSummary}.`
              : 'Chưa xóa bài khỏi workspace vì một hoặc nhiều social chưa xóa thành công.',
          });
        }
      } catch (error) {
        results.push({
          postId,
          deleted: false,
          errorCode: errorCodeForBulkDelete(error),
          errorMessage:
            error instanceof Error ? error.message : 'Lỗi không xác định khi xóa bài viết.',
        });
      }
    }

    const deleted = results.filter((item) => item.deleted).length;
    const failed = results.length - deleted;

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_DELETED',
      resourceType: 'ContentPost',
      metadata: {
        action: 'bulk_delete',
        requested: uniquePostIds.length,
        deleted,
        failed,
        deleteFromPlatforms: input.deleteFromPlatforms,
      },
    });

    return {
      requested: uniquePostIds.length,
      deleted,
      failed,
      results,
    };
  }

  async publishNow(
    workspaceId: string,
    postId: string,
    actorUserId: string,
    input: PublishPostInputDto,
    auditContext: AuditContext,
  ) {
    await this.removeScheduledJobs(postId, workspaceId, auditContext.requestId);
    const queued = await this.prepareForPublishing(
      workspaceId,
      postId,
      input.socialAccountIds,
      auditContext.requestId,
    );
    await Promise.all(
      queued.outboxEventIds.map((outboxEventId) => this.dispatchPublishOutboxEvent(outboxEventId)),
    );

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

    await this.removeScheduledJobs(postId, workspaceId, auditContext.requestId);

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

    const retryIntent = await this.prisma.$transaction(async (tx) => {
      const outboxEventIds: string[] = [];
      for (const item of failed) {
        const latest = await tx.outboundOperation.findFirst({
          where: {
            operationType: 'PUBLISH_POST',
            resourceType: 'PlatformPost',
            resourceId: item.id,
          },
          orderBy: { operationGeneration: 'desc' },
          select: { id: true, operationGeneration: true, state: true },
        });
        const decision = canCreateNextGeneration(latest);
        if (decision.action === 'REJECT') throw AppError.conflict(decision.reason);
      }

      await tx.contentPost.update({
        where: { id: postId },
        data: { status: 'QUEUED' },
      });
      await tx.platformPost.updateMany({
        where: { id: { in: failed.map((item) => item.id) } },
        data: { status: 'QUEUED', errorCode: null, errorMessage: null },
      });

      for (const item of failed) {
        const latest = await tx.outboundOperation.findFirst({
          where: {
            operationType: 'PUBLISH_POST',
            resourceType: 'PlatformPost',
            resourceId: item.id,
          },
          orderBy: { operationGeneration: 'desc' },
          select: { id: true, operationGeneration: true, state: true },
        });
        const decision = canCreateNextGeneration(latest);
        if (decision.action === 'REJECT') throw AppError.conflict(decision.reason);
        const operation =
          decision.action === 'REUSE_ACTIVE'
            ? await tx.outboundOperation.findUniqueOrThrow({ where: { id: decision.operationId } })
            : await findOrCreateOutboundOperation(tx, {
                workspaceId,
                operationType: 'PUBLISH_POST',
                resourceType: 'PlatformPost',
                resourceId: item.id,
                operationGeneration: decision.nextGeneration,
              });
        const payload: QueuePayload<'retry-failed-post'> = {
          platformPostId: item.id,
          workspaceId,
          requestedByUserId: actorUserId,
          operationId: operation.id,
        };
        const jobId = buildJobId('retry-failed-post', payload);
        const event = await createQueueOutboxEvent(tx, {
          workspaceId,
          queueName: 'retry-failed-post',
          jobId,
          payload,
          options: buildQueueJobOptions('retry-failed-post', jobId),
          aggregateType: 'OutboundOperation',
          aggregateId: operation.id,
          dedupeKey: `retry-publish:${operation.id}`,
        });
        outboxEventIds.push(event.id);
      }
      return { outboxEventIds };
    });

    await Promise.all(
      retryIntent.outboxEventIds.map((outboxEventId) =>
        this.dispatchPublishOutboxEvent(outboxEventId),
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
    const { state, platform } = await this.fetchPlatformPostState(
      workspaceId,
      postId,
      platformPostId,
    );

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'PlatformPost',
      resourceId: platformPostId,
      metadata: { action: 'refresh_platform_state', platform },
    });

    return {
      post: await this.get(workspaceId, postId),
      platformState: state,
    };
  }

  async cancelTikTokPublish(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    return await this.withTikTokPlatformPostContext(
      workspaceId,
      postId,
      platformPostId,
      async ({ platformPost, adapter, ctx }) => {
        if (!adapter.cancelPublish) {
          throw AppError.capabilityUnsupported('TIKTOK', 'cancel_publish');
        }

        await adapter.cancelPublish(ctx, platformPost.externalPostId);

        const state = {
          ...(jsonObject(platformPost.platformState) ?? {}),
          publishId: platformPost.externalPostId,
          status: 'CANCELLED',
          refreshedAt: new Date().toISOString(),
        } satisfies TikTokPublishPlatformState;

        await this.prisma.platformPost.update({
          where: { id: platformPost.id },
          data: {
            status: 'CANCELLED',
            platformState: state as unknown as Prisma.InputJsonValue,
            errorCode: null,
            errorMessage: null,
          },
        });
        await this.updateParentStatus(platformPost.contentPostId);

        await this.audit.record({
          ...auditContext,
          actorUserId,
          workspaceId,
          action: 'POST_UPDATED',
          resourceType: 'PlatformPost',
          resourceId: platformPostId,
          metadata: { action: 'tiktok_cancel_publish', platformState: state },
        });

        return {
          post: await this.get(workspaceId, postId),
          platformState: state,
        };
      },
    );
  }

  async makeYouTubePublic(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    return await this.withYouTubePlatformPostContext(
      workspaceId,
      postId,
      platformPostId,
      async ({ platformPost, adapter, ctx }) => {
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
      },
    );
  }

  private async prepareForPublishing(
    workspaceId: string,
    postId: string,
    socialAccountIds: string[] | undefined,
    correlationId = 'manual',
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

      const existingAccountIds = new Set(post.platformPosts.map((item) => item.socialAccountId));
      const requestedTargets = socialAccountIds ? [...new Set(socialAccountIds)] : null;
      if (requestedTargets) {
        const invalidTargets = requestedTargets.filter((id) => !existingAccountIds.has(id));
        if (invalidTargets.length > 0) {
          throw AppError.validation(
            'Chỉ publish được các social account đã có trong draft. Hãy sửa draft nếu muốn đổi target.',
          );
        }
      }

      const targets = post.platformPosts
        .filter((item) => item.status !== 'PUBLISHED')
        .filter((item) => !requestedTargets || requestedTargets.includes(item.socialAccountId))
        .map((item) => item.socialAccountId);
      if (targets.length === 0) throw AppError.validation('Cần chọn ít nhất một social account.');
      const targetPlatformPosts = post.platformPosts.filter((item) =>
        targets.includes(item.socialAccountId),
      );

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

      const outboxEventIds: string[] = [];
      for (const platformPost of targetPlatformPosts) {
        const operation = await findOrCreateOutboundOperation(tx, {
          workspaceId,
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: platformPost.id,
          operationGeneration: 1,
        });
        const payload: QueuePayload<'publish-post'> = {
          platformPostId: platformPost.id,
          workspaceId,
          correlationId,
          operationId: operation.id,
        };
        const jobId = buildJobId('publish-post', payload);
        const outboxEvent = await createQueueOutboxEvent(tx, {
          workspaceId,
          queueName: 'publish-post',
          jobId,
          payload,
          options: buildQueueJobOptions('publish-post', jobId),
          aggregateType: 'OutboundOperation',
          aggregateId: operation.id,
        });
        outboxEventIds.push(outboxEvent.id);
      }

      return { id: postId, outboxEventIds };
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
      for (const platformPost of post.platformPosts) {
        await this.enqueuePlatformPost(platformPost.id, workspaceId, correlationId, runAt);
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
      platformPosts.map((item) => this.enqueuePlatformPost(item.id, workspaceId, correlationId)),
    );
  }

  private async enqueuePlatformPost(
    platformPostId: string,
    workspaceId: string,
    correlationId = 'manual',
    runAt?: Date,
  ): Promise<void> {
    const event = await this.prisma.$transaction(async (tx) => {
      const operation = await findOrCreateOutboundOperation(tx, {
        workspaceId,
        operationType: 'PUBLISH_POST',
        resourceType: 'PlatformPost',
        resourceId: platformPostId,
        operationGeneration: 1,
      });
      const payload: QueuePayload<'publish-post'> = {
        platformPostId,
        workspaceId,
        correlationId,
        operationId: operation.id,
      };
      const jobId = buildJobId('publish-post', payload);
      const delay = runAt ? Math.max(0, runAt.getTime() - Date.now()) : undefined;
      const options = buildQueueJobOptions(
        'publish-post',
        jobId,
        delay === undefined ? {} : { delay },
      );
      return await createQueueOutboxEvent(tx, {
        workspaceId,
        queueName: 'publish-post',
        jobId,
        payload,
        options,
        aggregateType: 'OutboundOperation',
        aggregateId: operation.id,
      });
    });

    await this.dispatchPublishOutboxEvent(event.id);
  }

  private async dispatchPublishOutboxEvent(outboxEventId: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event) return;
    const value = event.payload as unknown as {
      queueName: 'publish-post' | 'retry-failed-post';
      jobName: 'publish-post' | 'retry-failed-post';
      payload: QueuePayload<'publish-post'> | QueuePayload<'retry-failed-post'>;
      options: ReturnType<typeof buildQueueJobOptions>;
    };
    const queue = value.queueName === 'publish-post' ? this.publishQueue : this.retryQueue;
    try {
      await queue.add(value.jobName, value.payload, value.options);
      await this.prisma.outboxEvent.update({
        where: { id: outboxEventId },
        data: { dispatchedAt: new Date(), lastError: null },
      });
    } catch (error) {
      await this.prisma.outboxEvent.update({
        where: { id: outboxEventId },
        data: {
          dispatchAttempts: { increment: 1 },
          lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Redis enqueue failed',
        },
      });
      logger.warn(
        { err: error, outboxEventId },
        'Immediate publish enqueue failed; outbox will retry',
      );
    }
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
      const options = this.resolvePlatformPostOptions(override);
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
          options,
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

  private resolvePlatformPostOptions(
    override:
      | CreatePostInput['platformOverrides'][number]
      | NonNullable<UpdatePostInput['platformOverrides']>[number]
      | undefined,
  ): Prisma.InputJsonValue | undefined {
    const explicitOptions =
      override?.options && Object.keys(override.options).length > 0 ? override.options : undefined;
    if (explicitOptions) return explicitOptions as Prisma.InputJsonValue;

    return undefined;
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

  private mediaAssetIdsFromPost(post: Awaited<ReturnType<typeof this.findPost>>): string[] {
    return [
      ...new Set([
        ...post.media.map((item) => item.mediaAssetId),
        ...post.platformPosts.flatMap((platformPost) =>
          platformPost.media.map((item) => item.mediaAssetId),
        ),
        ...post.platformPosts.flatMap((platformPost) =>
          mediaAssetIdsFromOptions(platformPost.options),
        ),
      ]),
    ];
  }

  private async markPlatformPostsDeleted(
    workspaceId: string,
    contentPostId: string,
    platformPostIds: string[],
  ): Promise<void> {
    if (platformPostIds.length === 0) return;

    await this.prisma.$transaction([
      this.prisma.platformPostMedia.deleteMany({
        where: {
          platformPostId: { in: platformPostIds },
          platformPost: { workspaceId, contentPostId },
        },
      }),
      this.prisma.comment.deleteMany({
        where: {
          platformPostId: { in: platformPostIds },
          workspaceId,
        },
      }),
      this.prisma.postMetric.deleteMany({
        where: {
          platformPostId: { in: platformPostIds },
          workspaceId,
        },
      }),
      this.prisma.metricSnapshot.deleteMany({
        where: {
          platformPostId: { in: platformPostIds },
          workspaceId,
        },
      }),
      this.prisma.platformPost.updateMany({
        where: {
          id: { in: platformPostIds },
          workspaceId,
          contentPostId,
        },
        data: {
          status: 'DELETED',
          errorCode: null,
          errorMessage: null,
        },
      }),
    ]);
  }

  private async deleteUnusedPostMedia(
    workspaceId: string,
    mediaAssetIds: string[],
    requestId: string,
  ): Promise<{ deleted: number; skipped: number; error?: string }> {
    if (mediaAssetIds.length === 0) {
      return { deleted: 0, skipped: 0 };
    }

    try {
      return await this.media.deleteUnused(workspaceId, mediaAssetIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown media cleanup error';
      logger.warn(
        {
          err: error,
          requestId,
          workspaceId,
          mediaAssetIds,
        },
        'Không dọn được media không còn dùng sau khi xóa post',
      );
      return { deleted: 0, skipped: mediaAssetIds.length, error: message };
    }
  }

  private async findPost(workspaceId: string, postId: string) {
    const post = await this.prisma.contentPost.findFirst({
      where: { id: postId, workspaceId, deletedAt: null },
      include: {
        platformPosts: {
          include: {
            socialAccount: { include: { token: true } },
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

    const jobIds = platformPosts.flatMap((platformPost) => [
      buildJobId('publish-post', {
        platformPostId: platformPost.id,
        workspaceId,
        correlationId: 'lookup',
      }),
      buildJobId('retry-failed-post', {
        platformPostId: platformPost.id,
        workspaceId,
        requestedByUserId: 'lookup',
      }),
    ]);

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
    const optionMediaAssetIds = [
      ...new Set(post.platformPosts.flatMap((item) => mediaAssetIdsFromOptions(item.options))),
    ];
    const optionMediaAssets =
      optionMediaAssetIds.length > 0
        ? await this.prisma.mediaAsset.findMany({
            where: {
              id: { in: optionMediaAssetIds },
              workspaceId: post.workspaceId,
              deletedAt: null,
            },
          })
        : [];
    const optionMediaAssetById = new Map(optionMediaAssets.map((asset) => [asset.id, asset]));

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
      sourceType: post.sourceType,
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
          optionMedia: await Promise.all(
            mediaAssetIdsFromOptions(item.options)
              .map((id) => optionMediaAssetById.get(id))
              .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
              .map((asset) => this.toMediaAssetView(asset)),
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
      workspaceId: string;
      type: unknown;
      status: string;
      originalFileName: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      width: number | null;
      height: number | null;
      durationSec: number | null;
      storageKey: string;
      thumbnailKey: string | null;
    },
    position?: number,
  ) {
    const thumbnailUrl = mediaAsset.thumbnailKey
      ? `${this.env.API_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${mediaAsset.workspaceId}/media/${mediaAsset.id}/thumbnail`
      : null;

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
      thumbnailUrl,
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
      displayUrl:
        mediaAsset.status === 'READY'
          ? `${this.env.API_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${mediaAsset.workspaceId}/media/${mediaAsset.id}/object`
          : mediaAsset.status === 'ARCHIVED'
            ? thumbnailUrl
            : null,
    };
  }

  private async fetchPlatformPostState(
    workspaceId: string,
    postId: string,
    platformPostId: string,
  ): Promise<{
    platform: Platform;
    state: Record<string, unknown>;
  }> {
    return await this.withPlatformPostStateContext(
      workspaceId,
      postId,
      platformPostId,
      async (base) => {
        const currentState = jsonObject(base.platformPost.platformState) ?? {};
        const platformState =
          base.platformPost.platform === 'YOUTUBE' && hasYouTubeStatusMethods(base.adapter)
            ? await base.adapter.getVideoPlatformState(base.ctx, base.platformPost.externalPostId)
            : hasTikTokStatusMethods(base.adapter)
              ? await base.adapter.getPublishPlatformState(
                  base.ctx,
                  base.platformPost.externalPostId,
                )
              : null;
        const metricsResult = await this.readPlatformPostMetrics(
          base.adapter,
          base.ctx,
          base.platformPost.externalPostId,
        );
        const state: Record<string, unknown> = {
          ...currentState,
          ...(jsonObject(platformState) ?? {}),
          metricsRefreshedAt: metricsResult.refreshedAt,
        };
        if (metricsResult.metrics) state.metrics = metricsResult.metrics;
        if (metricsResult.error) {
          state.metricsError = metricsResult.error;
        } else {
          delete state.metricsError;
        }

        await this.prisma.platformPost.update({
          where: { id: base.platformPost.id },
          data: {
            platformState: state as unknown as Prisma.InputJsonValue,
            errorCode: null,
            errorMessage: null,
          },
        });
        return { platform: base.platformPost.platform, state };
      },
    );
  }

  private async readPlatformPostMetrics(
    adapter: SocialPlatformAdapter,
    ctx: AdapterContext,
    externalPostId: string,
  ): Promise<{
    metrics?: PostMetrics;
    error?: { code: string; message: string };
    refreshedAt: string;
  }> {
    const refreshedAt = new Date().toISOString();
    try {
      return {
        metrics: await adapter.getPostMetrics(ctx, externalPostId),
        refreshedAt,
      };
    } catch (error) {
      return {
        error: {
          code: isPlatformError(error) ? error.kind : 'METRICS_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Không đọc được metrics nền tảng.',
        },
        refreshedAt,
      };
    }
  }

  private async withPlatformPostStateContext<T>(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    fn: (base: {
      platformPost: {
        id: string;
        platform: Platform;
        externalPostId: string;
        platformState: Prisma.JsonValue | null;
        socialAccount: {
          id: string;
          workspaceId: string;
          platform: Platform;
          externalAccountId: string;
          externalPageId: string | null;
          status: string;
          token: {
            id: string;
            accessToken: string;
            refreshToken: string | null;
            accessTokenExpiresAt: Date | null;
            refreshTokenExpiresAt: Date | null;
          } | null;
        };
      };
      adapter: SocialPlatformAdapter;
      ctx: AdapterContext;
    }) => Promise<T>,
  ): Promise<T> {
    const platformPost = await this.prisma.platformPost.findFirst({
      where: {
        id: platformPostId,
        workspaceId,
        contentPostId: postId,
      },
      include: { socialAccount: { include: { token: true } } },
    });
    if (!platformPost) throw AppError.notFound('platform post');
    if (!platformPost.externalPostId) {
      throw AppError.conflict('Platform post chưa có externalPostId để kiểm tra trạng thái.');
    }
    if (!platformPost.socialAccount.token || platformPost.socialAccount.status !== 'CONNECTED') {
      throw AppError.conflict('Social account chưa kết nối hoặc token không khả dụng.');
    }

    return await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
      const adapter = adapters.get(platformPost.platform);
      const accessToken = await this.getFreshAccessToken(platformPost.socialAccount, adapter);
      const ctx = {
        accessToken,
        externalAccountId: platformPost.socialAccount.externalAccountId,
        externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
        correlationId: `platform-state:${platformPostId}`,
      } satisfies AdapterContext;

      return await fn({
        platformPost: {
          id: platformPost.id,
          platform: platformPost.platform as Platform,
          externalPostId: platformPost.externalPostId as string,
          platformState: platformPost.platformState,
          socialAccount: {
            id: platformPost.socialAccount.id,
            workspaceId: platformPost.socialAccount.workspaceId,
            platform: platformPost.socialAccount.platform as Platform,
            externalAccountId: platformPost.socialAccount.externalAccountId,
            externalPageId: platformPost.socialAccount.externalPageId,
            status: platformPost.socialAccount.status,
            token: platformPost.socialAccount.token,
          },
        },
        adapter,
        ctx,
      });
    });
  }

  private async withTikTokPlatformPostContext<T>(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    fn: (base: {
      platformPost: {
        id: string;
        contentPostId: string;
        externalPostId: string;
        platformState: Prisma.JsonValue | null;
        socialAccount: {
          id: string;
          workspaceId: string;
          platform: Platform;
          externalAccountId: string;
          externalPageId: string | null;
          status: string;
          token: {
            id: string;
            accessToken: string;
            refreshToken: string | null;
            accessTokenExpiresAt: Date | null;
            refreshTokenExpiresAt: Date | null;
          } | null;
        };
      };
      adapter: SocialPlatformAdapter & TikTokStatusAdapter;
      ctx: AdapterContext;
    }) => Promise<T>,
  ): Promise<T> {
    const platformPost = await this.prisma.platformPost.findFirst({
      where: {
        id: platformPostId,
        workspaceId,
        contentPostId: postId,
      },
      include: { socialAccount: { include: { token: true } } },
    });
    if (!platformPost) throw AppError.notFound('platform post');
    if (platformPost.platform !== 'TIKTOK') {
      throw AppError.capabilityUnsupported(platformPost.platform, 'tiktok_publish_state');
    }
    if (!platformPost.externalPostId) {
      throw AppError.conflict('TikTok publish chưa có publish_id để thao tác.');
    }
    if (!platformPost.socialAccount.token || platformPost.socialAccount.status !== 'CONNECTED') {
      throw AppError.conflict('TikTok account chưa kết nối hoặc token không khả dụng.');
    }

    return await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
      const adapter = adapters.get('TIKTOK');
      if (!hasTikTokStatusMethods(adapter)) {
        throw AppError.capabilityUnsupported('TIKTOK', 'tiktok_publish_state');
      }

      const accessToken = await this.getFreshAccessToken(platformPost.socialAccount, adapter);
      const ctx = {
        accessToken,
        externalAccountId: platformPost.socialAccount.externalAccountId,
        externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
        correlationId: `tiktok-state:${platformPostId}`,
      } satisfies AdapterContext;

      return await fn({
        platformPost: {
          id: platformPost.id,
          contentPostId: platformPost.contentPostId,
          externalPostId: platformPost.externalPostId as string,
          platformState: platformPost.platformState,
          socialAccount: {
            id: platformPost.socialAccount.id,
            workspaceId: platformPost.socialAccount.workspaceId,
            platform: platformPost.socialAccount.platform as Platform,
            externalAccountId: platformPost.socialAccount.externalAccountId,
            externalPageId: platformPost.socialAccount.externalPageId,
            status: platformPost.socialAccount.status,
            token: platformPost.socialAccount.token,
          },
        },
        adapter,
        ctx,
      });
    });
  }

  private async editPublishedPlatformPosts(
    post: Awaited<ReturnType<typeof this.findPost>>,
    input: UpdatePostInput,
    correlationId = 'manual',
  ): Promise<void> {
    const targets = post.platformPosts.filter(
      (item) => item.status === 'PUBLISHED' && item.externalPostId,
    );
    if (targets.length === 0) return;

    await this.adapterFactory.withWorkspace(post.workspaceId, async ({ adapters }) => {
      const operations = targets.map((platformPost) => {
        const adapter = adapters.requireCapability(
          platformPost.platform as Platform,
          'editPublishedPost',
        );
        if (!adapter.editPost) {
          throw AppError.capabilityUnsupported(
            platformPost.platform as Platform,
            'editPublishedPost',
          );
        }
        if (
          !platformPost.socialAccount.token ||
          platformPost.socialAccount.status !== 'CONNECTED'
        ) {
          throw AppError.conflict(
            `${platformPost.platform} account chưa kết nối hoặc token không khả dụng.`,
          );
        }
        return { platformPost, adapter };
      });

      for (const { platformPost, adapter } of operations) {
        const override = input.platformOverrides?.find(
          (item) => item.socialAccountId === platformPost.socialAccountId,
        );
        const accessToken = await this.getFreshAccessToken(platformPost.socialAccount, adapter);
        const mediaTypes =
          platformPost.media.length > 0
            ? platformPost.media.map((item) => item.mediaAsset.type as MediaType)
            : post.media.map((item) => item.mediaAsset.type as MediaType);
        await adapter.editPost?.(
          {
            accessToken,
            externalAccountId: platformPost.socialAccount.externalAccountId,
            externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
            correlationId,
            logger,
          },
          platformPost.externalPostId as string,
          {
            caption:
              override?.caption ?? input.body ?? platformPost.caption ?? post.body ?? undefined,
            title: override?.title ?? input.title ?? platformPost.title ?? post.title ?? undefined,
            description:
              override?.description ??
              input.body ??
              platformPost.description ??
              post.body ??
              undefined,
            linkUrl:
              override?.linkUrl ??
              input.linkUrl ??
              platformPost.linkUrl ??
              post.linkUrl ??
              undefined,
            hashtags: input.hashtags ?? post.hashtags,
            mediaTypes,
            options: override?.options ?? jsonObject(platformPost.options) ?? undefined,
          },
        );
      }
    });
  }

  private async deletePublishedPlatformPosts(
    post: Awaited<ReturnType<typeof this.findPost>>,
    correlationId = 'manual',
    platformPostIds?: string[],
  ): Promise<PlatformDeleteResult[]> {
    const selectedIds = platformPostIds ? new Set(platformPostIds) : null;
    const targets = post.platformPosts.filter(
      (item) =>
        item.status === 'PUBLISHED' &&
        item.externalPostId &&
        (!selectedIds || selectedIds.has(item.id)),
    );
    if (targets.length === 0) return [];

    return await this.adapterFactory.withWorkspace(post.workspaceId, async ({ adapters }) => {
      const results: PlatformDeleteResult[] = [];

      for (const platformPost of targets) {
        const baseResult = {
          platformPostId: platformPost.id,
          platform: platformPost.platform as Platform,
          socialAccountId: platformPost.socialAccountId,
          socialAccountName: platformPost.socialAccount.name,
          externalPostId: platformPost.externalPostId as string,
        };

        try {
          const adapter = adapters.requireCapability(
            platformPost.platform as Platform,
            'deletePublishedPost',
          );
          if (!adapter.deletePost) {
            throw AppError.capabilityUnsupported(
              platformPost.platform as Platform,
              'deletePublishedPost',
            );
          }
          if (
            !platformPost.socialAccount.token ||
            platformPost.socialAccount.status !== 'CONNECTED'
          ) {
            throw AppError.conflict(
              `${platformPost.platform} account chưa kết nối hoặc token không khả dụng.`,
            );
          }

          const accessToken = await this.getFreshAccessToken(platformPost.socialAccount, adapter);
          await adapter.deletePost(
            {
              accessToken,
              externalAccountId: platformPost.socialAccount.externalAccountId,
              externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
              correlationId,
              logger,
            },
            platformPost.externalPostId as string,
          );
          results.push({ ...baseResult, deleted: true });
        } catch (error) {
          if (isPlatformError(error) && error.kind === 'NOT_FOUND') {
            results.push({
              ...baseResult,
              deleted: true,
              errorCode: 'REMOTE_ALREADY_DELETED',
              errorMessage: error.message,
            });
            continue;
          }

          results.push({
            ...baseResult,
            deleted: false,
            errorCode: deleteErrorCode(error),
            errorMessage:
              error instanceof Error ? error.message : 'Không xóa được bài trên nền tảng.',
          });
        }
      }

      return results;
    });
  }

  private async updatePublishedOverrides(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    postId: string,
    platformOverrides: NonNullable<UpdatePostInput['platformOverrides']>,
  ): Promise<void> {
    for (const override of platformOverrides) {
      await tx.platformPost.updateMany({
        where: {
          workspaceId,
          contentPostId: postId,
          socialAccountId: override.socialAccountId,
          status: 'PUBLISHED',
        },
        data: {
          caption: override.caption,
          title: override.title,
          description: override.description,
          linkUrl: override.linkUrl,
          options: override.options as Prisma.InputJsonValue | undefined,
        },
      });
    }
  }

  private async withYouTubePlatformPostContext<T>(
    workspaceId: string,
    postId: string,
    platformPostId: string,
    fn: (base: {
      platformPost: {
        id: string;
        platform: Platform;
        externalPostId: string;
        socialAccount: {
          id: string;
          workspaceId: string;
          platform: Platform;
          externalAccountId: string;
          externalPageId: string | null;
          status: string;
          token: {
            id: string;
            accessToken: string;
            refreshToken: string | null;
            accessTokenExpiresAt: Date | null;
            refreshTokenExpiresAt: Date | null;
          } | null;
        };
      };
      adapter: SocialPlatformAdapter & YouTubeStatusAdapter;
      ctx: AdapterContext;
    }) => Promise<T>,
  ): Promise<T> {
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

    return await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
      const adapter = adapters.get('YOUTUBE');
      if (!hasYouTubeStatusMethods(adapter)) {
        throw AppError.capabilityUnsupported('YOUTUBE', 'youtube_video_state');
      }

      const accessToken = await this.getFreshAccessToken(platformPost.socialAccount, adapter);
      const ctx = {
        accessToken,
        externalAccountId: platformPost.socialAccount.externalAccountId,
        externalPageId: platformPost.socialAccount.externalPageId ?? undefined,
        correlationId: `youtube-state:${platformPostId}`,
      } satisfies AdapterContext;

      return await fn({
        platformPost: {
          id: platformPost.id,
          platform: platformPost.platform as Platform,
          externalPostId: platformPost.externalPostId as string,
          socialAccount: {
            id: platformPost.socialAccount.id,
            workspaceId: platformPost.socialAccount.workspaceId,
            platform: platformPost.socialAccount.platform as Platform,
            externalAccountId: platformPost.socialAccount.externalAccountId,
            externalPageId: platformPost.socialAccount.externalPageId,
            status: platformPost.socialAccount.status,
            token: platformPost.socialAccount.token,
          },
        },
        adapter,
        ctx,
      });
    });
  }

  private async updateParentStatus(contentPostId: string): Promise<void> {
    const children = await this.prisma.platformPost.findMany({
      where: { contentPostId },
      select: { status: true },
    });
    const status = deriveContentPostStatus(
      children.map((item) => item.status as PlatformPostStatus),
    );
    await this.prisma.contentPost.update({
      where: { id: contentPostId },
      data: {
        status,
        publishedAt: status === 'PUBLISHED' ? new Date() : undefined,
      },
    });
  }

  private async getFreshAccessToken(
    account: {
      id: string;
      workspaceId: string;
      platform: Platform;
      token: {
        id: string;
        accessToken: string;
        refreshToken: string | null;
        accessTokenExpiresAt: Date | null;
        refreshTokenExpiresAt: Date | null;
      } | null;
    },
    adapter: SocialPlatformAdapter,
  ): Promise<string> {
    if (!account.token) throw AppError.conflict('Social account chưa có token để kiểm tra.');

    const refreshThreshold = Date.now() + 2 * 60 * 1000;
    if (
      !account.token.accessTokenExpiresAt ||
      account.token.accessTokenExpiresAt.getTime() > refreshThreshold
    ) {
      return decryptToken(account.token.accessToken, this.keyring);
    }

    if (!account.token.refreshToken) {
      throw AppError.conflict('Token đã hết hạn. Hãy ngắt kết nối rồi kết nối lại tài khoản.');
    }

    return await getFreshAccessTokenViaCentralService(
      {
        prisma: this.prisma,
        keyring: this.keyring,
        adapterFactory: this.adapterFactory,
        tokenRefreshLock: new RedisTokenRefreshLock(this.redis.getClient()),
        account,
      },
      adapter,
    );
  }
}

interface YouTubeStatusAdapter {
  getVideoPlatformState(
    ctx: AdapterContext,
    externalPostId: string,
  ): Promise<YouTubeVideoPlatformState>;
  makeVideoPublic(ctx: AdapterContext, externalPostId: string): Promise<YouTubeVideoPlatformState>;
}

interface TikTokStatusAdapter {
  getPublishPlatformState(
    ctx: AdapterContext,
    externalPostId: string,
  ): Promise<TikTokPublishPlatformState>;
  cancelPublish?(ctx: AdapterContext, publishId: string): Promise<void>;
}

interface PlatformDeleteResult {
  platformPostId: string;
  platform: Platform;
  socialAccountId: string;
  socialAccountName: string;
  externalPostId: string;
  deleted: boolean;
  errorCode?: string;
  errorMessage?: string;
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

function hasTikTokStatusMethods(
  adapter: SocialPlatformAdapter,
): adapter is SocialPlatformAdapter & TikTokStatusAdapter {
  return adapter.platform === 'TIKTOK' && 'getPublishPlatformState' in adapter;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function mediaAssetIdsFromOptions(options: unknown): string[] {
  const object = jsonObject(options);
  const thumbnailMediaAssetId = object?.thumbnailMediaAssetId;
  return typeof thumbnailMediaAssetId === 'string' && thumbnailMediaAssetId.trim()
    ? [thumbnailMediaAssetId.trim()]
    : [];
}

function errorCodeForBulkDelete(error: unknown): string {
  if (isAppError(error)) return error.code;
  if (isPlatformError(error)) return error.kind;
  return 'UNKNOWN';
}

function deleteErrorCode(error: unknown): string {
  if (isAppError(error)) return error.code;
  if (isPlatformError(error)) return error.kind;
  return 'UNKNOWN';
}

function summarizePlatformDeleteFailures(results: PlatformDeleteResult[]): string {
  const failures = results.filter((item) => !item.deleted);
  if (failures.length === 0) return '';
  const visible = failures
    .slice(0, 2)
    .map((item) => {
      const code = item.errorCode ? `${item.errorCode}: ` : '';
      const message = item.errorMessage || 'Không rõ nguyên nhân.';
      return `${item.platform} / ${item.socialAccountName}: ${code}${message}`;
    })
    .join('; ');
  const hiddenCount = failures.length - 2;
  return hiddenCount > 0 ? `${visible}; và ${hiddenCount} target khác` : visible;
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
