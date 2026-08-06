import { Inject, Injectable } from '@nestjs/common';
import { generateSecureToken, hashToken } from '@socialhub/security';
import { redactSensitive } from '@socialhub/shared';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { hashPassword, PasswordPolicyError, verifyPassword } from './password';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  ChangePasswordInput,
} from './auth.schemas';

export interface SessionCookie {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}

export interface AuthUserView {
  id: string;
  email: string;
  name: string | null;
}

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async register(input: RegisterInput, auditContext: AuditContext) {
    try {
      const passwordHash = await hashPassword(input.password);

      let defaultNamePart = input.email.split('@')[0];
      if (input.name && input.name.trim() !== '') {
        const nameParts = input.name.trim().split(/\s+/);
        const targetName = nameParts[nameParts.length - 1];
        if (targetName) {
          defaultNamePart = targetName.charAt(0).toUpperCase() + targetName.slice(1);
        }
      }
      const workspaceName = input.workspaceName ?? `${defaultNamePart}'s Workspace`;

      const created = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email: input.email } });
        if (existing) throw AppError.conflict('Email này đã được đăng ký.');

        const user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            passwordHash,
          },
        });

        const workspace = await tx.workspace.create({
          data: {
            name: workspaceName,
            slug: await this.createUniqueSlug(workspaceName, tx),
            timezone: 'UTC',
          },
        });

        const membership = await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
        });

        return { user, workspace, membership };
      });

      const session = await this.createSession(created.user.id, auditContext);
      await this.audit.record({
        ...auditContext,
        actorUserId: created.user.id,
        workspaceId: created.workspace.id,
        action: 'USER_LOGIN',
        resourceType: 'User',
        resourceId: created.user.id,
      });

      return {
        user: this.toUserView(created.user),
        workspaces: [
          {
            id: created.workspace.id,
            name: created.workspace.name,
            slug: created.workspace.slug,
            timezone: created.workspace.timezone,
            role: created.membership.role,
          },
        ],
        sessionCookie: session,
      };
    } catch (error) {
      if (error instanceof PasswordPolicyError) throw AppError.validation(error.message);
      throw error;
    }
  }

  async login(input: LoginInput, auditContext: AuditContext) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const valid = await verifyPassword(input.password, user?.passwordHash ?? null);

    if (!user || user.deletedAt !== null || !valid) {
      await this.audit.record({
        ...auditContext,
        action: 'USER_LOGIN_FAILED',
        resourceType: 'User',
        metadata: redactSensitive({ email: input.email }),
      });
      throw AppError.unauthenticated('Email hoặc mật khẩu không đúng.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const sessionCookie = await this.createSession(user.id, auditContext);
    await this.audit.record({
      ...auditContext,
      actorUserId: user.id,
      action: 'USER_LOGIN',
      resourceType: 'User',
      resourceId: user.id,
    });

    return {
      user: this.toUserView(user),
      workspaces: await this.getWorkspacesForUser(user.id),
      sessionCookie,
    };
  }

  async logout(token: string | null, auditContext: AuditContext): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    const session = await this.prisma.session.findUnique({ where: { sessionToken: tokenHash } });
    if (!session) return;

    await this.prisma.session.delete({ where: { id: session.id } });
    await this.audit.record({
      ...auditContext,
      actorUserId: session.userId,
      action: 'USER_LOGOUT',
      resourceType: 'Session',
      resourceId: session.id,
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt !== null) throw AppError.unauthenticated();

    return {
      user: this.toUserView(user),
      workspaces: await this.getWorkspacesForUser(user.id),
    };
  }

  async forgotPassword(input: ForgotPasswordInput, auditContext: AuditContext) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    let devResetToken: string | undefined;

    if (user && user.deletedAt === null) {
      const token = generateSecureToken();
      devResetToken = token;
      await this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await this.audit.record({
        ...auditContext,
        actorUserId: user.id,
        action: 'PASSWORD_RESET_REQUESTED',
        resourceType: 'User',
        resourceId: user.id,
      });
    }

    return {
      accepted: true,
      devResetToken: this.env.NODE_ENV === 'production' ? undefined : devResetToken,
    };
  }

  async resetPassword(input: ResetPasswordInput, auditContext: AuditContext) {
    try {
      const passwordHash = await hashPassword(input.password);
      const tokenHash = hashToken(input.token);
      const reset = await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.passwordResetToken.updateMany({
          where: {
            tokenHash,
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });

        if (consumed.count !== 1) {
          throw AppError.validation('Reset token không hợp lệ hoặc đã hết hạn.');
        }

        const resetToken = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
        if (!resetToken) throw AppError.validation('Lỗi không xác định.');

        await tx.user.update({
          where: { id: resetToken.userId },
          data: { passwordHash },
        });

        await tx.session.deleteMany({ where: { userId: resetToken.userId } });

        return resetToken;
      });

      await this.audit.record({
        ...auditContext,
        actorUserId: reset.userId,
        action: 'PASSWORD_CHANGED',
        resourceType: 'User',
        resourceId: reset.userId,
      });

      return { changed: true };
    } catch (error) {
      if (error instanceof PasswordPolicyError) throw AppError.validation(error.message);
      throw error;
    }
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    currentToken: string | null,
    auditContext: AuditContext,
  ) {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw AppError.unauthenticated('User không tồn tại.');

      const valid = await verifyPassword(input.currentPassword, user.passwordHash ?? null);
      if (!valid) throw AppError.validation('Mật khẩu hiện tại không đúng.');

      const passwordHash = await hashPassword(input.newPassword);

      const currentTokenHash = currentToken ? hashToken(currentToken) : undefined;

      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { passwordHash },
        }),
        this.prisma.session.deleteMany({
          where: {
            userId,
            ...(currentTokenHash ? { sessionToken: { not: currentTokenHash } } : {}),
          },
        }),
      ]);

      await this.audit.record({
        ...auditContext,
        actorUserId: userId,
        action: 'PASSWORD_CHANGED',
        resourceType: 'User',
        resourceId: userId,
      });

      return { changed: true };
    } catch (error) {
      if (error instanceof PasswordPolicyError) throw AppError.validation(error.message);
      throw error;
    }
  }

  buildCookieHeader(cookie: SessionCookie): string {
    const parts = [
      `${cookie.name}=${encodeURIComponent(cookie.value)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${cookie.maxAgeSeconds}`,
    ];
    if (cookie.secure) parts.push('Secure');
    return parts.join('; ');
  }

  buildClearCookieHeader(): string {
    const parts = [
      `${this.env.SESSION_COOKIE_NAME}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ];
    if (this.env.NODE_ENV === 'production') parts.push('Secure');
    return parts.join('; ');
  }

  readSessionToken(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const prefix = `${this.env.SESSION_COOKIE_NAME}=`;
    const cookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
  }

  private async createSession(userId: string, auditContext: AuditContext): Promise<SessionCookie> {
    const token = generateSecureToken();
    const maxAgeSeconds = this.env.SESSION_MAX_AGE_DAYS * 24 * 60 * 60;
    await this.prisma.session.create({
      data: {
        sessionToken: hashToken(token),
        userId,
        expiresAt: new Date(Date.now() + maxAgeSeconds * 1000),
        ipAddress: auditContext.actorIp,
        userAgent: Array.isArray(auditContext.actorUserAgent)
          ? auditContext.actorUserAgent.join(', ')
          : auditContext.actorUserAgent,
      },
    });

    return {
      name: this.env.SESSION_COOKIE_NAME,
      value: token,
      maxAgeSeconds,
      secure: this.env.NODE_ENV === 'production',
    };
  }

  private async getWorkspacesForUser(userId: string): Promise<WorkspaceView[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      timezone: membership.workspace.timezone,
      role: membership.role,
    }));
  }

  private toUserView(user: { id: string; email: string; name: string | null }): AuthUserView {
    return { id: user.id, email: user.email, name: user.name };
  }

  private async createUniqueSlug(
    name: string,
    tx: Pick<PrismaService, 'workspace'>,
  ): Promise<string> {
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
      const existing = await tx.workspace.findUnique({ where: { slug } });
      if (!existing) return slug;
    }

    return `${base}-${Date.now().toString(36)}`;
  }
}
