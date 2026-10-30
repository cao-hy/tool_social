import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  canCreateNextGeneration,
  createQueueOutboxEvent,
  findOrCreateOutboundOperation,
  Prisma,
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
import { EventsService } from '../events/events.service';
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
  private readonly updateQueue: Queue;
  private readonly deleteQueue: Queue;
  private readonly publicS3: S3Client;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MEDIA_SERVICE) private readonly media: MediaService,
    @Optional() @Inject(EventsService) private readonly events?: EventsService,
  ) {
    this.publishQueue = new Queue('publish-post', {
      connection: this.redis.getClient(),
    });
    this.retryQueue = new Queue('retry-failed-post', {
      connection: this.redis.getClient(),
    });
    this.updateQueue = new Queue('update-platform-post', {
      connection: this.redis.getClient(),
    });
    this.deleteQueue = new Queue('delete-platform-post', {
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
    await Promise.all([
      this.publishQueue.close(),
      this.retryQueue.close(),
      this.updateQueue.close(),
      this.deleteQueue.close(),
    ]);
  }

  private async resolveMediaTypeWhere(
    workspaceId: string,
    mediaType: 'IMAGE' | 'VIDEO' | 'NONE',
  ): Promise<Prisma.ContentPostWhereInput> {
    const candidatePlatformPosts = await this.prisma.platformPost.findMany({
      where: {
        workspaceId,
        contentPost: {
          workspaceId,
          deletedAt: null,
          media: { none: {} },
        },
        OR: [{ externalRaw: { not: Prisma.AnyNull } }, { media: { some: {} } }],
      },
      select: {
        id: true,
        contentPostId: true,
        platform: true,
        externalPostId: true,
        externalUrl: true,
        externalRaw: true,
        media: {
          select: {
            mediaAsset: { select: { type: true } },
          },
          orderBy: { position: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const fallbackTypesByPostId = new Map<string, MediaType[]>();
    for (const pp of candidatePlatformPosts) {
      if (fallbackTypesByPostId.has(pp.contentPostId)) continue;
      const types: MediaType[] =
        pp.media.length > 0
          ? pp.media.map((item) => item.mediaAsset.type as MediaType)
          : extractExternalMediaViews(pp).map((item) => item.type);
      if (types.length > 0) {
        fallbackTypesByPostId.set(pp.contentPostId, types);
      }
    }

    if (mediaType === 'NONE') {
      const fallbackAnyMediaIds = [...fallbackTypesByPostId.keys()];
      return {
        media: { none: {} },
        ...(fallbackAnyMediaIds.length > 0 ? { id: { notIn: fallbackAnyMediaIds } } : {}),
      };
    }

    const fallbackMatchingIds: string[] = [];
    for (const [postId, types] of fallbackTypesByPostId) {
      if (types.includes(mediaType)) {
        fallbackMatchingIds.push(postId);
      }
    }

    const localMediaClause: Prisma.ContentPostWhereInput = {
      media: { some: { mediaAsset: { type: mediaType } } },
    };
    if (fallbackMatchingIds.length === 0) {
      return localMediaClause;
    }
    return {
      OR: [localMediaClause, { id: { in: fallbackMatchingIds } }],
    };
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
    const storeWhere: Prisma.ContentPostWhereInput | undefined =
      query.storeId === 'UNASSIGNED'
        ? {
            storeId: null,
            platformPosts: { none: { socialAccount: { storeId: { not: null } } } },
          }
        : query.storeId
          ? {
              OR: [
                { storeId: query.storeId },
                { platformPosts: { some: { socialAccount: { storeId: query.storeId } } } },
              ],
            }
          : undefined;
    const mediaWhere = query.mediaType
      ? await this.resolveMediaTypeWhere(workspaceId, query.mediaType)
      : undefined;
    const baseAndFilters: Prisma.ContentPostWhereInput[] = [];
    if (storeWhere) baseAndFilters.push(storeWhere);
    if (mediaWhere) baseAndFilters.push(mediaWhere);
    const andFilters: Prisma.ContentPostWhereInput[] = [...baseAndFilters];
    if (cursor) andFilters.push(buildCursorWhere(cursor, query.sortBy, query.direction));

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
      AND: andFilters.length > 0 ? andFilters : undefined,
    };
    const countWhere: Prisma.ContentPostWhereInput = {
      ...where,
      status: undefined,
      AND: baseAndFilters.length > 0 ? baseAndFilters : undefined,
    };

    const [posts, statusCounts] = await Promise.all([
      this.prisma.contentPost.findMany({
        where,
        include: {
          store: { select: { id: true, name: true, slug: true, color: true } },
          platformPosts: {
            include: {
              socialAccount: {
                include: {
                  token: true,
                  store: { select: { id: true, name: true, slug: true, color: true } },
                },
              },
              media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
              _count: { select: { comments: { where: { deletedAt: null } } } },
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
      if (input.storeId) {
        const storeExists = await tx.store?.findFirst({
          where: { id: input.storeId, workspaceId },
          select: { id: true },
        });
        if (!storeExists) throw AppError.notFound('store');
      }

      const created = await tx.contentPost.create({
        data: {
          workspaceId,
          ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
          createdById: actorUserId,
          status,
          title: input.title,
          body: input.body,
          linkUrl: input.linkUrl,
          hashtags: input.hashtags,
          scheduledAt: input.scheduledAt,
        },
      });

      const resolvedStoreId = await this.replaceTargets(
        tx,
        workspaceId,
        created.id,
        input.socialAccountIds,
        input.platformOverrides,
        input.storeId,
      );
      await this.replaceMedia(
        tx,
        workspaceId,
        created.id,
        input.mediaAssetIds,
        resolvedStoreId ?? input.storeId ?? null,
      );

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

    this.events?.publish(workspaceId, {
      type: 'posts.changed',
      contentPostId: post.id,
    });

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

    if (!publishedEdit) {
      await this.prisma.$transaction(async (tx) => {
        if (input.storeId) {
          const storeExists = await tx.store?.findFirst({
            where: { id: input.storeId, workspaceId },
            select: { id: true },
          });
          if (!storeExists) throw AppError.notFound('store');
        }

        await tx.contentPost.update({
          where: { id: postId },
          data: {
            ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
            title: input.title,
            body: input.body,
            linkUrl: input.linkUrl,
            hashtags: input.hashtags,
          },
        });

        let effectiveStoreId = input.storeId !== undefined ? input.storeId : existing.storeId;
        if (input.socialAccountIds) {
          const resolvedStoreId = await this.replaceTargets(
            tx,
            workspaceId,
            postId,
            input.socialAccountIds,
            input.platformOverrides ?? [],
            effectiveStoreId,
          );
          if (resolvedStoreId !== undefined) {
            effectiveStoreId = resolvedStoreId;
          }
        } else if (input.storeId !== undefined && existing.platformPosts.length > 0) {
          const mismatched = existing.platformPosts.find(
            (pp) => (pp.socialAccount.storeId ?? null) !== (input.storeId ?? null),
          );
          if (mismatched) {
            throw AppError.validation(
              `Kênh "${mismatched.socialAccount.name}" đang chọn không thuộc Store mới của bài đăng.`,
            );
          }
        }
        if (input.mediaAssetIds) {
          await this.replaceMedia(tx, workspaceId, postId, input.mediaAssetIds, effectiveStoreId);
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

      this.events?.publish(workspaceId, {
        type: 'posts.changed',
        contentPostId: postId,
      });

      return this.get(workspaceId, postId);
    }

    if (input.socialAccountIds || input.mediaAssetIds) {
      throw AppError.conflict(
        'Bài đã publish chỉ sửa được nội dung/caption/link/options, không đổi target hoặc media.',
      );
    }

    const hasContentMutation =
      input.title !== undefined ||
      input.body !== undefined ||
      input.linkUrl !== undefined ||
      input.hashtags !== undefined ||
      (input.platformOverrides !== undefined && input.platformOverrides.length > 0);

    const publishedTargets = existing.platformPosts.filter(
      (item) => item.status === 'PUBLISHED' && item.externalPostId,
    );

    const adapters = await this.resolveOfflineAdapters(workspaceId);
    const editableTargets = publishedTargets.filter((target) => {
      try {
        const adapter = adapters.requireCapability(
          target.platform as Platform,
          'editPublishedPost',
        );
        return Boolean(adapter.editPost);
      } catch {
        return false;
      }
    });
    const unsupportedTargets = publishedTargets.filter(
      (target) => !editableTargets.some((editable) => editable.id === target.id),
    );

    if (hasContentMutation && publishedTargets.length > 0 && editableTargets.length === 0) {
      const firstUnsupported = unsupportedTargets[0] ?? publishedTargets[0];
      if (firstUnsupported) {
        throw AppError.capabilityUnsupported(
          firstUnsupported.platform as Platform,
          'editPublishedPost',
        );
      }
    }

    for (const target of editableTargets) {
      if (!target.socialAccount.token || target.socialAccount.status !== 'CONNECTED') {
        throw AppError.conflict(
          `${target.platform} (${target.socialAccount.name}) chưa kết nối hoặc token không khả dụng.`,
        );
      }
    }

    const correlationId = auditContext.requestId ?? `post-update:${postId}:${Date.now()}`;
    const queued = await this.prisma.$transaction(async (tx) => {
      if (input.storeId) {
        const storeExists = await tx.store?.findFirst({
          where: { id: input.storeId, workspaceId },
          select: { id: true },
        });
        if (!storeExists) throw AppError.notFound('store');
      }

      if (input.storeId !== undefined || (hasContentMutation && editableTargets.length === 0)) {
        await tx.contentPost.update({
          where: { id: postId },
          data: {
            ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
            ...(hasContentMutation && editableTargets.length === 0
              ? {
                  title: input.title,
                  body: input.body,
                  linkUrl: input.linkUrl,
                  hashtags: input.hashtags,
                }
              : {}),
          },
        });
      }

      if (!hasContentMutation || editableTargets.length === 0) {
        return { outboxEventIds: [] as string[] };
      }

      const outboxEventIds: string[] = [];
      for (const target of editableTargets) {
        const override = input.platformOverrides?.find(
          (item) => item.socialAccountId === target.socialAccountId,
        );
        const desired = {
          caption: override?.caption ?? input.body ?? target.caption ?? existing.body ?? null,
          title: override?.title ?? input.title ?? target.title ?? existing.title ?? null,
          description:
            override?.description ?? input.body ?? target.description ?? existing.body ?? null,
          linkUrl: override?.linkUrl ?? input.linkUrl ?? target.linkUrl ?? existing.linkUrl ?? null,
          hashtags: input.hashtags ?? existing.hashtags,
          options: (override?.options ?? jsonObject(target.options) ?? null) as Record<
            string,
            unknown
          > | null,
        };

        const currentState = jsonObject(target.platformState) ?? {};
        await tx.platformPost.update({
          where: { id: target.id },
          data: {
            platformState: {
              ...currentState,
              pendingUpdate: {
                state: 'QUEUED',
                desired,
                queuedAt: new Date().toISOString(),
              },
            } as unknown as Prisma.InputJsonValue,
          },
        });

        const latest = await tx.outboundOperation.findFirst({
          where: {
            operationType: 'UPDATE_POST',
            resourceType: 'PlatformPost',
            resourceId: target.id,
          },
          orderBy: { operationGeneration: 'desc' },
          select: { operationGeneration: true },
        });
        const operation = await findOrCreateOutboundOperation(tx, {
          workspaceId,
          operationType: 'UPDATE_POST',
          resourceType: 'PlatformPost',
          resourceId: target.id,
          operationGeneration: (latest?.operationGeneration ?? 0) + 1,
        });

        const payload: QueuePayload<'update-platform-post'> = {
          platformPostId: target.id,
          contentPostId: postId,
          workspaceId,
          requestedByUserId: actorUserId,
          correlationId,
          operationId: operation.id,
          desired,
          updateContentPostFields: {
            ...(input.title !== undefined ? { title: input.title ?? null } : {}),
            ...(input.body !== undefined ? { body: input.body ?? null } : {}),
            ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl ?? null } : {}),
            ...(input.hashtags !== undefined ? { hashtags: input.hashtags } : {}),
          },
        };
        const jobId = buildJobId('update-platform-post', payload);
        const opts = buildQueueJobOptions('update-platform-post', jobId);

        await tx.backgroundJob.upsert({
          where: { queueName_jobId: { queueName: 'update-platform-post', jobId } },
          create: {
            workspaceId,
            queueName: 'update-platform-post',
            jobId,
            status: 'QUEUED',
            payload: payload as unknown as Prisma.InputJsonValue,
            attempts: 0,
            maxAttempts: opts.attempts,
            correlationId,
          },
          update: {
            workspaceId,
            status: 'QUEUED',
            payload: payload as unknown as Prisma.InputJsonValue,
            attempts: 0,
            maxAttempts: opts.attempts,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            errorCode: null,
            errorMessage: null,
            isDead: false,
            correlationId,
          },
        });

        const outboxEvent = await createQueueOutboxEvent(tx, {
          workspaceId,
          queueName: 'update-platform-post',
          jobId,
          payload,
          options: opts,
          aggregateType: 'OutboundOperation',
          aggregateId: operation.id,
        });
        outboxEventIds.push(outboxEvent.id);
      }

      for (const skipped of unsupportedTargets) {
        const currentState = jsonObject(skipped.platformState) ?? {};
        await tx.platformPost.update({
          where: { id: skipped.id },
          data: {
            platformState: {
              ...currentState,
              editSkippedReason: `${skipped.platform} không hỗ trợ chỉnh sửa bài sau khi đăng.`,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return { outboxEventIds };
    });

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
      metadata: {
        publishedEdit: true,
        queuedTargets: queued.outboxEventIds.length,
        skippedUnsupportedTargets: unsupportedTargets.length,
      },
    });

    this.events?.publish(workspaceId, {
      type: 'posts.changed',
      contentPostId: postId,
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

    const allPublishedRemoteTargets = post.platformPosts.filter(
      (item) => item.status === 'PUBLISHED' && Boolean(item.externalPostId),
    );
    const adapters =
      deletePublished &&
      options.deleteFromPlatforms !== false &&
      allPublishedRemoteTargets.length > 0
        ? await this.resolveOfflineAdapters(workspaceId)
        : null;

    const capabilitySupportedIds = new Set<string>();
    if (adapters) {
      for (const item of allPublishedRemoteTargets) {
        try {
          const adapter = adapters.requireCapability(
            item.platform as Platform,
            'deletePublishedPost',
          );
          if (adapter.deletePost) capabilitySupportedIds.add(item.id);
        } catch {
          // Platform does not support remote post deletion
        }
      }
    }

    const publishedRemoteTargets = allPublishedRemoteTargets.filter(
      (item) => !requestedPlatformPostIds || requestedPlatformPostIds.has(item.id),
    );
    const remoteDeleteTargets =
      deletePublished && options.deleteFromPlatforms !== false
        ? publishedRemoteTargets.filter((item) => capabilitySupportedIds.has(item.id))
        : [];
    const unsupportedRequestedTargets =
      deletePublished &&
      options.deleteFromPlatforms !== false &&
      requestedPlatformPostIds === null &&
      remoteDeleteTargets.length === 0
        ? publishedRemoteTargets.filter((item) => !capabilitySupportedIds.has(item.id))
        : [];

    if (unsupportedRequestedTargets.length > 0) {
      const remoteDeleteResults: PlatformDeleteResult[] = unsupportedRequestedTargets.map(
        (item) => ({
          platformPostId: item.id,
          platform: item.platform as Platform,
          socialAccountId: item.socialAccountId,
          socialAccountName: item.socialAccount.name,
          externalPostId: item.externalPostId as string,
          deleted: false,
          errorCode: 'CAPABILITY_UNSUPPORTED',
          errorMessage: `${item.platform} chưa hỗ trợ xóa bài qua API. Bỏ chọn xóa trên social nếu muốn xóa khỏi workspace.`,
        }),
      );
      return {
        deleted: false,
        queued: false,
        contentDeleted: false,
        platformOnlyDelete: true,
        remoteDeleteResults,
        mediaCleanup: { deleted: 0, skipped: candidateMediaAssetIds.length },
      };
    }

    const disconnectedRemoteTargets = remoteDeleteTargets.filter(
      (item) => !item.socialAccount.token || item.socialAccount.status !== 'CONNECTED',
    );
    if (disconnectedRemoteTargets.length > 0) {
      const remoteDeleteResults: PlatformDeleteResult[] = disconnectedRemoteTargets.map((item) => ({
        platformPostId: item.id,
        platform: item.platform as Platform,
        socialAccountId: item.socialAccountId,
        socialAccountName: item.socialAccount.name,
        externalPostId: item.externalPostId as string,
        deleted: false,
        errorCode: 'ACCOUNT_DISCONNECTED',
        errorMessage: `${item.platform} (${item.socialAccount.name}) chưa kết nối hoặc thiếu token. Bỏ chọn kênh này nếu chỉ muốn xóa khỏi workspace.`,
      }));
      return {
        deleted: false,
        queued: false,
        contentDeleted: false,
        platformOnlyDelete: true,
        remoteDeleteResults,
        mediaCleanup: { deleted: 0, skipped: candidateMediaAssetIds.length },
      };
    }

    const deletableRemoteAll = allPublishedRemoteTargets.filter((item) =>
      capabilitySupportedIds.has(item.id),
    );
    const contentDeleteRequested =
      options.deleteFromPlatforms === false ||
      requestedPlatformPostIds === null ||
      (deletableRemoteAll.length > 0 &&
        deletableRemoteAll.every((item) => requestedPlatformPostIds.has(item.id)));

    // Hủy lịch chờ nếu xóa cả bài viết
    if (contentDeleteRequested) {
      await this.removeScheduledJobs(post.id, workspaceId, auditContext.requestId);
    }

    // Fencing: triệt tiêu các OutboundOperation PREPARED của publish/update chưa chạy
    const fencedPlatformPostIds = contentDeleteRequested
      ? post.platformPosts.map((item) => item.id)
      : [...(requestedPlatformPostIds ?? [])];

    if (fencedPlatformPostIds.length > 0) {
      await this.prisma.$transaction([
        this.prisma.platformPost.updateMany({
          where: { id: { in: fencedPlatformPostIds }, workspaceId },
          data: { publishFence: { increment: 1 } },
        }),
        ...(this.prisma.outboundOperation
          ? [
              this.prisma.outboundOperation.updateMany({
                where: {
                  workspaceId,
                  resourceType: 'PlatformPost',
                  resourceId: { in: fencedPlatformPostIds },
                  operationType: { in: ['PUBLISH_POST', 'UPDATE_POST'] },
                  state: 'PREPARED',
                },
                data: {
                  state: 'CONFIRMED_ABSENT',
                  lastErrorCode: 'CANCELLED_BY_DELETE',
                  lastErrorMessage: 'Cancelled because user requested post deletion.',
                },
              }),
            ]
          : []),
      ]);
    }

    // Trường hợp 1: Không cần gọi API xóa từ xa -> xóa DB đồng bộ (<30ms) + dọn S3 ngầm
    if (remoteDeleteTargets.length === 0) {
      if (!contentDeleteRequested) {
        const localIds = [...(requestedPlatformPostIds ?? [])];
        if (localIds.length > 0) {
          await this.markPlatformPostsDeleted(workspaceId, postId, localIds);
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
            mediaCleanup,
          },
        });

        this.events?.publish(workspaceId, {
          type: 'posts.changed',
          contentPostId: postId,
        });

        return {
          deleted: false,
          queued: false,
          contentDeleted: false,
          platformOnlyDelete: true,
          remoteDeleteResults: [] as PlatformDeleteResult[],
          mediaCleanup,
        };
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
          remoteDeleteResults: [],
          mediaCleanup,
        },
      });

      this.events?.publish(workspaceId, {
        type: 'posts.changed',
        contentPostId: postId,
      });

      return {
        deleted: true,
        queued: false,
        contentDeleted: true,
        remoteDeleteResults: [] as PlatformDeleteResult[],
        mediaCleanup,
      };
    }

    // Trường hợp 2: Có target trên mạng xã hội cần xóa -> đưa vào queue 'delete-platform-post' (<50ms)
    const correlationId = auditContext.requestId ?? `post-delete:${postId}:${Date.now()}`;
    const remoteTargetIdSet = new Set(remoteDeleteTargets.map((item) => item.id));
    const localCleanupIds = contentDeleteRequested
      ? post.platformPosts
          .filter((item) => item.status !== 'DELETED' && !remoteTargetIdSet.has(item.id))
          .map((item) => item.id)
      : [...(requestedPlatformPostIds ?? [])].filter((id) => !remoteTargetIdSet.has(id));

    if (localCleanupIds.length > 0) {
      await this.markPlatformPostsDeleted(workspaceId, postId, localCleanupIds);
    }

    const queued = await this.prisma.$transaction(async (tx) => {
      const outboxEventIds: string[] = [];
      for (const target of remoteDeleteTargets) {
        const currentState = jsonObject(target.platformState) ?? {};
        await tx.platformPost.update({
          where: { id: target.id },
          data: {
            platformState: {
              ...currentState,
              pendingDelete: {
                state: 'QUEUED',
                deleteContentPostWhenDone: contentDeleteRequested,
                queuedAt: new Date().toISOString(),
              },
            } as unknown as Prisma.InputJsonValue,
          },
        });

        const latest = await tx.outboundOperation.findFirst({
          where: {
            operationType: 'DELETE_POST',
            resourceType: 'PlatformPost',
            resourceId: target.id,
          },
          orderBy: { operationGeneration: 'desc' },
          select: { operationGeneration: true },
        });
        const operation = await findOrCreateOutboundOperation(tx, {
          workspaceId,
          operationType: 'DELETE_POST',
          resourceType: 'PlatformPost',
          resourceId: target.id,
          operationGeneration: (latest?.operationGeneration ?? 0) + 1,
        });

        const payload: QueuePayload<'delete-platform-post'> = {
          platformPostId: target.id,
          contentPostId: postId,
          workspaceId,
          requestedByUserId: actorUserId,
          correlationId,
          operationId: operation.id,
          deleteContentPostWhenDone: contentDeleteRequested,
        };
        const jobId = buildJobId('delete-platform-post', payload);
        const opts = buildQueueJobOptions('delete-platform-post', jobId);

        await tx.backgroundJob.upsert({
          where: { queueName_jobId: { queueName: 'delete-platform-post', jobId } },
          create: {
            workspaceId,
            queueName: 'delete-platform-post',
            jobId,
            status: 'QUEUED',
            payload: payload as unknown as Prisma.InputJsonValue,
            attempts: 0,
            maxAttempts: opts.attempts,
            correlationId,
          },
          update: {
            workspaceId,
            status: 'QUEUED',
            payload: payload as unknown as Prisma.InputJsonValue,
            attempts: 0,
            maxAttempts: opts.attempts,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            errorCode: null,
            errorMessage: null,
            isDead: false,
            correlationId,
          },
        });

        const outboxEvent = await createQueueOutboxEvent(tx, {
          workspaceId,
          queueName: 'delete-platform-post',
          jobId,
          payload,
          options: opts,
          aggregateType: 'OutboundOperation',
          aggregateId: operation.id,
        });
        outboxEventIds.push(outboxEvent.id);
      }

      return { outboxEventIds };
    });

    await Promise.all(
      queued.outboxEventIds.map((outboxEventId) => this.dispatchPublishOutboxEvent(outboxEventId)),
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
        queued: true,
        queuedCount: remoteDeleteTargets.length,
        deleteContentPostWhenDone: contentDeleteRequested,
      },
    });

    this.events?.publish(workspaceId, {
      type: 'posts.changed',
      contentPostId: postId,
    });

    return {
      deleted: false,
      queued: true,
      queuedCount: remoteDeleteTargets.length,
      contentDeleted: false,
      platformOnlyDelete: !contentDeleteRequested,
      remoteDeleteResults: [] as PlatformDeleteResult[],
      mediaCleanup: { deleted: 0, skipped: candidateMediaAssetIds.length },
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
      queued?: boolean;
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
          results.push({ postId, deleted: true, queued: false });
        } else if (result.queued) {
          results.push({ postId, deleted: false, queued: true });
        } else {
          const failureSummary = summarizePlatformDeleteFailures(result.remoteDeleteResults);
          results.push({
            postId,
            deleted: false,
            queued: false,
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
          queued: false,
          errorCode: errorCodeForBulkDelete(error),
          errorMessage:
            error instanceof Error ? error.message : 'Lỗi không xác định khi xóa bài viết.',
        });
      }
    }

    const deleted = results.filter((item) => item.deleted).length;
    const queued = results.filter((item) => item.queued).length;
    const failed = results.length - deleted - queued;

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
        queued,
        failed,
        deleteFromPlatforms: input.deleteFromPlatforms,
      },
    });

    return {
      requested: uniquePostIds.length,
      deleted,
      queued,
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
          ...(post.storeId ? { storeId: post.storeId } : {}),
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

    this.events?.publish(workspaceId, {
      type: 'posts.changed',
      contentPostId: created.id,
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

  private async resolveOfflineAdapters(workspaceId: string) {
    if (typeof this.adapterFactory.offlineAdapters === 'function') {
      return this.adapterFactory.offlineAdapters();
    }
    return await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => adapters);
  }

  private async dispatchPublishOutboxEvent(outboxEventId: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event) return;
    const value = event.payload as unknown as {
      queueName:
        'publish-post' | 'retry-failed-post' | 'update-platform-post' | 'delete-platform-post';
      jobName:
        'publish-post' | 'retry-failed-post' | 'update-platform-post' | 'delete-platform-post';
      payload:
        | QueuePayload<'publish-post'>
        | QueuePayload<'retry-failed-post'>
        | QueuePayload<'update-platform-post'>
        | QueuePayload<'delete-platform-post'>;
      options: ReturnType<typeof buildQueueJobOptions>;
    };
    const queue =
      value.queueName === 'publish-post'
        ? this.publishQueue
        : value.queueName === 'retry-failed-post'
          ? this.retryQueue
          : value.queueName === 'update-platform-post'
            ? this.updateQueue
            : this.deleteQueue;
    const contentPostId =
      'contentPostId' in value.payload ? value.payload.contentPostId : undefined;
    try {
      await queue.add(value.jobName, value.payload, value.options);
      await this.prisma.outboxEvent.update({
        where: { id: outboxEventId },
        data: { dispatchedAt: new Date(), lastError: null },
      });
      this.events?.publish(value.payload.workspaceId, {
        type: 'job.queued',
        queueName: value.queueName,
        jobId: value.options.jobId,
        contentPostId,
        platformPostId: value.payload.platformPostId,
      });
      this.events?.publish(value.payload.workspaceId, {
        type: 'posts.changed',
        queueName: value.queueName,
        jobId: value.options.jobId,
        contentPostId,
        platformPostId: value.payload.platformPostId,
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
    expectedStoreId?: string | null,
  ): Promise<string | null | undefined> {
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

    let resolvedStoreId: string | null | undefined = expectedStoreId;

    if (accounts.length > 0) {
      const accountStoreKeys = new Set(
        accounts.map((a) => (a as { storeId?: string | null }).storeId ?? '__UNASSIGNED__'),
      );
      if (accountStoreKeys.size > 1) {
        throw AppError.validation(
          'Mỗi bài đăng chỉ được chọn các kênh thuộc cùng 1 Store duy nhất (không trộn nhiều Store hoặc kênh chưa gán Store).',
        );
      }

      const singleAccountStoreId = (accounts[0] as { storeId?: string | null }).storeId ?? null;

      if (expectedStoreId) {
        const mismatched = accounts.find(
          (account) =>
            ((account as { storeId?: string | null }).storeId ?? null) !== expectedStoreId,
        );
        if (mismatched) {
          const mismatchedStoreId = (mismatched as { storeId?: string | null }).storeId ?? null;
          if (!mismatchedStoreId) {
            throw AppError.validation(
              `Kênh "${mismatched.name}" chưa được gán vào Store. Vui lòng gán kênh vào Store trước khi đăng bài.`,
            );
          }
          throw AppError.validation(
            `Kênh "${mismatched.name}" thuộc một Store khác với Store đang chọn của bài đăng.`,
          );
        }
        resolvedStoreId = expectedStoreId;
      } else if (expectedStoreId === null && singleAccountStoreId) {
        throw AppError.validation(
          'Không thể gỡ Store khỏi bài đăng khi đang chọn kênh thuộc một Store.',
        );
      } else if (!singleAccountStoreId) {
        const workspaceStoreCount = tx.store?.count
          ? await tx.store.count({ where: { workspaceId } })
          : 0;
        if (workspaceStoreCount > 0) {
          throw AppError.validation(
            `Kênh "${accounts[0]?.name ?? ''}" chưa được gán vào Store nào. Vui lòng gán kênh vào Store trước khi thao tác.`,
          );
        }
        resolvedStoreId = null;
      } else {
        await tx.contentPost.update({
          where: { id: contentPostId },
          data: { storeId: singleAccountStoreId },
        });
        resolvedStoreId = singleAccountStoreId;
      }
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
          resolvedStoreId,
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

    return resolvedStoreId;
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
    expectedStoreId?: string | null,
  ): Promise<void> {
    const uniqueIds = await this.validateMediaAssetIds(
      tx,
      workspaceId,
      mediaAssetIds,
      expectedStoreId,
    );

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
    expectedStoreId?: string | null,
  ): Promise<string[]> {
    const uniqueIds = [...new Set(mediaAssetIds)];
    if (uniqueIds.length === 0) return [];
    const mediaAssets = await tx.mediaAsset.findMany({
      where: { id: { in: uniqueIds }, workspaceId, deletedAt: null, status: 'READY' },
    });
    if (mediaAssets.length !== uniqueIds.length) {
      throw AppError.validation('Một hoặc nhiều media asset chưa sẵn sàng hoặc không hợp lệ.');
    }
    if (expectedStoreId) {
      const foreignStoreMedia = mediaAssets.find(
        (asset) =>
          (asset as { storeId?: string | null }).storeId &&
          (asset as { storeId?: string | null }).storeId !== expectedStoreId,
      );
      if (foreignStoreMedia) {
        throw AppError.validation(
          'Không được gắn media thuộc Store khác vào bài đăng của Store này.',
        );
      }
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
        store: { select: { id: true, name: true, slug: true, color: true } },
        platformPosts: {
          include: {
            socialAccount: {
              include: {
                token: true,
                store: { select: { id: true, name: true, slug: true, color: true } },
              },
            },
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

    const platformPostIds = platformPosts.map((item) => item.id);
    const operations = this.prisma.outboundOperation?.findMany
      ? await this.prisma.outboundOperation.findMany({
          where: {
            workspaceId,
            resourceType: 'PlatformPost',
            resourceId: { in: platformPostIds },
          },
          select: { id: true },
          take: 100,
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const operationJobIds = operations.flatMap((op) => [
      `publish-post-outbound-${op.id}`,
      `retry-failed-post-outbound-${op.id}`,
      `update-platform-post-outbound-${op.id}`,
      `delete-platform-post-outbound-${op.id}`,
    ]);

    const legacyJobIds = platformPosts.flatMap((platformPost) => [
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
        queueName: {
          in: ['publish-post', 'retry-failed-post', 'update-platform-post', 'delete-platform-post'],
        },
        jobId: { in: [...new Set([...operationJobIds, ...legacyJobIds])] },
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

    const platformPostViews = await Promise.all(
      post.platformPosts.map(async (item) => {
        const localMedia = await Promise.all(
          item.media.map((media) => this.toMediaAssetView(media.mediaAsset, media.position)),
        );
        const effectiveMedia = localMedia.length > 0 ? localMedia : extractExternalMediaViews(item);
        return {
          id: item.id,
          platform: item.platform as Platform,
          status: item.status,
          socialAccountId: item.socialAccountId,
          socialAccountName: item.socialAccount.name,
          storeId: item.socialAccount.storeId ?? null,
          store:
            (
              item.socialAccount as {
                store?: { id: string; name: string; slug: string; color: string | null } | null;
              }
            ).store ?? null,
          caption: item.caption,
          title: item.title,
          description: item.description,
          linkUrl: item.linkUrl,
          options: item.options,
          media: effectiveMedia,
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
          commentCount: (item as { _count?: { comments?: number } })._count?.comments ?? 0,
        };
      }),
    );

    const postLocalMedia = await Promise.all(
      post.media.map((item) => this.toMediaAssetView(item.mediaAsset, item.position)),
    );
    const postEffectiveMedia =
      postLocalMedia.length > 0
        ? postLocalMedia
        : (platformPostViews.find((pp) => pp.media.length > 0)?.media ?? []);

    return {
      id: post.id,
      storeId: post.storeId ?? null,
      store:
        (
          post as {
            store?: { id: string; name: string; slug: string; color: string | null } | null;
          }
        ).store ?? null,
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
      derivedStatus:
        post.status === 'SCHEDULED' && platformStatuses.every((s) => s === 'PENDING')
          ? 'SCHEDULED'
          : deriveContentPostStatus(platformStatuses),
      platformPosts: platformPostViews,
      media: postEffectiveMedia,
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

    return await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
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
      },
      {
        storeId: platformPost.socialAccount.storeId ?? null,
        target: platformPost.platform as Platform,
      },
    );
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

    return await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
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
      },
      {
        storeId: platformPost.socialAccount.storeId ?? null,
        target: 'TIKTOK',
      },
    );
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

    return await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
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
      },
      {
        storeId: platformPost.socialAccount.storeId ?? null,
        target: 'YOUTUBE',
      },
    );
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

interface SynthesizedMediaAssetView {
  id: string;
  type: MediaType;
  status: string;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  position?: number;
  thumbnailUrl: string | null;
  readUrl: string | null;
  displayUrl: string | null;
}

function extractExternalMediaViews(item: {
  id: string;
  platform: string;
  externalPostId?: string | null;
  externalUrl?: string | null;
  externalRaw?: Prisma.JsonValue | null;
}): SynthesizedMediaAssetView[] {
  const raw = jsonObject(item.externalRaw);
  if (!raw) return [];

  const results: SynthesizedMediaAssetView[] = [];
  const pushItem = (
    index: number,
    spec: {
      type: MediaType;
      mimeType: string | null;
      thumbnailUrl: string | null;
      displayUrl: string | null;
      readUrl: string | null;
      width?: number | null;
      height?: number | null;
      durationSec?: number | null;
      fileName?: string | null;
    },
  ) => {
    if (!spec.thumbnailUrl && !spec.displayUrl && !spec.readUrl) return;
    results.push({
      id: `ext-media-${item.id}-${index}`,
      type: spec.type,
      status: 'READY',
      originalFileName:
        spec.fileName ??
        `${item.platform.toLowerCase()}-${item.externalPostId ?? item.id}-${index + 1}`,
      mimeType: spec.mimeType,
      sizeBytes: null,
      width: spec.width ?? null,
      height: spec.height ?? null,
      durationSec: spec.durationSec ?? null,
      position: index,
      thumbnailUrl: spec.thumbnailUrl,
      displayUrl: spec.displayUrl ?? spec.thumbnailUrl,
      readUrl: spec.readUrl ?? spec.displayUrl ?? spec.thumbnailUrl,
    });
  };

  if (item.platform === 'FACEBOOK') {
    const attachments = jsonObject(raw.attachments);
    const dataArr = Array.isArray(attachments?.data) ? attachments.data : [];
    const main = jsonObject(dataArr[0]);
    if (main) {
      const subObj = jsonObject(main.subattachments);
      const subArr = Array.isArray(subObj?.data) ? subObj.data : [];
      const candidates = subArr.length > 0 ? subArr : [main];
      candidates.forEach((candRaw, idx) => {
        const cand = jsonObject(candRaw);
        const media = jsonObject(cand?.media);
        const image = jsonObject(media?.image);
        const imageSrc = typeof image?.src === 'string' ? image.src : null;
        const videoSrc = typeof media?.source === 'string' ? media.source : null;
        const candType = typeof cand?.type === 'string' ? cand.type.toLowerCase() : '';
        const isVideo = candType.includes('video') || Boolean(videoSrc);
        const width = typeof image?.width === 'number' ? image.width : null;
        const height = typeof image?.height === 'number' ? image.height : null;
        pushItem(idx, {
          type: isVideo ? 'VIDEO' : 'IMAGE',
          mimeType: isVideo ? (videoSrc ? 'video/mp4' : 'image/jpeg') : 'image/jpeg',
          thumbnailUrl: imageSrc,
          displayUrl: videoSrc ?? imageSrc,
          readUrl:
            videoSrc ??
            imageSrc ??
            (typeof cand?.url === 'string' ? cand.url : (item.externalUrl ?? null)),
          width,
          height,
        });
      });
    }
    return results;
  }

  if (item.platform === 'INSTAGRAM') {
    const mediaType = typeof raw.media_type === 'string' ? raw.media_type.toUpperCase() : 'IMAGE';
    const mediaUrl = typeof raw.media_url === 'string' ? raw.media_url : null;
    const thumbUrl = typeof raw.thumbnail_url === 'string' ? raw.thumbnail_url : mediaUrl;
    const isVideo = mediaType === 'VIDEO';
    pushItem(0, {
      type: isVideo ? 'VIDEO' : 'IMAGE',
      mimeType: isVideo ? (mediaUrl ? 'video/mp4' : 'image/jpeg') : 'image/jpeg',
      thumbnailUrl: thumbUrl,
      displayUrl: mediaUrl ?? thumbUrl,
      readUrl: mediaUrl ?? thumbUrl ?? item.externalUrl ?? null,
    });
    return results;
  }

  if (item.platform === 'YOUTUBE') {
    const snippet = jsonObject(raw.snippet);
    const resourceId = jsonObject(snippet?.resourceId);
    const videoId =
      (typeof resourceId?.videoId === 'string' ? resourceId.videoId : null) ??
      (typeof raw.id === 'string' ? raw.id : null) ??
      item.externalPostId ??
      null;
    const thumbs = jsonObject(snippet?.thumbnails);
    const pickedThumb =
      jsonObject(thumbs?.maxres) ??
      jsonObject(thumbs?.standard) ??
      jsonObject(thumbs?.high) ??
      jsonObject(thumbs?.medium) ??
      jsonObject(thumbs?.default);
    const thumbUrl =
      (typeof pickedThumb?.url === 'string' ? pickedThumb.url : null) ??
      (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);
    const watchUrl = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : (item.externalUrl ?? null);
    pushItem(0, {
      type: 'VIDEO',
      mimeType: 'video/youtube',
      thumbnailUrl: thumbUrl,
      displayUrl: watchUrl ?? thumbUrl,
      readUrl: watchUrl ?? thumbUrl,
      width: typeof pickedThumb?.width === 'number' ? pickedThumb.width : null,
      height: typeof pickedThumb?.height === 'number' ? pickedThumb.height : null,
      fileName: typeof snippet?.title === 'string' ? snippet.title : null,
    });
    return results;
  }

  if (item.platform === 'PINTEREST') {
    const media = jsonObject(raw.media);
    const images = jsonObject(media?.images);
    const pickedVariant =
      jsonObject(images?.['1200x']) ??
      jsonObject(images?.['600x']) ??
      jsonObject(images?.['400x300']) ??
      jsonObject(images?.['150x150']) ??
      (images ? jsonObject(Object.values(images)[0]) : undefined);
    const thumbUrl = typeof pickedVariant?.url === 'string' ? pickedVariant.url : null;
    const videoUrl = typeof media?.video_url === 'string' ? media.video_url : null;
    const mediaType = `${typeof media?.media_type === 'string' ? media.media_type : ''} ${
      typeof raw.creative_type === 'string' ? raw.creative_type : ''
    }`.toLowerCase();
    const isVideo = mediaType.includes('video') || Boolean(videoUrl);
    pushItem(0, {
      type: isVideo ? 'VIDEO' : 'IMAGE',
      mimeType: isVideo ? (videoUrl ? 'video/mp4' : 'image/jpeg') : 'image/jpeg',
      thumbnailUrl: thumbUrl,
      displayUrl: videoUrl ?? thumbUrl,
      readUrl: videoUrl ?? thumbUrl ?? item.externalUrl ?? null,
      width: typeof pickedVariant?.width === 'number' ? pickedVariant.width : null,
      height: typeof pickedVariant?.height === 'number' ? pickedVariant.height : null,
      fileName: typeof raw.title === 'string' ? raw.title : null,
    });
    return results;
  }

  if (item.platform === 'TIKTOK') {
    const thumbUrl = typeof raw.cover_image_url === 'string' ? raw.cover_image_url : null;
    const shareUrl = typeof raw.share_url === 'string' ? raw.share_url : (item.externalUrl ?? null);
    pushItem(0, {
      type: 'VIDEO',
      mimeType: 'image/jpeg',
      thumbnailUrl: thumbUrl,
      displayUrl: thumbUrl ?? shareUrl,
      readUrl: shareUrl ?? thumbUrl,
      width: typeof raw.width === 'number' ? raw.width : null,
      height: typeof raw.height === 'number' ? raw.height : null,
      durationSec: typeof raw.duration === 'number' ? raw.duration : null,
      fileName: typeof raw.title === 'string' ? raw.title : null,
    });
    return results;
  }

  return results;
}
