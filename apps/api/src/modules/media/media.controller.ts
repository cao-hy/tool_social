import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import {
  abortMultipartUploadSchema,
  completeMultipartUploadSchema,
  createMediaUploadSchema,
  listMediaSchema,
  type AbortMultipartUploadInput,
  type CompleteMultipartUploadInput,
  type CreateMediaUploadInput,
  type ListMediaInput,
} from './media.schemas';
import { MediaService } from './media.service';

@Controller('workspaces/:workspaceId/media')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Get('usage')
  @RequirePermissions('media:view')
  usage(@Param('workspaceId') workspaceId: string) {
    return this.media.usage(workspaceId);
  }

  @Get()
  @RequirePermissions('media:view')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listMediaSchema)) query: ListMediaInput,
  ) {
    return this.media.list(workspaceId, query);
  }

  @Get(':mediaAssetId')
  @RequirePermissions('media:view')
  get(@Param('workspaceId') workspaceId: string, @Param('mediaAssetId') mediaAssetId: string) {
    return this.media.get(workspaceId, mediaAssetId);
  }

  @Get(':mediaAssetId/object')
  @RequirePermissions('media:view')
  async object(
    @Param('workspaceId') workspaceId: string,
    @Param('mediaAssetId') mediaAssetId: string,
    @Headers('range') range: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const object = await this.media.getObject(workspaceId, mediaAssetId, range);
    reply
      .code(object.statusCode)
      .header('Content-Type', object.contentType)
      .header('Cache-Control', 'private, max-age=300')
      .header('Accept-Ranges', 'bytes');
    if (object.contentLength !== undefined) {
      reply.header('Content-Length', String(object.contentLength));
    }
    if (object.contentRange) {
      reply.header('Content-Range', object.contentRange);
    }
    return reply.send(object.body);
  }

  @Get(':mediaAssetId/thumbnail')
  @RequirePermissions('media:view')
  async thumbnail(
    @Param('workspaceId') workspaceId: string,
    @Param('mediaAssetId') mediaAssetId: string,
    @Res() reply: FastifyReply,
  ) {
    const object = await this.media.getThumbnail(workspaceId, mediaAssetId);
    reply
      .code(object.statusCode)
      .header('Content-Type', object.contentType)
      .header('Cache-Control', 'private, max-age=3600');
    if (object.contentLength !== undefined) {
      reply.header('Content-Length', String(object.contentLength));
    }
    return reply.send(object.body);
  }

  @Post('uploads')
  @RequirePermissions('media:upload')
  createUpload(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createMediaUploadSchema)) body: CreateMediaUploadInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.media.createUpload(workspaceId, requireUser(request).id, body);
  }

  @Post('uploads/multipart')
  @RequirePermissions('media:upload')
  createMultipartUpload(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createMediaUploadSchema)) body: CreateMediaUploadInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.media.createMultipartUpload(workspaceId, requireUser(request).id, body);
  }

  @Post(':mediaAssetId/confirm')
  @RequirePermissions('media:upload')
  confirm(@Param('workspaceId') workspaceId: string, @Param('mediaAssetId') mediaAssetId: string) {
    return this.media.confirmUpload(workspaceId, mediaAssetId);
  }

  @Post(':mediaAssetId/multipart/complete')
  @RequirePermissions('media:upload')
  completeMultipartUpload(
    @Param('workspaceId') workspaceId: string,
    @Param('mediaAssetId') mediaAssetId: string,
    @Body(zodPipe(completeMultipartUploadSchema)) body: CompleteMultipartUploadInput,
  ) {
    return this.media.completeMultipartUpload(workspaceId, mediaAssetId, body);
  }

  @Post(':mediaAssetId/multipart/abort')
  @RequirePermissions('media:upload')
  abortMultipartUpload(
    @Param('workspaceId') workspaceId: string,
    @Param('mediaAssetId') mediaAssetId: string,
    @Body(zodPipe(abortMultipartUploadSchema)) body: AbortMultipartUploadInput,
  ) {
    return this.media.abortMultipartUpload(workspaceId, mediaAssetId, body);
  }

  @Post(':mediaAssetId/thumbnail/regenerate')
  @RequirePermissions('media:upload')
  regenerateThumbnail(
    @Param('workspaceId') workspaceId: string,
    @Param('mediaAssetId') mediaAssetId: string,
  ) {
    return this.media.regenerateThumbnail(workspaceId, mediaAssetId);
  }

  @Put(':mediaAssetId/object')
  @RequirePermissions('media:upload')
  uploadObject(
    @Param('workspaceId') workspaceId: string,
    @Param('mediaAssetId') mediaAssetId: string,
    @Body() body: Buffer,
    @Headers('content-type') contentType?: string,
  ) {
    return this.media.uploadObject(workspaceId, mediaAssetId, {
      bytes: body,
      declaredMimeType: contentType ?? 'application/octet-stream',
    });
  }

  @Delete(':mediaAssetId')
  @RequirePermissions('media:delete')
  delete(@Param('workspaceId') workspaceId: string, @Param('mediaAssetId') mediaAssetId: string) {
    return this.media.delete(workspaceId, mediaAssetId);
  }

  @Post(':mediaAssetId/archive')
  @RequirePermissions('media:delete')
  archive(@Param('workspaceId') workspaceId: string, @Param('mediaAssetId') mediaAssetId: string) {
    return this.media.archive(workspaceId, mediaAssetId);
  }
}
