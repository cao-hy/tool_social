import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { hashToken } from '@socialhub/security';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & AuthenticatedRequest>();
    const token = this.readSessionCookie(request);
    if (!token) throw AppError.unauthenticated();

    const tokenHash = hashToken(token);
    const session = await this.prisma.session.findUnique({
      where: { sessionToken: tokenHash },
      include: { user: true },
    });

    if (!session || session.expiresAt <= new Date() || session.user.deletedAt !== null) {
      throw AppError.unauthenticated();
    }

    request.session = { id: session.id, tokenHash };
    request.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };

    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date() },
    });

    return true;
  }

  private readSessionCookie(request: FastifyRequest): string | null {
    const header = request.headers.cookie;
    if (!header) return null;

    const cookies = header.split(';').map((part) => part.trim());
    const prefix = `${this.env.SESSION_COOKIE_NAME}=`;
    const cookie = cookies.find((part) => part.startsWith(prefix));
    if (!cookie) return null;

    return decodeURIComponent(cookie.slice(prefix.length));
  }
}
