import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createQueueOutboxEvent, findOrCreateOutboundOperation, type Prisma } from '@socialhub/db';
import { buildJobId, buildQueueJobOptions, type QueuePayload } from '@socialhub/shared';
import type { Platform } from '@socialhub/shared';
import { decryptToken, type Keyring } from '@socialhub/security';
import { RedisTokenRefreshLock } from '@socialhub/social-runtime';
import { isPlatformError, type SocialPlatformAdapter } from '@socialhub/platform-adapters';
import { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { KEYRING } from '../../infrastructure/infrastructure.module';
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { getFreshAccessTokenViaCentralService } from '../../infrastructure/token-refresh';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type {
  AddCommentNoteInput,
  AssignCommentInput,
  BulkCreatePlatformCommentInput,
  BulkReplyToCommentsInput,
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

@Injectable()
export class CommentsService implements OnModuleDestroy {
  private readonly syncQueue: Queue;
  private readonly createPlatformCommentQueue: Queue;
  private readonly replyPlatformCommentQueue: Queue;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
    @Inject(KEYRING) private readonly keyring: Keyring,
  ) {
    this.syncQueue = new Queue('sync-comments', { connection: this.redis.getClient() });
    this.createPlatformCommentQueue = new Queue('create-platform-comment', {
      connection: this.redis.getClient(),
    });
    this.replyPlatformCommentQueue = new Queue('reply-platform-comment', {
      connection: this.redis.getClient(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.syncQueue.close();
    await this.createPlatformCommentQueue.close();
    await this.replyPlatformCommentQueue.close();
  }

  async list(workspaceId: string, query: ListCommentsQuery) {
    const where: Prisma.CommentWhereInput = {
      workspaceId,
      deletedAt: null,
      status: query.status,
      platform: query.platform,
      socialAccountId: query.socialAccountId,
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

    await this.prisma.notification.create({
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

    if (input.updatePlatform) {
      if (!comment.isFromPage) {
        throw AppError.conflict(
          'Chỉ sửa được comment/reply do page hoặc channel của bạn gửi. Comment của khách không thể sửa.',
        );
      }

      await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
        const adapter = adapters.requireCapability(comment.platform, 'editComment');
        if (!adapter.editComment) {
          throw AppError.capabilityUnsupported(comment.platform, 'editComment');
        }
        this.ensureCommentActionScopes(comment, 'editComment');
        const accessToken = await this.getFreshAccessToken(comment.socialAccount, adapter);
        await adapter.editComment(
          {
            accessToken,
            externalAccountId: comment.socialAccount.externalAccountId,
            externalPageId: comment.socialAccount.externalPageId ?? undefined,
            correlationId: auditContext.requestId ?? `comment-edit:${comment.id}`,
          },
          comment.externalCommentId,
          input.message,
        );
      });
    }

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
      after: { message: input.message, updatePlatform: input.updatePlatform },
    });

    return this.toCommentView(updated);
  }

  async updateVisibility(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: UpdateCommentVisibilityInput,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
      const adapter = adapters.requireCapability(comment.platform, 'hideComment');
      if (!adapter.hideComment) {
        throw AppError.capabilityUnsupported(comment.platform, 'hideComment');
      }
      this.ensureCommentActionScopes(comment, 'hideComment');
      const accessToken = await this.getFreshAccessToken(comment.socialAccount, adapter);
      await adapter.hideComment(
        {
          accessToken,
          externalAccountId: comment.socialAccount.externalAccountId,
          externalPageId: comment.socialAccount.externalPageId ?? undefined,
          correlationId: auditContext.requestId ?? `comment-hide:${comment.id}`,
        },
        comment.externalCommentId,
        input.hidden,
      );
    });

    const updated = await this.prisma.comment.update({
      where: { id: comment.id },
      data: { isHidden: input.hidden },
      include: this.commentInclude(),
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_HIDDEN',
      resourceType: 'Comment',
      resourceId: comment.id,
      before: { isHidden: comment.isHidden },
      after: { isHidden: input.hidden },
    });

    return this.toCommentView(updated);
  }

  async deleteComment(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    input: DeleteCommentQuery,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);

    if (input.deleteFromPlatform) {
      const usesModerationDelete = comment.platform === 'YOUTUBE' && !comment.isFromPage;
      const action = usesModerationDelete ? 'hideComment' : 'deleteComment';

      await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
        const adapter = adapters.requireCapability(comment.platform, action);
        this.ensureCommentActionScopes(comment, action);
        const accessToken = await this.getFreshAccessToken(comment.socialAccount, adapter);

        try {
          if (usesModerationDelete) {
            if (!adapter.hideComment) {
              throw AppError.capabilityUnsupported(comment.platform, 'hideComment');
            }
            await adapter.hideComment(
              {
                accessToken,
                externalAccountId: comment.socialAccount.externalAccountId,
                externalPageId: comment.socialAccount.externalPageId ?? undefined,
                correlationId: auditContext.requestId ?? `comment-delete:${comment.id}`,
              },
              comment.externalCommentId,
              true,
            );
          } else {
            if (!adapter.deleteComment) {
              throw AppError.capabilityUnsupported(comment.platform, 'deleteComment');
            }
            await adapter.deleteComment(
              {
                accessToken,
                externalAccountId: comment.socialAccount.externalAccountId,
                externalPageId: comment.socialAccount.externalPageId ?? undefined,
                correlationId: auditContext.requestId ?? `comment-delete:${comment.id}`,
              },
              comment.externalCommentId,
            );
          }
        } catch (error) {
          let shouldIgnore = false;
          if (isPlatformError(error) && error.kind === 'NOT_FOUND') {
            shouldIgnore = true;
          } else if (
            error instanceof Error &&
            (error.message.includes('does not exist') ||
              error.message.includes('not found') ||
              error.message.includes('Unsupported delete request') ||
              error.message.includes('cannot be loaded'))
          ) {
            shouldIgnore = true;
          }

          if (!shouldIgnore) {
            throw error;
          }
        }
      });

      await this.prisma.comment.deleteMany({
        where: {
          workspaceId,
          OR: [{ id: comment.id }, { parentId: comment.id }],
        },
      });
    } else {
      const deletedAt = new Date();
      await this.prisma.comment.updateMany({
        where: {
          workspaceId,
          deletedAt: null,
          OR: [{ id: comment.id }, { parentId: comment.id }],
        },
        data: { deletedAt },
      });
    }

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'COMMENT_DELETED',
      resourceType: 'Comment',
      resourceId: comment.id,
      metadata: { deleteFromPlatform: input.deleteFromPlatform },
    });

    return { deleted: true };
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

    await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
      const adapter = adapters.requireCapability(platformPost.platform, 'createComment');
      if (!adapter.createComment) {
        throw AppError.capabilityUnsupported(platformPost.platform, 'createComment');
      }
      this.ensureCreateCommentScopes(platformPost);
    });

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

  private async queueReplyToComment(
    workspaceId: string,
    commentId: string,
    actorUserId: string,
    message: string,
    auditContext: AuditContext,
  ) {
    const comment = await this.findComment(workspaceId, commentId);
    await this.adapterFactory.withWorkspace(workspaceId, async ({ adapters }) => {
      const adapter = adapters.requireCapability(comment.platform, 'replyToComment');
      if (!adapter.replyToComment) {
        throw AppError.capabilityUnsupported(comment.platform, 'replyToComment');
      }
      this.ensureReplyCommentScopes(comment);
    });

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

  private async dispatchCommentOutboxEvent(outboxEventId: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
    if (!event) return;
    const value = event.payload as unknown as {
      queueName: 'create-platform-comment' | 'reply-platform-comment';
      jobName: 'create-platform-comment' | 'reply-platform-comment';
      payload: QueuePayload<'create-platform-comment'> | QueuePayload<'reply-platform-comment'>;
      options: ReturnType<typeof buildQueueJobOptions>;
    };
    const queue =
      value.queueName === 'create-platform-comment'
        ? this.createPlatformCommentQueue
        : this.replyPlatformCommentQueue;
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
    return { queued: true, jobId };
  }

  async listTemplates(workspaceId: string) {
    const templates = await this.prisma.replyTemplate.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
    return { items: templates };
  }

  async createTemplate(workspaceId: string, input: CreateReplyTemplateInput) {
    return this.prisma.replyTemplate.create({ data: { workspaceId, ...input } });
  }

  async updateTemplate(workspaceId: string, templateId: string, input: UpdateReplyTemplateInput) {
    const template = await this.prisma.replyTemplate.findFirst({
      where: { id: templateId, workspaceId },
    });
    if (!template) throw AppError.notFound('reply template');
    return this.prisma.replyTemplate.update({ where: { id: template.id }, data: input });
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
      socialAccount: { include: { token: true } },
      platformPost: { include: { contentPost: true } },
      parent: { select: { externalCommentId: true } },
      assignment: { include: { assignedTo: true, assignedBy: true, member: true } },
      tags: { include: { tag: true }, orderBy: { createdAt: 'asc' } },
      notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
      replies: { include: { sentBy: true }, orderBy: { createdAt: 'desc' } },
    } satisfies Prisma.CommentInclude;
  }

  private toCommentView(comment: Awaited<ReturnType<typeof this.findComment>>) {
    return {
      id: comment.id,
      workspaceId: comment.workspaceId,
      platform: comment.platform,
      platformPostId: comment.platformPostId,
      contentPostId: comment.platformPost.contentPostId,
      contentPostTitle: comment.platformPost.contentPost.title,
      socialAccountId: comment.socialAccountId,
      socialAccountName: comment.socialAccount.name,
      externalCommentId: comment.externalCommentId,
      parentId: comment.parentId,
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
