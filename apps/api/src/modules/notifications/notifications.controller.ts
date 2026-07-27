import { Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { listNotificationsQuerySchema, type ListNotificationsQuery } from './notifications.schemas';
import { NotificationsService } from './notifications.service';

@Controller('workspaces/:workspaceId/notifications')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermissions('notification:view')
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.notifications.list(workspaceId, requireUser(request).id, query);
  }

  @Patch('read-all')
  @RequirePermissions('notification:view')
  markAllRead(
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.notifications.markAllRead(workspaceId, requireUser(request).id);
  }

  @Patch(':notificationId/read')
  @RequirePermissions('notification:view')
  markRead(
    @Param('workspaceId') workspaceId: string,
    @Param('notificationId') notificationId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.notifications.markRead(workspaceId, requireUser(request).id, notificationId);
  }
}
