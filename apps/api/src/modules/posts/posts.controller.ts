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
  createPostSchema,
  listPostsQuerySchema,
  publishPostSchema,
  schedulePostSchema,
  updatePostSchema,
  type CreatePostInput,
  type ListPostsQuery,
  type PublishPostInputDto,
  type SchedulePostInput,
  type UpdatePostInput,
} from './posts.schemas';
import { PostsService } from './posts.service';

@Controller('workspaces/:workspaceId/posts')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class PostsController {
  constructor(@Inject(PostsService) private readonly posts: PostsService) {}

  @Get()
  @RequirePermissions('post:view')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listPostsQuerySchema)) query: ListPostsQuery,
  ) {
    return this.posts.list(workspaceId, query);
  }

  @Post()
  @RequirePermissions('post:create')
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createPostSchema)) body: CreatePostInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.create(
      workspaceId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Get(':postId')
  @RequirePermissions('post:view')
  get(@Param('workspaceId') workspaceId: string, @Param('postId') postId: string) {
    return this.posts.get(workspaceId, postId);
  }

  @Patch(':postId')
  @RequirePermissions('post:update')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body(zodPipe(updatePostSchema)) body: UpdatePostInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.update(
      workspaceId,
      postId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Delete(':postId')
  @RequirePermissions('post:delete')
  delete(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.deletePost(
      workspaceId,
      postId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post(':postId/publish')
  @RequirePermissions('post:publish')
  publish(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body(zodPipe(publishPostSchema)) body: PublishPostInputDto,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.publishNow(
      workspaceId,
      postId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Post(':postId/schedule')
  @RequirePermissions('post:schedule')
  schedule(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Body(zodPipe(schedulePostSchema)) body: SchedulePostInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.schedule(
      workspaceId,
      postId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Post(':postId/retry')
  @RequirePermissions('post:publish')
  retry(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.retry(
      workspaceId,
      postId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post(':postId/platform-posts/:platformPostId/refresh-state')
  @RequirePermissions('post:view')
  refreshPlatformPostState(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Param('platformPostId') platformPostId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.refreshPlatformPostState(
      workspaceId,
      postId,
      platformPostId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post(':postId/platform-posts/:platformPostId/youtube/make-public')
  @RequirePermissions('post:publish')
  makeYouTubePublic(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Param('platformPostId') platformPostId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.makeYouTubePublic(
      workspaceId,
      postId,
      platformPostId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post(':postId/duplicate')
  @RequirePermissions('post:create')
  duplicate(
    @Param('workspaceId') workspaceId: string,
    @Param('postId') postId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.posts.duplicate(
      workspaceId,
      postId,
      requireUser(request).id,
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
