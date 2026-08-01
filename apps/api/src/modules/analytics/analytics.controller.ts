import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { AnalyticsService } from './analytics.service';
import {
  analyticsQuerySchema,
  syncAnalyticsSchema,
  type AnalyticsQuery,
  type SyncAnalyticsInput,
} from './analytics.schemas';

@Controller('workspaces/:workspaceId/analytics')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get()
  @RequirePermissions('analytics:view')
  dashboard(
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.dashboard(workspaceId, query);
  }

  @Post('sync')
  @RequirePermissions('analytics:view')
  sync(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(syncAnalyticsSchema)) body: SyncAnalyticsInput,
  ) {
    return this.analytics.enqueueSync(workspaceId, body);
  }
}
