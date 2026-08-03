import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { getRequestId } from '../../common/request-context';
import {
  addCommentNoteSchema,
  assignCommentSchema,
  bulkCreatePlatformCommentSchema,
  bulkReplyToCommentsSchema,
  createCommentTagSchema,
  createPlatformCommentSchema,
  createReplyTemplateSchema,
  deleteCommentQuerySchema,
  listCommentsQuerySchema,
  replyToCommentSchema,
  syncCommentsSchema,
  updateCommentMessageSchema,
  updateCommentStatusSchema,
  updateCommentTagsSchema,
  updateCommentVisibilitySchema,
  updateReplyTemplateSchema,
  type AddCommentNoteInput,
  type AssignCommentInput,
  type BulkCreatePlatformCommentInput,
  type BulkReplyToCommentsInput,
  type CreateCommentTagInput,
  type CreatePlatformCommentInput,
  type CreateReplyTemplateInput,
  type DeleteCommentQuery,
  type ListCommentsQuery,
  type ReplyToCommentInput,
  type SyncCommentsInput,
  type UpdateCommentMessageInput,
  type UpdateCommentStatusInput,
  type UpdateCommentTagsInput,
  type UpdateCommentVisibilityInput,
  type UpdateReplyTemplateInput,
} from './comments.schemas';
import { CommentsService } from './comments.service';

@Controller('workspaces/:workspaceId/comments')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class CommentsController {
  constructor(@Inject(CommentsService) private readonly comments: CommentsService) {}

  @Get()
  @RequirePermissions('comment:view')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listCommentsQuerySchema)) query: ListCommentsQuery,
  ) {
    return this.comments.list(workspaceId, query);
  }

  @Post('sync')
  @RequirePermissions('comment:moderate')
  sync(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(syncCommentsSchema)) body: SyncCommentsInput,
    @Req() request: FastifyRequest,
  ) {
    return this.comments.sync(workspaceId, body, getRequestId(request));
  }

  @Post('platform-posts/bulk')
  @RequirePermissions('comment:reply')
  bulkCreatePlatformComments(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(bulkCreatePlatformCommentSchema)) body: BulkCreatePlatformCommentInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.bulkCreatePlatformComments(
      workspaceId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Post('platform-posts/:platformPostId')
  @RequirePermissions('comment:reply')
  createPlatformComment(
    @Param('workspaceId') workspaceId: string,
    @Param('platformPostId') platformPostId: string,
    @Body(zodPipe(createPlatformCommentSchema)) body: CreatePlatformCommentInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.createPlatformComment(
      workspaceId,
      platformPostId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Post('replies/bulk')
  @RequirePermissions('comment:reply')
  bulkReplyToComments(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(bulkReplyToCommentsSchema)) body: BulkReplyToCommentsInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.bulkReplyToComments(
      workspaceId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Get('tags')
  @RequirePermissions('comment:view')
  listTags(@Param('workspaceId') workspaceId: string) {
    return this.comments.listTags(workspaceId);
  }

  @Post('tags')
  @RequirePermissions('comment:moderate')
  createTag(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createCommentTagSchema)) body: CreateCommentTagInput,
  ) {
    return this.comments.createTag(workspaceId, body);
  }

  @Get('templates')
  @RequirePermissions('comment:view')
  listTemplates(@Param('workspaceId') workspaceId: string) {
    return this.comments.listTemplates(workspaceId);
  }

  @Post('templates')
  @RequirePermissions('comment:reply')
  createTemplate(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createReplyTemplateSchema)) body: CreateReplyTemplateInput,
  ) {
    return this.comments.createTemplate(workspaceId, body);
  }

  @Patch('templates/:templateId')
  @RequirePermissions('comment:reply')
  updateTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body(zodPipe(updateReplyTemplateSchema)) body: UpdateReplyTemplateInput,
  ) {
    return this.comments.updateTemplate(workspaceId, templateId, body);
  }

  @Delete('templates/:templateId')
  @RequirePermissions('comment:reply')
  deleteTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.comments.deleteTemplate(workspaceId, templateId);
  }

  @Get(':commentId')
  @RequirePermissions('comment:view')
  get(@Param('workspaceId') workspaceId: string, @Param('commentId') commentId: string) {
    return this.comments.get(workspaceId, commentId);
  }

  @Patch(':commentId/status')
  @RequirePermissions('comment:moderate')
  updateStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(updateCommentStatusSchema)) body: UpdateCommentStatusInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.updateStatus(
      workspaceId,
      commentId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Patch(':commentId/assignment')
  @RequirePermissions('comment:assign')
  assign(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(assignCommentSchema)) body: AssignCommentInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.assign(
      workspaceId,
      commentId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Patch(':commentId/tags')
  @RequirePermissions('comment:moderate')
  updateTags(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(updateCommentTagsSchema)) body: UpdateCommentTagsInput,
  ) {
    return this.comments.updateTags(workspaceId, commentId, body);
  }

  @Patch(':commentId/message')
  @RequirePermissions('comment:moderate')
  updateMessage(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(updateCommentMessageSchema)) body: UpdateCommentMessageInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.updateMessage(
      workspaceId,
      commentId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Patch(':commentId/visibility')
  @RequirePermissions('comment:moderate')
  updateVisibility(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(updateCommentVisibilitySchema)) body: UpdateCommentVisibilityInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.updateVisibility(
      workspaceId,
      commentId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Delete(':commentId')
  @RequirePermissions('comment:moderate')
  deleteComment(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Query(zodPipe(deleteCommentQuerySchema)) query: DeleteCommentQuery,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.deleteComment(
      workspaceId,
      commentId,
      requireUser(request).id,
      query,
      this.auditContext(request),
    );
  }

  @Post(':commentId/notes')
  @RequirePermissions('comment:view')
  addNote(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(addCommentNoteSchema)) body: AddCommentNoteInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.addNote(workspaceId, commentId, requireUser(request).id, body);
  }

  @Post(':commentId/replies')
  @RequirePermissions('comment:reply')
  reply(
    @Param('workspaceId') workspaceId: string,
    @Param('commentId') commentId: string,
    @Body(zodPipe(replyToCommentSchema)) body: ReplyToCommentInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.comments.reply(
      workspaceId,
      commentId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  private auditContext(request: FastifyRequest) {
    return {
      actorIp: request.ip,
      actorUserAgent: request.headers['user-agent'],
      requestId: getRequestId(request),
    };
  }
}
