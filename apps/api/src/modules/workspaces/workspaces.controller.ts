import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { WorkspaceRole } from '@socialhub/shared';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireMembership, requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { getRequestId } from '../../common/request-context';
import {
  acceptInvitationSchema,
  changeRoleSchema,
  createWorkspaceSchema,
  inviteMemberSchema,
  updateWorkspaceSchema,
  type AcceptInvitationInput,
  type ChangeRoleInput,
  type CreateWorkspaceInput,
  type InviteMemberInput,
  type UpdateWorkspaceInput,
} from './workspaces.schemas';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@Req() request: FastifyRequest & AuthenticatedRequest) {
    return this.workspaces.listForUser(requireUser(request).id);
  }

  @Post()
  create(
    @Body(zodPipe(createWorkspaceSchema)) body: CreateWorkspaceInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.workspaces.create(requireUser(request).id, body, this.auditContext(request));
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceGuard)
  get(@Param('workspaceId') workspaceId: string) {
    return this.workspaces.get(workspaceId);
  }

  @Patch(':workspaceId')
  @UseGuards(WorkspaceGuard, RoleGuard)
  @RequirePermissions('workspace:update')
  update(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(updateWorkspaceSchema)) body: UpdateWorkspaceInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.workspaces.update(workspaceId, body, {
      ...this.auditContext(request),
      actorUserId: requireUser(request).id,
    });
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceGuard, RoleGuard)
  @RequirePermissions('member:view')
  listMembers(@Param('workspaceId') workspaceId: string) {
    return this.workspaces.listMembers(workspaceId);
  }

  @Post(':workspaceId/invitations')
  @UseGuards(WorkspaceGuard, RoleGuard)
  @RequirePermissions('member:invite')
  invite(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(inviteMemberSchema)) body: InviteMemberInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.workspaces.inviteMember(workspaceId, body, {
      ...this.auditContext(request),
      actorUserId: requireUser(request).id,
      actorRole: requireMembership(request).role as WorkspaceRole,
    });
  }

  @Post('invitations/accept')
  acceptInvitation(
    @Body(zodPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.workspaces.acceptInvitation(
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Patch(':workspaceId/members/:memberId/role')
  @UseGuards(WorkspaceGuard, RoleGuard)
  @RequirePermissions('member:change_role')
  changeRole(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body(zodPipe(changeRoleSchema)) body: ChangeRoleInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.workspaces.changeMemberRole(
      workspaceId,
      memberId,
      requireMembership(request).role as WorkspaceRole,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Delete(':workspaceId/members/:memberId')
  @UseGuards(WorkspaceGuard, RoleGuard)
  @RequirePermissions('member:remove')
  removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.workspaces.removeMember(
      workspaceId,
      memberId,
      requireUser(request).id,
      requireMembership(request).role as WorkspaceRole,
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
