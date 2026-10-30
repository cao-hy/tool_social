import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { createQueueOutboxEvent, findOrCreateOutboundOperation, type Prisma } from '@socialhub/db';
import {
  buildJobId,
  buildQueueJobOptions,
  workspaceRealtimeChannel,
  type QueuePayload,
  type WorkspaceRealtimeEvent,
} from '@socialhub/shared';
import type { Platform } from '@socialhub/shared';
import { type Keyring } from '@socialhub/security';
import { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { KEYRING } from '../../infrastructure/infrastructure.module';
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import type {
  AddCommentNoteInput,
  AssignCommentInput,
  BulkCreatePlatformCommentInput,
  BulkModerateCommentsInput,
  BulkReplyToCommentsInput,
  BulkSyncCommentsInput,
  CreateCommentTagInput,
  CreatePlatformCommentInput,
  CreateReplyTemplateInput,
  DeleteCommentQuery,
  ListCommentsQuery,
  ReplyToCommentInput,
  SyncCommentsInput,
  UpdateCommentMessageInput,
  UpdateCommentStatusInput,
  UpdateCommentTagsInput,
  UpdateCommentVisibilityInput,
  UpdateReplyTemplateInput,
} from './comments.schemas';

export interface BulkQueueResult {
  id: string;
  queued: boolean;
  jobId?: string;
  backgroundJobId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface BulkModerateCommentItemResult {
  id: string;
  processed: boolean;
  queued: boolean;
  localOnly?: boolean;
  skippedByParent?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

const BULK_MODERATE_ACCOUNT_STAGGER_MS = 900;
const BULK_SYNC_ACCOUNT_STAGGER_MS = 400;

@Injectable()
export class CommentsService implements OnModuleDestroy {
  private readonly syncQueue: Queue;
  private readonly createPlatformCommentQueue: Queue;
  private readonly replyPlatformCommentQueue: Queue;
  private readonly moderatePlatformCommentQueue: Queue;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
    @Inject(KEYRING) _keyring: Keyring,
    @Optional() @Inject(EventsService) private readonly events?: EventsService,
  ) {
    this.syncQueue = new Queue('sync-comments', { connection: this.redis.getClient() });
    this.createPlatformCommentQueue = new Queue('create-platform-comment', {
      connection: this.redis.getClient(),
    });
    this.replyPlatformCommentQueue = new Queue('reply-platform-comment', {
      connection: this.redis.getClient(),
    });
    this.moderatePlatformCommentQueue = new Queue('moderate-platform-comment', {
      connection: this.redis.getClient(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.syncQueue.close();
    await this.createPlatformCommentQueue.close();
    await this.replyPlatformCommentQueue.close();
    await this.moderatePlatformCommentQueue.close();
  }

  async list(workspaceId: string, query: ListCommentsQuery) {
    const parsedPostIds = query.platformPostIds
      ? [
          ...new Set(
            query.platformPostIds
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ].slice(0, 200)
      : [];
    const mergedPostIds =
      parsedPostIds.length > 0
        ? query.platformPostId
          ? [...new Set([...parsedPostIds, query.platformPostId])]
          : parsedPostIds
        : null;

    const where: Prisma.CommentWhereInput = {
      workspaceId,
      deletedAt: null,
      status: query.status,
      platform: query.platform,
      socialAccountId: query.socialAccountId,
      platformPostId: mergedPostIds ? { in: mergedPostIds } : query.platformPostId,
      isFromPage:
        query.authorSource === 'PAGE' ? true : query.authorSource === 'VIEWER' ? false : undefined,
      platformPost: query.contentPostId ? { contentPostId: query.contentPostId } : undefined,
      socialAccount:
        query.storeId === 'UNASSIGNED'
          ? { storeId: null }
          : query.storeId
            ? { storeId: query.storeId }
            : undefined,
      assignment: query.assignedToId ? { assignedToId: query.assignedToId } : undefined,
      tags: query.tagId ? { some: { tagId: query.tagId } } : undefined,
      OR: query.q
        ? [
            { message: { contains: query.q, mode: 'insensitive' } },
            { authorName: { contains: query.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const comments = await this.prisma.comment.findMany({
      where,
      include: this.commentInclude(),
      orderBy: { postedAt: 'desc' },
      take: query.limit,
    });

    return { items: comments.map((comment) => this.toCommentView(comment)) };
  }

  async get(workspaceId: string, commentId: string) {
    return this.toCommentView(await this.findComment(workspaceId, commentId));
  }

  async updateStatus(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: UpdateCommentStatusInput,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    const updated = await this.prisma.comment.update({
      where: { id: comment.id },
      data: { status: input.status },
      include: this.commentInclude(),
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'Comment',
      resourceId: comment.id,
      before: { status: comment.status },
      after: { status: input.status },
    });

    this.events?.publish(workspaceId, {
      type: 'comments.synced',
      commentId: comment.id,
      platformPostId: comment.platformPostId,
    });

    return this.toCommentView(updated);
  }

  async assign(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: AssignCommentInput,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);

    if (input.memberId === null) {
      await this.prisma.commentAssignment.deleteMany({
        where: { commentId: comment.id, workspaceId },
      });
      return this.get(workspaceId, comment.id);
    }

    const member = await this.prisma.workspaceMember.findFirst({
      where: { id: input.memberId, workspaceId },
    });
    if (!member) throw AppError.notFound('member');

    await this.prisma.commentAssignment.upsert({
      where: { commentId: comment.id },
      create: {
        workspaceId,
        commentId: comment.id,
        memberId: member.id,
        assignedToId: member.userId,
        assignedById: actorUserId,
      },
      update: {
        memberId: member.id,
        assignedToId: member.userId,
        assignedById: actorUserId,
        assignedAt: new Date(),
        resolvedAt: null,
      },
    });

    const createdNotification = await this.prisma.notification.create({
      data: {
        workspaceId,
        userId: member.userId,
        type: 'COMMENT_ASSIGNED',
        title: 'Bạn được gán một comment',
        body: comment.message?.slice(0, 160) ?? 'Comment không có nội dung.',
        linkUrl: '/inbox',
        data: { commentId: comment.id },
      },
    });
    this.events?.publish(workspaceId, {
      type: 'notification.created',
      notificationId: createdNotification.id,
      commentId: comment.id,
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_REPLIED',
      resourceType: 'CommentAssignment',
      resourceId: comment.id,
      metadata: { assignedToId: member.userId },
    });

    return this.get(workspaceId, comment.id);
  }

  async listTags(workspaceId: string) {
    const tags = await this.prisma.commentTag.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
    return { items: tags };
  }

  async createTag(workspaceId: string, input: CreateCommentTagInput) {
    const tag = await this.prisma.commentTag.upsert({
      where: { workspaceId_name: { workspaceId, name: input.name } },
      create: { workspaceId, name: input.name, color: input.color },
      update: { color: input.color },
    });
    return tag;
  }

  async updateTags(workspaceId: string, commentId: string, input: UpdateCommentTagsInput) {
    const comment = await this.findComment(workspaceId, commentId);
    const tags = await this.prisma.commentTag.findMany({
      where: { workspaceId, id: { in: input.tagIds } },
    });
    if (tags.length !== new Set(input.tagIds).size) {
      throw AppError.validation('Một hoặc nhiều tag không thuộc workspace này.');
    }

    await this.prisma.$transaction([
      this.prisma.commentTagOnComment.deleteMany({ where: { commentId: comment.id } }),
      ...tags.map((tag) =>
        this.prisma.commentTagOnComment.create({
          data: { commentId: comment.id, tagId: tag.id },
        }),
      ),
    ]);

    this.events?.publish(workspaceId, {
      type: 'comments.synced',
      commentId: comment.id,
      platformPostId: comment.platformPostId,
    });

    return this.get(workspaceId, comment.id);
  }

  async updateMessage(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: UpdateCommentMessageInput,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    const before = { message: comment.message };

    if (!input.updatePlatform) {
      const updated = await this.prisma.comment.update({
        where: { id: comment.id },
        data: { message: input.message },
        include: this.commentInclude(),
      });

      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'POST_UPDATED',
        resourceType: 'Comment',
        resourceId: comment.id,
        before,
        after: { message: input.message, updatePlatform: false },
      });

      this.events?.publish(workspaceId, {
        type: 'comments.synced',
        commentId: comment.id,
        platformPostId: comment.platformPostId,
      });

      return this.toCommentView(updated);
    }

    if (!comment.isFromPage) {
      throw AppError.conflict(
        'Chỉ sửa được comment/reply do page hoặc channel của bạn gửi. Comment của khách không thể sửa.',
      );
    }

    await this.ensureOfflineCommentCapability(workspaceId, comment, 'editComment');

    const correlationId = auditContext.requestId ?? `comment-edit:${comment.id}:${Date.now()}`;
    const queued = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.comment.update({
        where: { id: comment.id },
        data: { message: input.message },
        include: this.commentInclude(),
      });

      const outboxEventId = await this.enqueueModerateCommentTx(tx, {
        workspaceId,
        comment,
        actorUserId,
        correlationId,
        action: 'EDIT_MESSAGE',
        message: input.message,
        previousMessage: comment.message,
      });

      return { updated, outboxEventId };
    });

    await this.dispatchCommentOutboxEvent(queued.outboxEventId);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'POST_UPDATED',
      resourceType: 'Comment',
      resourceId: comment.id,
      before,
      after: { message: input.message, updatePlatform: true, queued: true },
    });

    this.events?.publish(workspaceId, {
      type: 'comments.synced',
      commentId: comment.id,
      platformPostId: comment.platformPostId,
    });

    return this.toCommentView(queued.updated);
  }

  async updateVisibility(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: UpdateCommentVisibilityInput,
    auditContext: AuditContext,
    options?: { delayMs?: number },
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    if (comment.isFromPage && comment.platform !== 'YOUTUBE') {
      throw AppError.validation(
        'Bình luận do chính Page/Kênh đăng không hỗ trợ Ẩn trên MXH (hãy chọn chế độ Xóa).',
      );
    }
    await this.ensureOfflineCommentCapability(workspaceId, comment, 'hideComment');

    const correlationId = auditContext.requestId ?? `comment-hide:${comment.id}:${Date.now()}`;
    const queued = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.comment.update({
        where: { id: comment.id },
        data: { isHidden: input.hidden },
        include: this.commentInclude(),
      });

      const outboxEventId = await this.enqueueModerateCommentTx(tx, {
        workspaceId,
        comment,
        actorUserId,
        correlationId,
        action: 'SET_VISIBILITY',
        hidden: input.hidden,
        previousHidden: comment.isHidden,
        delayMs: options?.delayMs,
      });

      return { updated, outboxEventId };
    });

    await this.dispatchCommentOutboxEvent(queued.outboxEventId);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_HIDDEN',
      resourceType: 'Comment',
      resourceId: comment.id,
      before: { isHidden: comment.isHidden },
      after: { isHidden: input.hidden, queued: true },
    });

    this.events?.publish(workspaceId, {
      type: 'comments.synced',
      commentId: comment.id,
      platformPostId: comment.platformPostId,
    });

    return this.toCommentView(queued.updated);
  }

  async deleteComment(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: DeleteCommentQuery,
    auditContext: AuditContext,
    options?: { delayMs?: number },
  ) {
    const comment = await this.findComment(workspaceId, commentId);

    if (!input.deleteFromPlatform) {
      const deletedAt = new Date();
      await this.prisma.comment.updateMany({
        where: {
          workspaceId,
          deletedAt: null,
          OR: [{ id: comment.id }, { parentId: comment.id }],
        },
        data: { deletedAt },
      });

      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'COMMENT_DELETED',
        resourceType: 'Comment',
        resourceId: comment.id,
        metadata: { deleteFromPlatform: false },
      });

      this.events?.publish(workspaceId, {
        type: 'comments.synced',
        commentId: comment.id,
        platformPostId: comment.platformPostId,
      });
      this.events?.publish(workspaceId, {
        type: 'posts.changed',
        contentPostId: comment.platformPost.contentPostId,
        platformPostId: comment.platformPostId,
      });

      return { deleted: true, queued: false };
    }

    const usesModerationDelete = comment.platform === 'YOUTUBE' && !comment.isFromPage;
    const action = usesModerationDelete ? 'hideComment' : 'deleteComment';
    await this.ensureOfflineCommentCapability(workspaceId, comment, action);

    const correlationId = auditContext.requestId ?? `comment-delete:${comment.id}:${Date.now()}`;
    const deletedAt = new Date();
    const outboxEventId = await this.prisma.$transaction(async (tx) => {
      await tx.comment.updateMany({
        where: {
          workspaceId,
          deletedAt: null,
          OR: [{ id: comment.id }, { parentId: comment.id }],
        },
        data: { deletedAt },
      });

      return await this.enqueueModerateCommentTx(tx, {
        workspaceId,
        comment,
        actorUserId,
        correlationId,
        action: 'DELETE_COMMENT',
        delayMs: options?.delayMs,
      });
    });

    await this.dispatchCommentOutboxEvent(outboxEventId);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_DELETED',
      resourceType: 'Comment',
      resourceId: comment.id,
      metadata: { deleteFromPlatform: true, queued: true },
    });

    this.events?.publish(workspaceId, {
      type: 'comments.synced',
      commentId: comment.id,
      platformPostId: comment.platformPostId,
    });
    this.events?.publish(workspaceId, {
      type: 'posts.changed',
      contentPostId: comment.platformPost.contentPostId,
      platformPostId: comment.platformPostId,
    });

    return { deleted: true, queued: true };
  }

  async addNote(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: AddCommentNoteInput,
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    const note = await this.prisma.commentNote.create({
      data: {
        workspaceId,
        commentId: comment.id,
        authorId: actorUserId,
        body: input.body,
      },
      include: { author: true },
    });
    this.events?.publish(workspaceId, {
      type: 'comments.synced',
      platformPostId: comment.platformPostId,
      contentPostId: comment.platformPost.contentPostId,
    });
    return {
      id: note.id,
      body: note.body,
      authorId: note.authorId,
      authorName: note.author.name,
      authorEmail: note.author.email,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  async reply(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: ReplyToCommentInput,
    auditContext: AuditContext,
  ) {
    return this.queueReplyToComment(
      workspaceId,
      commentId,
      actorUserId,
      input.message,
      auditContext,
    );
  }

  async createPlatformComment(
    workspaceId: string,
    platformPostId: string,
    actorUserId: string,
    input: CreatePlatformCommentInput,
    auditContext: AuditContext,
  ) {
    const platformPost = await this.prisma.platformPost.findFirst({
      where: { id: platformPostId, workspaceId },
      include: { socialAccount: { include: { token: true } }, contentPost: true },
    });
    if (!platformPost) throw AppError.notFound('platform post');
    if (platformPost.status !== 'PUBLISHED' || !platformPost.externalPostId) {
      throw AppError.conflict('Chỉ comment được vào bản đăng đã publish và có external ID.');
    }
    if (!platformPost.socialAccount.token || platformPost.socialAccount.status !== 'CONNECTED') {
      throw AppError.conflict('Social account chưa kết nối.');
    }

    if (typeof this.adapterFactory.offlineAdapters === 'function') {
      const adapter = this.adapterFactory
        .offlineAdapters()
        .requireCapability(platformPost.platform, 'createComment');
      if (!adapter.createComment) {
        throw AppError.capabilityUnsupported(platformPost.platform, 'createComment');
      }
      this.ensureCreateCommentScopes(platformPost);
    } else {
      await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
        const adapter = adapters.requireCapability(platformPost.platform, 'createComment');
        if (!adapter.createComment) {
          throw AppError.capabilityUnsupported(platformPost.platform, 'createComment');
        }
        this.ensureCreateCommentScopes(platformPost);
      });
    }

    const correlationId =
      auditContext.requestId ?? `comment-create:${platformPost.id}:${Date.now()}`;
    const queued = await this.prisma.$transaction(async (tx) => {
      const command = input.clientRequestId
        ? await tx.commentCreateCommand.upsert({
            where: {
              workspaceId_clientRequestId: {
                workspaceId,
                clientRequestId: input.clientRequestId,
              },
            },
            create: {
              workspaceId,
              platformPostId: platformPost.id,
              requestedByUserId: actorUserId,
              clientRequestId: input.clientRequestId,
              message: input.message,
            },
            update: {},
          })
        : await tx.commentCreateCommand.create({
            data: {
              workspaceId,
              platformPostId: platformPost.id,
              requestedByUserId: actorUserId,
              message: input.message,
            },
          });

      if (
        command.platformPostId !== platformPost.id ||
        command.requestedByUserId !== actorUserId ||
        command.message !== input.message
      ) {
        throw AppError.conflict('Idempotency key đã được dùng cho comment khác.');
      }

      const operation = await findOrCreateOutboundOperation(tx, {
        workspaceId,
        operationType: 'CREATE_COMMENT',
        resourceType: 'CommentCreateCommand',
        resourceId: command.id,
        operationGeneration: 1,
      });
      const payload: QueuePayload<'create-platform-comment'> = {
        commandId: command.id,
        platformPostId: platformPost.id,
        socialAccountId: platformPost.socialAccountId,
        workspaceId,
        message: input.message,
        requestedByUserId: actorUserId,
        correlationId,
        operationId: operation.id,
      };
      const jobId = buildJobId('create-platform-comment', payload);
      const opts = buildQueueJobOptions('create-platform-comment', jobId);
      const backgroundJob = await tx.backgroundJob.upsert({
        where: { queueName_jobId: { queueName: 'create-platform-comment', jobId } },
        create: {
          workspaceId,
          queueName: 'create-platform-comment',
          jobId,
          status: 'QUEUED',
          payload: payload as Prisma.InputJsonValue,
          attempts: 0,
          maxAttempts: opts.attempts,
          correlationId,
        },
        update: {
          workspaceId,
          status: 'QUEUED',
          payload: payload as Prisma.InputJsonValue,
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
        queueName: 'create-platform-comment',
        jobId,
        payload,
        options: opts,
        aggregateType: 'OutboundOperation',
        aggregateId: operation.id,
      });
      return { jobId, backgroundJob, outboxEventId: outboxEvent.id };
    });

    await this.dispatchCommentOutboxEvent(queued.outboxEventId);
    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_REPLIED',
      resourceType: 'PlatformPost',
      resourceId: platformPost.id,
      metadata: {
        action: 'createPlatformComment',
        platform: platformPost.platform,
        socialAccountId: platformPost.socialAccountId,
      },
    });

    return {
      queued: true,
      jobId: queued.jobId,
      backgroundJobId: queued.backgroundJob.id,
      message: 'Đã đưa comment công khai vào queue.',
    };
  }

  async bulkCreatePlatformComments(
    workspaceId: string,
    actorUserId: string,
    input: BulkCreatePlatformCommentInput,
    auditContext: AuditContext,
  ) {
    const platformPostIds = [...new Set(input.platformPostIds)];
    if (platformPostIds.length > 1 && this.prisma.platformPost?.findMany) {
      const targetPosts = await this.prisma.platformPost.findMany({
        where: { id: { in: platformPostIds }, workspaceId },
        select: {
          id: true,
          socialAccount: { select: { storeId: true } },
          contentPost: { select: { storeId: true } },
        },
      });
      const resolvedStoreKeys = new Set(
        targetPosts.map(
          (item) => item.socialAccount?.storeId ?? item.contentPost?.storeId ?? '__UNASSIGNED__',
        ),
      );
      if (resolvedStoreKeys.size > 1) {
        throw AppError.validation(
          'Mỗi thao tác bình luận hàng loạt chỉ được thực hiện trên các bài thuộc cùng 1 Store duy nhất.',
        );
      }
    }
    const results: BulkQueueResult[] = [];

    for (const platformPostId of platformPostIds) {
      try {
        const queued = await this.createPlatformComment(
          workspaceId,
          platformPostId,
          actorUserId,
          { message: input.message },
          {
            ...auditContext,
            requestId: `${auditContext.requestId ?? 'bulk-comment'}:${platformPostId}`,
          },
        );
        results.push({
          id: platformPostId,
          queued: true,
          jobId: queued.jobId,
          backgroundJobId: queued.backgroundJobId,
        });
      } catch (error) {
        results.push({
          id: platformPostId,
          queued: false,
          errorCode:
            error instanceof AppError
              ? error.code
              : error instanceof Error
                ? error.name
                : 'UNKNOWN',
          errorMessage:
            error instanceof Error ? error.message : 'Không thể queue comment cho target này.',
        });
      }
    }

    return this.toBulkQueueSummary(platformPostIds.length, results);
  }

  async bulkReplyToComments(
    workspaceId: string,
    actorUserId: string,
    input: BulkReplyToCommentsInput,
    auditContext: AuditContext,
  ) {
    const commentIds = [...new Set(input.commentIds)];
    if (commentIds.length > 1 && this.prisma.comment?.findMany) {
      const targetComments = await this.prisma.comment.findMany({
        where: { id: { in: commentIds }, workspaceId, deletedAt: null },
        select: {
          id: true,
          socialAccount: { select: { storeId: true } },
        },
      });
      const resolvedStoreKeys = new Set(
        targetComments.map((item) => item.socialAccount?.storeId ?? '__UNASSIGNED__'),
      );
      if (resolvedStoreKeys.size > 1) {
        throw AppError.validation(
          'Mỗi thao tác trả lời bình luận hàng loạt chỉ được thực hiện trên 1 Store duy nhất.',
        );
      }
    }
    const results: BulkQueueResult[] = [];

    for (const commentId of commentIds) {
      try {
        const queued = await this.queueReplyToComment(
          workspaceId,
          commentId,
          actorUserId,
          input.message,
          {
            ...auditContext,
            requestId: `${auditContext.requestId ?? 'bulk-reply'}:${commentId}`,
          },
        );
        results.push({
          id: commentId,
          queued: true,
          jobId: queued.jobId,
          backgroundJobId: queued.backgroundJobId,
        });
      } catch (error) {
        results.push({
          id: commentId,
          queued: false,
          errorCode:
            error instanceof AppError
              ? error.code
              : error instanceof Error
                ? error.name
                : 'UNKNOWN',
          errorMessage:
            error instanceof Error ? error.message : 'Không thể queue reply cho comment này.',
        });
      }
    }

    return this.toBulkQueueSummary(commentIds.length, results);
  }

  async bulkModerateComments(
    workspaceId: string,
    actorUserId: string,
    input: BulkModerateCommentsInput,
    auditContext: AuditContext,
  ) {
    const commentIds = [...new Set(input.commentIds)];
    const targetComments = await this.prisma.comment.findMany({
      where: { id: { in: commentIds }, workspaceId, deletedAt: null },
      select: {
        id: true,
        parentId: true,
        isFromPage: true,
        isHidden: true,
        platform: true,
        socialAccountId: true,
        socialAccount: { select: { storeId: true } },
      },
    });

    if (targetComments.length > 1) {
      const resolvedStoreKeys = new Set(
        targetComments.map((item) => item.socialAccount?.storeId ?? '__UNASSIGNED__'),
      );
      if (resolvedStoreKeys.size > 1) {
        throw AppError.validation(
          'Mỗi thao tác dọn/xóa bình luận hàng loạt chỉ được thực hiện trên 1 Store duy nhất.',
        );
      }
    }

    const foundById = new Map(targetComments.map((item) => [item.id, item]));
    const isDeleteAction =
      input.action === 'DELETE_FROM_PLATFORM' || input.action === 'DELETE_LOCAL_ONLY';

    // Ưu tiên xử lý comment gốc (parentId == null) trước để khử trùng comment con chính xác
    const orderedIds = [...commentIds].sort((a, b) => {
      const ca = foundById.get(a);
      const cb = foundById.get(b);
      const aIsChild = Boolean(ca?.parentId);
      const bIsChild = Boolean(cb?.parentId);
      if (aIsChild === bIsChild) return 0;
      return aIsChild ? 1 : -1;
    });

    const deletedOrQueuedParentIds = new Set<string>();
    const accountSlotByAccountId = new Map<string, number>();
    const resultById = new Map<string, BulkModerateCommentItemResult>();

    for (const commentId of orderedIds) {
      const meta = foundById.get(commentId);
      if (!meta) {
        resultById.set(commentId, {
          id: commentId,
          processed: false,
          queued: false,
          errorCode: 'NOT_FOUND',
          errorMessage: 'Bình luận không tồn tại hoặc đã được xóa trước đó.',
        });
        continue;
      }

      if (isDeleteAction && meta.parentId && deletedOrQueuedParentIds.has(meta.parentId)) {
        resultById.set(commentId, {
          id: commentId,
          processed: true,
          queued: false,
          skippedByParent: true,
        });
        continue;
      }

      const currentSlot = accountSlotByAccountId.get(meta.socialAccountId) ?? 0;
      const delayMs = currentSlot * BULK_MODERATE_ACCOUNT_STAGGER_MS;
      const itemAudit: AuditContext = {
        ...auditContext,
        requestId: `${auditContext.requestId ?? 'bulk-moderate'}:${commentId}`,
      };

      try {
        if (input.action === 'DELETE_FROM_PLATFORM') {
          const res = await this.deleteComment(
            workspaceId,
            commentId,
            actorUserId,
            { deleteFromPlatform: true },
            itemAudit,
            { delayMs },
          );
          if (res.queued) {
            accountSlotByAccountId.set(meta.socialAccountId, currentSlot + 1);
          }
          if (!meta.parentId) {
            deletedOrQueuedParentIds.add(commentId);
          }
          resultById.set(commentId, {
            id: commentId,
            processed: true,
            queued: Boolean(res.queued),
          });
        } else if (input.action === 'DELETE_LOCAL_ONLY') {
          await this.deleteComment(
            workspaceId,
            commentId,
            actorUserId,
            { deleteFromPlatform: false },
            itemAudit,
          );
          if (!meta.parentId) {
            deletedOrQueuedParentIds.add(commentId);
          }
          resultById.set(commentId, {
            id: commentId,
            processed: true,
            queued: false,
            localOnly: true,
          });
        } else {
          const targetHidden = input.action === 'HIDE_ON_PLATFORM';
          if (meta.isHidden === targetHidden) {
            resultById.set(commentId, {
              id: commentId,
              processed: true,
              queued: false,
              localOnly: true,
            });
            continue;
          }
          await this.updateVisibility(
            workspaceId,
            commentId,
            actorUserId,
            { hidden: targetHidden },
            itemAudit,
            { delayMs },
          );
          accountSlotByAccountId.set(meta.socialAccountId, currentSlot + 1);
          resultById.set(commentId, {
            id: commentId,
            processed: true,
            queued: true,
          });
        }
      } catch (error) {
        resultById.set(commentId, {
          id: commentId,
          processed: false,
          queued: false,
          errorCode:
            error instanceof AppError
              ? error.code
              : error instanceof Error
                ? error.name
                : 'UNKNOWN',
          errorMessage: error instanceof Error ? error.message : 'Không thể xử lý bình luận này.',
        });
      }
    }

    const results = commentIds.map(
      (id) =>
        resultById.get(id) ?? {
          id,
          processed: false,
          queued: false,
          errorCode: 'UNKNOWN',
          errorMessage: 'Không tìm thấy kết quả xử lý.',
        },
    );

    const processed = results.filter((r) => r.processed).length;
    const queued = results.filter((r) => r.queued).length;
    const localOnly = results.filter((r) => r.localOnly).length;
    const skippedByParent = results.filter((r) => r.skippedByParent).length;
    const failed = results.length - processed;

    return {
      requested: commentIds.length,
      processed,
      queued,
      localOnly,
      skippedByParent,
      failed,
      results,
    };
  }

  private async queueReplyToComment(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    message: string,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    if (typeof this.adapterFactory.offlineAdapters === 'function') {
      const adapter = this.adapterFactory
        .offlineAdapters()
        .requireCapability(comment.platform, 'replyToComment');
      if (!adapter.replyToComment) {
        throw AppError.capabilityUnsupported(comment.platform, 'replyToComment');
      }
      this.ensureReplyCommentScopes(comment);
    } else {
      await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
        const adapter = adapters.requireCapability(comment.platform, 'replyToComment');
        if (!adapter.replyToComment) {
          throw AppError.capabilityUnsupported(comment.platform, 'replyToComment');
        }
        this.ensureReplyCommentScopes(comment);
      });
    }

    const queued = await this.prisma.$transaction(async (tx) => {
      const reply = await tx.commentReply.create({
        data: { workspaceId, commentId: comment.id, message, sentById: actorUserId },
      });
      const operation = await findOrCreateOutboundOperation(tx, {
        workspaceId,
        operationType: 'REPLY_COMMENT',
        resourceType: 'CommentReply',
        resourceId: reply.id,
        operationGeneration: 1,
      });
      const payload: QueuePayload<'reply-platform-comment'> = {
        commentId: comment.id,
        workspaceId,
        message,
        requestedByUserId: actorUserId,
        replyRecordId: reply.id,
        correlationId: auditContext.requestId ?? `comment-reply:${reply.id}`,
        operationId: operation.id,
      };
      const jobId = buildJobId('reply-platform-comment', payload);
      const opts = buildQueueJobOptions('reply-platform-comment', jobId);
      const backgroundJob = await tx.backgroundJob.upsert({
        where: { queueName_jobId: { queueName: 'reply-platform-comment', jobId } },
        create: {
          workspaceId,
          queueName: 'reply-platform-comment',
          jobId,
          status: 'QUEUED',
          payload: payload as Prisma.InputJsonValue,
          attempts: 0,
          maxAttempts: opts.attempts,
          correlationId: payload.correlationId,
        },
        update: {
          workspaceId,
          status: 'QUEUED',
          payload: payload as Prisma.InputJsonValue,
          attempts: 0,
          maxAttempts: opts.attempts,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          errorCode: null,
          errorMessage: null,
          isDead: false,
          correlationId: payload.correlationId,
        },
      });
      const outboxEvent = await createQueueOutboxEvent(tx, {
        workspaceId,
        queueName: 'reply-platform-comment',
        jobId,
        payload,
        options: opts,
        aggregateType: 'OutboundOperation',
        aggregateId: operation.id,
      });
      return { reply, jobId, backgroundJob, outboxEventId: outboxEvent.id };
    });

    await this.dispatchCommentOutboxEvent(queued.outboxEventId);
    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_REPLIED',
      resourceType: 'Comment',
      resourceId: comment.id,
      metadata: { queued: true, replyRecordId: queued.reply.id },
    });

    return {
      queued: true,
      jobId: queued.jobId,
      backgroundJobId: queued.backgroundJob.id,
      message: 'Đã đưa reply vào queue.',
    };
  }

  private async ensureOfflineCommentCapability(
    workspaceId: string,
    comment: Awaited<ReturnType<typeof this.findComment>>,
    action: 'editComment' | 'deleteComment' | 'hideComment',
  ): Promise<void> {
    if (typeof this.adapterFactory.offlineAdapters === 'function') {
      const adapter = this.adapterFactory
        .offlineAdapters()
        .requireCapability(comment.platform, action);
      if (action === 'editComment' && !adapter.editComment) {
        throw AppError.capabilityUnsupported(comment.platform, 'editComment');
      }
      if (action === 'hideComment' && !adapter.hideComment) {
        throw AppError.capabilityUnsupported(comment.platform, 'hideComment');
      }
      if (action === 'deleteComment' && !adapter.deleteComment) {
        throw AppError.capabilityUnsupported(comment.platform, 'deleteComment');
      }
      this.ensureCommentActionScopes(comment, action);
    } else {
      await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
        const adapter = adapters.requireCapability(comment.platform, action);
        if (action === 'editComment' && !adapter.editComment) {
          throw AppError.capabilityUnsupported(comment.platform, 'editComment');
        }
        if (action === 'hideComment' && !adapter.hideComment) {
          throw AppError.capabilityUnsupported(comment.platform, 'hideComment');
        }
        if (action === 'deleteComment' && !adapter.deleteComment) {
          throw AppError.capabilityUnsupported(comment.platform, 'deleteComment');
        }
        this.ensureCommentActionScopes(comment, action);
      });
    }
  }

  private async enqueueModerateCommentTx(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      comment: Awaited<ReturnType<CommentsService['findComment']>>;
      actorUserId: string;
      correlationId: string;
      action: 'EDIT_MESSAGE' | 'SET_VISIBILITY' | 'DELETE_COMMENT';
      message?: string;
      previousMessage?: string | null;
      hidden?: boolean;
      previousHidden?: boolean;
      delayMs?: number;
    },
  ): Promise<string> {
    const latest = await tx.outboundOperation.findFirst({
      where: {
        operationType: 'MODERATE_COMMENT',
        resourceType: 'Comment',
        resourceId: input.comment.id,
      },
      orderBy: { operationGeneration: 'desc' },
      select: { operationGeneration: true },
    });
    const nextGeneration = (latest?.operationGeneration ?? 0) + 1;
    const operation = await findOrCreateOutboundOperation(tx, {
      workspaceId: input.workspaceId,
      operationType: 'MODERATE_COMMENT',
      resourceType: 'Comment',
      resourceId: input.comment.id,
      operationGeneration: nextGeneration,
    });
    const payload: QueuePayload<'moderate-platform-comment'> = {
      commentId: input.comment.id,
      platformPostId: input.comment.platformPostId,
      socialAccountId: input.comment.socialAccountId,
      workspaceId: input.workspaceId,
      requestedByUserId: input.actorUserId,
      correlationId: input.correlationId,
      operationId: operation.id,
      action: input.action,
      message: input.message,
      previousMessage: input.previousMessage,
      hidden: input.hidden,
      previousHidden: input.previousHidden,
    };
    const jobId = buildJobId('moderate-platform-comment', payload);
    const baseOpts = buildQueueJobOptions('moderate-platform-comment', jobId);
    const opts =
      input.delayMs && input.delayMs > 0 ? { ...baseOpts, delay: input.delayMs } : baseOpts;
    await tx.backgroundJob.upsert({
      where: { queueName_jobId: { queueName: 'moderate-platform-comment', jobId } },
      create: {
        workspaceId: input.workspaceId,
        queueName: 'moderate-platform-comment',
        jobId,
        status: 'QUEUED',
        payload: payload as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: opts.attempts,
        correlationId: input.correlationId,
      },
      update: {
        workspaceId: input.workspaceId,
        status: 'QUEUED',
        payload: payload as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: opts.attempts,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        isDead: false,
        correlationId: input.correlationId,
      },
    });
    const outboxEvent = await createQueueOutboxEvent(tx, {
      workspaceId: input.workspaceId,
      queueName: 'moderate-platform-comment',
      jobId,
      payload,
      options: opts,
      aggregateType: 'OutboundOperation',
      aggregateId: operation.id,
    });
    return outboxEvent.id;
  }

  private async dispatchCommentOutboxEvent(outboxEventId: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event) return;
    const value = event.payload as unknown as {
      queueName: 'create-platform-comment' | 'reply-platform-comment' | 'moderate-platform-comment';
      jobName: 'create-platform-comment' | 'reply-platform-comment' | 'moderate-platform-comment';
      payload:
        | QueuePayload<'create-platform-comment'>
        | QueuePayload<'reply-platform-comment'>
        | QueuePayload<'moderate-platform-comment'>;
      options: ReturnType<typeof buildQueueJobOptions>;
    };
    const queue =
      value.queueName === 'create-platform-comment'
        ? this.createPlatformCommentQueue
        : value.queueName === 'reply-platform-comment'
          ? this.replyPlatformCommentQueue
          : this.moderatePlatformCommentQueue;
    try {
      await queue.add(value.jobName, value.payload, value.options);
      await this.prisma.outboxEvent.update({
        where: { id: outboxEventId },
        data: { dispatchedAt: new Date(), lastError: null },
      });
      const redisClient = this.redis.getClient();
      if (redisClient && typeof redisClient.publish === 'function') {
        const realtimeEvent: WorkspaceRealtimeEvent = {
          id: randomUUID(),
          workspaceId: value.payload.workspaceId,
          type: 'job.queued',
          timestamp: new Date().toISOString(),
          queueName: value.queueName,
          jobId: value.options.jobId,
        };
        void redisClient
          .publish(
            workspaceRealtimeChannel(value.payload.workspaceId),
            JSON.stringify(realtimeEvent),
          )
          .catch(() => undefined);
      }
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
        'Immediate comment enqueue failed; outbox will retry',
      );
    }
  }

  private toBulkQueueSummary(requested: number, results: BulkQueueResult[]) {
    const queued = results.filter((result) => result.queued).length;
    return {
      requested,
      queued,
      failed: results.length - queued,
      results,
    };
  }

  private ensureCreateCommentScopes(commentTarget: {
    platform: Platform;
    socialAccount: { scopes: string[] };
  }) {
    if (
      commentTarget.platform === 'FACEBOOK' &&
      !commentTarget.socialAccount.scopes.includes('pages_manage_engagement')
    ) {
      throw AppError.conflict(
        'Facebook token hiện tại thiếu quyền pages_manage_engagement. Hãy ngắt kết nối rồi kết nối lại Facebook Page.',
      );
    }
    if (
      commentTarget.platform === 'YOUTUBE' &&
      !commentTarget.socialAccount.scopes.includes(
        'https://www.googleapis.com/auth/youtube.force-ssl',
      )
    ) {
      throw AppError.conflict(
        'YouTube token hiện tại thiếu scope youtube.force-ssl. Hãy ngắt kết nối rồi kết nối lại YouTube.',
      );
    }
    if (commentTarget.platform === 'INSTAGRAM') {
      const missingScopes = ['instagram_manage_comments', 'pages_read_engagement'].filter(
        (scope) => !commentTarget.socialAccount.scopes.includes(scope),
      );
      if (missingScopes.length > 0) {
        throw AppError.conflict(
          `Instagram token hiện tại thiếu quyền ${missingScopes.join(
            ', ',
          )}. Hãy ngắt kết nối rồi kết nối lại Instagram sau khi quyền đã được bật trong Meta App Dashboard.`,
        );
      }
    }
  }

  private ensureCommentActionScopes(
    comment: Awaited<ReturnType<typeof this.findComment>>,
    action: 'editComment' | 'deleteComment' | 'hideComment',
  ) {
    if (!comment.socialAccount.token || comment.socialAccount.status !== 'CONNECTED') {
      throw AppError.conflict('Social account chưa kết nối.');
    }
    if (
      comment.platform === 'FACEBOOK' &&
      !comment.socialAccount.scopes.includes('pages_manage_engagement')
    ) {
      throw AppError.conflict(
        'Facebook token hiện tại thiếu quyền pages_manage_engagement. Hãy ngắt kết nối rồi kết nối lại Facebook Page để quản lý comment.',
      );
    }
    if (
      comment.platform === 'YOUTUBE' &&
      !comment.socialAccount.scopes.includes('https://www.googleapis.com/auth/youtube.force-ssl')
    ) {
      throw AppError.conflict(
        'YouTube token hiện tại thiếu scope youtube.force-ssl. Hãy ngắt kết nối rồi kết nối lại YouTube để quản lý comment.',
      );
    }
    if (comment.platform === 'INSTAGRAM') {
      const missingScopes = ['instagram_manage_comments', 'pages_read_engagement'].filter(
        (scope) => !comment.socialAccount.scopes.includes(scope),
      );
      if (missingScopes.length > 0) {
        throw AppError.conflict(
          `Instagram token hiện tại thiếu quyền ${missingScopes.join(
            ', ',
          )}. Hãy ngắt kết nối rồi kết nối lại Instagram sau khi quyền đã được bật trong Meta App Dashboard.`,
        );
      }
    }
    if (action === 'editComment' && comment.platform !== 'YOUTUBE') {
      throw AppError.capabilityUnsupported(comment.platform, action);
    }
  }

  private ensureReplyCommentScopes(comment: Awaited<ReturnType<typeof this.findComment>>) {
    if (!comment.socialAccount.token || comment.socialAccount.status !== 'CONNECTED') {
      throw AppError.conflict('Social account chưa kết nối.');
    }
    if (
      comment.platform === 'FACEBOOK' &&
      !comment.socialAccount.scopes.includes('pages_manage_engagement')
    ) {
      throw AppError.conflict(
        'Facebook token hiện tại thiếu quyền pages_manage_engagement. Hãy ngắt kết nối rồi kết nối lại Facebook Page để cấp quyền reply comment.',
      );
    }
    if (
      comment.platform === 'YOUTUBE' &&
      !comment.socialAccount.scopes.includes('https://www.googleapis.com/auth/youtube.force-ssl')
    ) {
      throw AppError.conflict(
        'YouTube token hiện tại thiếu scope youtube.force-ssl. Hãy ngắt kết nối rồi kết nối lại YouTube để cấp quyền quản lý comment.',
      );
    }
    if (comment.platform === 'INSTAGRAM') {
      const missingScopes = ['instagram_manage_comments', 'pages_read_engagement'].filter(
        (scope) => !comment.socialAccount.scopes.includes(scope),
      );
      if (missingScopes.length > 0) {
        throw AppError.conflict(
          `Instagram token hiện tại thiếu quyền ${missingScopes.join(
            ', ',
          )}. Hãy ngắt kết nối rồi kết nối lại Instagram sau khi quyền đã được bật trong Meta App Dashboard.`,
        );
      }
    }
  }

  async sync(workspaceId: string, input: SyncCommentsInput, requestId: string) {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: input.socialAccountId, workspaceId, deletedAt: null },
    });
    if (!account) throw AppError.notFound('social account');

    if (input.platformPostId) {
      const platformPost = await this.prisma.platformPost.findFirst({
        where: { id: input.platformPostId, workspaceId, socialAccountId: account.id },
      });
      if (!platformPost) throw AppError.notFound('platform post');
    }

    const payload = {
      socialAccountId: account.id,
      workspaceId,
      platformPostId: input.platformPostId,
      since: input.since?.toISOString(),
    };
    const jobId = `${buildJobId('sync-comments', payload)}-${requestId}`;
    await this.syncQueue.add(
      'sync-comments',
      { ...payload, correlationId: requestId },
      buildQueueJobOptions('sync-comments', jobId),
    );
    this.events?.publish(workspaceId, {
      type: 'job.queued',
      queueName: 'sync-comments',
      jobId,
      socialAccountId: account.id,
      platformPostId: input.platformPostId,
    });
    return { queued: true, jobId };
  }

  async bulkSync(workspaceId: string, input: BulkSyncCommentsInput, requestId: string) {
    const platformPostIds = [...new Set(input.platformPostIds)];
    const platformPosts = await this.prisma.platformPost.findMany({
      where: { id: { in: platformPostIds }, workspaceId },
      include: {
        socialAccount: {
          select: { id: true, status: true, deletedAt: true, storeId: true, platform: true },
        },
        contentPost: { select: { storeId: true } },
      },
    });

    if (platformPosts.length > 1) {
      const resolvedStoreKeys = new Set(
        platformPosts.map(
          (item) => item.socialAccount?.storeId ?? item.contentPost?.storeId ?? '__UNASSIGNED__',
        ),
      );
      if (resolvedStoreKeys.size > 1) {
        throw AppError.validation(
          'Mỗi thao tác đồng bộ bình luận hàng loạt chỉ được thực hiện trên 1 Store duy nhất.',
        );
      }
    }

    const supportedReadPlatforms = new Set<Platform>(['FACEBOOK', 'INSTAGRAM', 'YOUTUBE']);
    const accountSlotMap = new Map<string, number>();
    let queued = 0;

    for (const pp of platformPosts) {
      if (
        pp.status !== 'PUBLISHED' ||
        !pp.externalPostId ||
        pp.socialAccount.deletedAt !== null ||
        pp.socialAccount.status !== 'CONNECTED' ||
        !supportedReadPlatforms.has(pp.platform)
      ) {
        continue;
      }

      const slot = accountSlotMap.get(pp.socialAccount.id) ?? 0;
      accountSlotMap.set(pp.socialAccount.id, slot + 1);
      const delay = slot * BULK_SYNC_ACCOUNT_STAGGER_MS;

      const payload = {
        socialAccountId: pp.socialAccount.id,
        workspaceId,
        platformPostId: pp.id,
      };
      const jobId = `${buildJobId('sync-comments', payload)}-${requestId}-${pp.id}`;
      const baseOpts = buildQueueJobOptions('sync-comments', jobId);
      await this.syncQueue.add(
        'sync-comments',
        { ...payload, correlationId: `${requestId}:${pp.id}` },
        delay > 0 ? { ...baseOpts, delay } : baseOpts,
      );
      this.events?.publish(workspaceId, {
        type: 'job.queued',
        queueName: 'sync-comments',
        jobId,
        socialAccountId: pp.socialAccount.id,
        platformPostId: pp.id,
      });
      queued += 1;
    }

    return {
      requested: platformPostIds.length,
      queued,
      skipped: platformPostIds.length - queued,
    };
  }

  async listTemplates(workspaceId: string, storeId?: string) {
    const where: Prisma.ReplyTemplateWhereInput =
      storeId === 'UNASSIGNED'
        ? { workspaceId, storeId: null }
        : storeId
          ? { workspaceId, OR: [{ storeId }, { storeId: null }] }
          : { workspaceId };
    const templates = await this.prisma.replyTemplate.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    if (storeId && storeId !== 'UNASSIGNED') {
      templates.sort(
        (a, b) =>
          (a.storeId === storeId ? 0 : 1) - (b.storeId === storeId ? 0 : 1) ||
          a.name.localeCompare(b.name),
      );
    }
    return { items: templates };
  }

  async createTemplate(workspaceId: string, input: CreateReplyTemplateInput) {
    const normalizedStoreId = input.storeId ?? null;
    if (normalizedStoreId && this.prisma.store?.findFirst) {
      const store = await this.prisma.store.findFirst({
        where: { id: normalizedStoreId, workspaceId },
        select: { id: true },
      });
      if (!store) throw AppError.notFound('store');
    }
    if (this.prisma.replyTemplate?.findFirst) {
      const duplicate = await this.prisma.replyTemplate.findFirst({
        where: { workspaceId, storeId: normalizedStoreId, name: input.name },
        select: { id: true },
      });
      if (duplicate) {
        throw AppError.conflict('Mẫu bình luận cùng tên đã tồn tại trong Store này.');
      }
    }
    return this.prisma.replyTemplate.create({
      data: {
        workspaceId,
        storeId: normalizedStoreId,
        name: input.name,
        body: input.body,
      },
    });
  }

  async updateTemplate(workspaceId: string, templateId: string, input: UpdateReplyTemplateInput) {
    const template = await this.prisma.replyTemplate.findFirst({
      where: { id: templateId, workspaceId },
    });
    if (!template) throw AppError.notFound('reply template');
    const targetStoreId = input.storeId !== undefined ? (input.storeId ?? null) : template.storeId;
    if (targetStoreId && this.prisma.store?.findFirst) {
      const store = await this.prisma.store.findFirst({
        where: { id: targetStoreId, workspaceId },
        select: { id: true },
      });
      if (!store) throw AppError.notFound('store');
    }
    const targetName = input.name ?? template.name;
    if (
      (targetName !== template.name || targetStoreId !== template.storeId) &&
      this.prisma.replyTemplate?.findFirst
    ) {
      const duplicate = await this.prisma.replyTemplate.findFirst({
        where: {
          workspaceId,
          storeId: targetStoreId,
          name: targetName,
          id: { not: template.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw AppError.conflict('Mẫu bình luận cùng tên đã tồn tại trong Store này.');
      }
    }
    return this.prisma.replyTemplate.update({
      where: { id: template.id },
      data: {
        ...(input.storeId !== undefined ? { storeId: targetStoreId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
    });
  }

  async deleteTemplate(workspaceId: string, templateId: string) {
    const template = await this.prisma.replyTemplate.findFirst({
      where: { id: templateId, workspaceId },
    });
    if (!template) throw AppError.notFound('reply template');
    await this.prisma.replyTemplate.delete({ where: { id: template.id } });
    return { deleted: true };
  }

  private async findComment(workspaceId: string, commentId: string) {
    const comment = await this.prisma.comment.findFirst({
      where: { id: commentId, workspaceId, deletedAt: null },
      include: this.commentInclude(),
    });
    if (!comment) throw AppError.notFound('comment');
    return comment;
  }

  private commentInclude() {
    return {
      socialAccount: {
        include: {
          token: true,
          store: { select: { id: true, name: true, slug: true, color: true } },
        },
      },
      platformPost: { include: { contentPost: true } },
      parent: { select: { externalCommentId: true } },
      children: { where: { deletedAt: null }, select: { id: true, isFromPage: true } },
      assignment: { include: { assignedTo: true, assignedBy: true, member: true } },
      tags: { include: { tag: true }, orderBy: { createdAt: 'asc' } },
      notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
      replies: { include: { sentBy: true }, orderBy: { createdAt: 'desc' } },
    } satisfies Prisma.CommentInclude;
  }

  private toCommentView(comment: Awaited<ReturnType<typeof this.findComment>>) {
    const activeChildren =
      (comment as { children?: Array<{ id: string; isFromPage: boolean }> }).children ?? [];
    const childCommentCount = activeChildren.length;
    const customerReplyCount = activeChildren.filter((child) => !child.isFromPage).length;

    return {
      id: comment.id,
      workspaceId: comment.workspaceId,
      platform: comment.platform,
      platformPostId: comment.platformPostId,
      contentPostId: comment.platformPost.contentPostId,
      contentPostTitle: comment.platformPost.contentPost.title,
      socialAccountId: comment.socialAccountId,
      socialAccountName: comment.socialAccount.name,
      storeId: comment.socialAccount.storeId ?? null,
      store:
        (
          comment.socialAccount as {
            store?: { id: string; name: string; slug: string; color: string | null } | null;
          }
        ).store ?? null,
      externalCommentId: comment.externalCommentId,
      parentId: comment.parentId,
      childCommentCount,
      customerReplyCount,
      authorExternalId: comment.authorExternalId,
      authorName: comment.authorName,
      authorAvatarUrl: comment.authorAvatarUrl,
      message: comment.message,
      likeCount: comment.likeCount,
      postedAt: comment.postedAt,
      status: comment.status,
      isHidden: comment.isHidden,
      isFromPage: comment.isFromPage,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      assignment: comment.assignment
        ? {
            id: comment.assignment.id,
            memberId: comment.assignment.memberId,
            assignedToId: comment.assignment.assignedToId,
            assignedToName: comment.assignment.assignedTo.name,
            assignedToEmail: comment.assignment.assignedTo.email,
            assignedById: comment.assignment.assignedById,
            assignedAt: comment.assignment.assignedAt,
            resolvedAt: comment.assignment.resolvedAt,
          }
        : null,
      tags: comment.tags.map((item) => ({
        id: item.tag.id,
        name: item.tag.name,
        color: item.tag.color,
      })),
      notes: comment.notes.map((note) => ({
        id: note.id,
        body: note.body,
        authorId: note.authorId,
        authorName: note.author.name,
        authorEmail: note.author.email,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
      replies: comment.replies.map((reply) => ({
        id: reply.id,
        message: reply.message,
        status: reply.status,
        sentById: reply.sentById,
        sentByName: reply.sentBy.name,
        sentByEmail: reply.sentBy.email,
        externalReplyId: reply.externalReplyId,
        sentAt: reply.sentAt,
        errorCode: reply.errorCode,
        errorMessage: reply.errorMessage,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
      })),
    };
  }
}
