import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { AuditLogsService } from './audit-logs.service';

@Controller('workspaces/:workspaceId/audit-logs')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
export class AuditController {
  constructor(@Inject(AuditLogsService) private readonly auditLogs: AuditLogsService) {}

  @Get()
  @RequirePermissions('audit_log:view')
  list(@Param('workspaceId') workspaceId: string): Promise<unknown> {
    return this.auditLogs.list(workspaceId);
  }
}
