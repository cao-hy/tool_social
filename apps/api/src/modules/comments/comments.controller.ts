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
  createCommentTagSchema,
  createReplyTemplateSchema,
  listCommentsQuerySchema,
  replyToCommentSchema,
  syncCommentsSchema,
  updateCommentStatusSchema,
  updateCommentTagsSchema,
  updateReplyTemplateSchema,
  type AddCommentNoteInput,
  type AssignCommentInput,
  type CreateCommentTagInput,
  type CreateReplyTemplateInput,
  type ListCommentsQuery,
  type ReplyToCommentInput,
  type SyncCommentsInput,
  type UpdateCommentStatusInput,
  type UpdateCommentTagsInput,
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
