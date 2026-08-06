import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@socialhub/db';
import { canAssignRole, canInviteRole, canRemoveRole, type WorkspaceRole } from '@socialhub/shared';
import { generateSecureToken, hashToken } from '@socialhub/security';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type {
  ChangeRoleInput,
  AcceptInvitationInput,
  CreateWorkspaceInput,
  InviteMemberInput,
  UpdateWorkspaceInput,
} from './workspaces.schemas';

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      items: memberships.map((membership) => ({
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        timezone: membership.workspace.timezone,
        role: membership.role,
      })),
    };
  }

  async create(userId: string, input: CreateWorkspaceInput, auditContext: AuditContext) {
    const workspace = await this.prisma.workspace.create({
      data: {
        name: input.name,
        timezone: input.timezone,
        slug: await this.createUniqueSlug(input.name),
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
      include: { members: true },
    });

    await this.audit.record({
      ...auditContext,
      actorUserId: userId,
      workspaceId: workspace.id,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'Workspace',
      resourceId: workspace.id,
      after: { name: workspace.name, timezone: workspace.timezone },
    });

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      timezone: workspace.timezone,
      role: workspace.members[0]?.role ?? 'OWNER',
    };
  }

  async get(workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
    });
    if (!workspace) throw AppError.notFound('workspace');
    return workspace;
  }

  async update(
    workspaceId: string,
    input: UpdateWorkspaceInput,
    auditContext: AuditContext & { actorUserId: string },
  ) {
    const before = await this.get(workspaceId);
    const workspace = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        name: input.name,
        timezone: input.timezone,
      },
    });

    await this.audit.record({
      ...auditContext,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'Workspace',
      resourceId: workspace.id,
      before: { name: before.name, timezone: before.timezone },
      after: { name: workspace.name, timezone: workspace.timezone },
    });

    return workspace;
  }

  async listMembers(workspaceId: string) {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      items: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        email: member.user.email,
        name: member.user.name,
        role: member.role,
        createdAt: member.createdAt,
      })),
    };
  }

  async inviteMember(
    workspaceId: string,
    input: InviteMemberInput,
    auditContext: AuditContext & { actorUserId: string; actorRole: WorkspaceRole },
  ) {
    if (!canInviteRole(auditContext.actorRole, input.role)) {
      throw AppError.forbidden('Bạn không được phép mời thành viên với vai trò này.');
    }

    const existingMember = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        user: { email: input.email },
      },
    });
    if (existingMember) {
      throw AppError.conflict('Email này đã là thành viên của workspace.');
    }

    const token = generateSecureToken();
    const { invitation, resent } = await this.createOrRefreshInvitation(
      workspaceId,
      input,
      token,
      auditContext,
    );

    await this.audit.record({
      ...auditContext,
      workspaceId,
      action: 'MEMBER_INVITED',
      resourceType: 'WorkspaceInvitation',
      resourceId: invitation.id,
      metadata: { email: input.email, role: input.role, resent },
    });

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      devInvitationToken: token,
      resent,
    };
  }

  async acceptInvitation(userId: string, input: AcceptInvitationInput, auditContext: AuditContext) {
    const tokenHash = hashToken(input.token);

    const accepted = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.deletedAt !== null) throw AppError.unauthenticated();

      const invitation = await tx.workspaceInvitation.findUnique({
        where: { tokenHash },
        include: { workspace: true },
      });

      if (!invitation) throw AppError.validation('Invitation token không hợp lệ.');
      if (invitation.status !== 'PENDING') {
        throw AppError.conflict('Lời mời này không còn ở trạng thái chờ.');
      }
      if (invitation.expiresAt <= new Date()) {
        await tx.workspaceInvitation.update({
          where: { id: invitation.id },
          data: { status: 'EXPIRED', pendingEmail: null },
        });
        throw AppError.validation('Lời mời này đã hết hạn.');
      }
      if (invitation.workspace.deletedAt !== null) throw AppError.notFound('workspace');
      if (invitation.email !== user.email) {
        throw AppError.forbidden('Lời mời này dành cho một email khác.');
      }

      const existingMember = await tx.workspaceMember.findFirst({
        where: { workspaceId: invitation.workspaceId, userId },
      });

      if (existingMember) {
        const updatedInvitation = await tx.workspaceInvitation.update({
          where: { id: invitation.id },
          data: { status: 'ACCEPTED', acceptedAt: new Date(), pendingEmail: null },
        });

        return {
          invitation: updatedInvitation,
          member: existingMember,
          workspace: invitation.workspace,
        };
      }

      const member = await tx.workspaceMember.create({
        data: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
      });

      const updatedInvitation = await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), pendingEmail: null },
      });

      return {
        invitation: updatedInvitation,
        member,
        workspace: invitation.workspace,
      };
    });

    await this.audit.record({
      ...auditContext,
      actorUserId: userId,
      workspaceId: accepted.workspace.id,
      action: 'MEMBER_INVITED',
      resourceType: 'WorkspaceInvitation',
      resourceId: accepted.invitation.id,
      metadata: {
        accepted: true,
        email: accepted.invitation.email,
        role: accepted.member.role,
      },
    });

    return {
      id: accepted.workspace.id,
      name: accepted.workspace.name,
      slug: accepted.workspace.slug,
      timezone: accepted.workspace.timezone,
      role: accepted.member.role,
    };
  }

  private async createOrRefreshInvitation(
    workspaceId: string,
    input: InviteMemberInput,
    token: string,
    auditContext: AuditContext & { actorUserId: string },
  ) {
    const existingPending = await this.prisma.workspaceInvitation.findFirst({
      where: { workspaceId, email: input.email, status: 'PENDING' },
    });

    if (existingPending && existingPending.expiresAt > new Date()) {
      const invitation = await this.prisma.workspaceInvitation.update({
        where: { id: existingPending.id },
        data: {
          role: input.role,
          tokenHash: hashToken(token),
          invitedById: auditContext.actorUserId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { invitation, resent: true };
    }

    if (existingPending) {
      await this.prisma.workspaceInvitation.update({
        where: { id: existingPending.id },
        data: { status: 'EXPIRED', pendingEmail: null },
      });
    }

    try {
      const invitation = await this.prisma.workspaceInvitation.create({
        data: {
          workspaceId,
          email: input.email,
          pendingEmail: input.email,
          role: input.role,
          tokenHash: hashToken(token),
          invitedById: auditContext.actorUserId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { invitation, resent: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AppError.conflict('Email này vừa được mời lại. Hãy thử tải lại trang.');
      }
      throw error;
    }
  }

  async changeMemberRole(
    workspaceId: string,
    memberId: string,
    actorRole: WorkspaceRole,
    actorUserId: string,
    input: ChangeRoleInput,
    auditContext: AuditContext,
  ) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
    });
    if (!member) throw AppError.notFound('member');

    if (
      !canAssignRole({
        actorRole,
        targetCurrentRole: member.role,
        targetNewRole: input.role,
        isSelf: member.userId === actorUserId,
      })
    ) {
      throw AppError.forbidden('Bạn không được phép đổi vai trò này.');
    }

    const updated = await this.prisma.workspaceMember.update({
      where: { id: member.id },
      data: { role: input.role },
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'ROLE_CHANGED',
      resourceType: 'WorkspaceMember',
      resourceId: member.id,
      before: { role: member.role },
      after: { role: updated.role },
    });

    return updated;
  }

  async removeMember(
    workspaceId: string,
    memberId: string,
    actorUserId: string,
    actorRole: WorkspaceRole,
    auditContext: AuditContext,
  ) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
    });
    if (!member) throw AppError.notFound('member');
    if (member.userId === actorUserId) {
      throw AppError.forbidden('Bạn không thể tự xóa chính mình khỏi workspace.');
    }
    if (!canRemoveRole(actorRole, member.role)) {
      throw AppError.forbidden('Bạn không được phép xóa thành viên này.');
    }

    if (member.role === 'OWNER') {
      const ownerCount = await this.prisma.workspaceMember.count({
        where: { workspaceId, role: 'OWNER' },
      });
      if (ownerCount <= 1) {
        throw AppError.forbidden('Không thể xóa Owner cuối cùng của workspace.');
      }
    }

    await this.prisma.workspaceMember.delete({ where: { id: member.id } });
    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'MEMBER_REMOVED',
      resourceType: 'WorkspaceMember',
      resourceId: member.id,
      before: { userId: member.userId, role: member.role },
    });

    return { removed: true };
  }

  private async createUniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.prisma.workspace.findUnique({ where: { slug } });
      if (!existing) return slug;
    }

    return `${base}-${Date.now().toString(36)}`;
  }
}
