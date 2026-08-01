import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { JobsService } from './jobs.service';
import { listJobActivityQuerySchema, type ListJobActivityQuery } from './jobs.schemas';

@Controller('workspaces/:workspaceId/jobs')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get('activity')
  @RequirePermissions('notification:view')
  activity(
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listJobActivityQuerySchema)) query: ListJobActivityQuery,
  ) {
    return this.jobs.activity(workspaceId, query);
  }
}
