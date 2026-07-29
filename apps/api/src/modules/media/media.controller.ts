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
import {
  createMediaUploadSchema,
  listMediaSchema,
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

  @Post('uploads')
  @RequirePermissions('media:upload')
  createUpload(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createMediaUploadSchema)) body: CreateMediaUploadInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.media.createUpload(workspaceId, requireUser(request).id, body);
  }

  @Post(':mediaAssetId/confirm')
  @RequirePermissions('media:upload')
  confirm(@Param('workspaceId') workspaceId: string, @Param('mediaAssetId') mediaAssetId: string) {
    return this.media.confirmUpload(workspaceId, mediaAssetId);
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
}
