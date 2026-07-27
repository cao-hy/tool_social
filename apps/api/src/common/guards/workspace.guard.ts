import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../errors/app-error';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    const workspaceId = request.params?.workspaceId;

    if (!user) throw AppError.unauthenticated();
    if (!workspaceId) throw AppError.validation('Thiếu workspaceId trên route.');

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        workspaceId,
        userId: user.id,
        workspace: { deletedAt: null },
      },
    });

    if (!membership) throw AppError.notFound('workspace');

    request.membership = {
      id: membership.id,
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    };

    return true;
  }
}
