import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { platformSchema, type Platform } from '@socialhub/shared';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { getRequestId } from '../../common/request-context';
import { logger } from '../../common/logger';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { SocialAccountsService } from './social-accounts.service';

const OAUTH_CALLBACK_TIMEOUT_MS = 20_000;

@Controller()
export class SocialAccountsController {
  constructor(
    @Inject(SocialAccountsService) private readonly socialAccounts: SocialAccountsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get('workspaces/:workspaceId/social-accounts')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  list(@Param('workspaceId') workspaceId: string) {
    return this.socialAccounts.list(workspaceId);
  }

  @Post('workspaces/:workspaceId/social-accounts/oauth/:platform/authorize')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  authorize(
    @Param('workspaceId') workspaceId: string,
    @Param('platform') platform: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.startOAuth(
      requireUser(request).id,
      workspaceId,
      this.parsePlatform(platform),
    );
  }

  @Delete('workspaces/:workspaceId/social-accounts/:socialAccountId')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:disconnect')
  disconnect(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.disconnect(
      workspaceId,
      socialAccountId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post('workspaces/:workspaceId/social-accounts/:socialAccountId/test')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  testConnection(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.testConnection(
      workspaceId,
      socialAccountId,
      this.auditContext(request),
    );
  }

  @Get('oauth/:platform/callback')
  async callback(
    @Param('platform') platform: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Req() request: FastifyRequest & AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const platformValue = this.safeParsePlatform(platform);

    if (oauthError) {
      return this.redirectToAccounts(reply, { oauth: 'cancelled', platform: platformValue });
    }

    if (!code || !state) {
      return this.redirectToAccounts(reply, { oauth: 'missing-code', platform: platformValue });
    }

    const requestId = getRequestId(request);
    try {
      const result = await withTimeout(
        this.socialAccounts.completeOAuth({
          code,
          state,
          platform: this.parsePlatform(platform),
          currentUserId: request.user?.id,
          cookieHeader: request.headers.cookie,
          auditContext: this.auditContext(request),
        }),
        OAUTH_CALLBACK_TIMEOUT_MS,
      );

      logger.info(
        { requestId, platform: result.platform, workspaceId: result.workspaceId },
        'OAuth callback hoàn tất, redirect về web',
      );

      return this.redirectToAccounts(reply, {
        connected: result.platform,
        workspaceId: result.workspaceId,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'OAUTH_CALLBACK_TIMEOUT';
      logger.error(
        {
          requestId,
          platform: platformValue,
          err: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        timedOut ? 'OAuth callback quá thời gian chờ' : 'OAuth callback thất bại',
      );
      return this.redirectToAccounts(reply, {
        oauth: timedOut ? 'timeout' : 'failed',
        platform: platformValue,
      });
    }
  }

  private parsePlatform(platform: string): Platform {
    return platformSchema.parse(platform.toUpperCase());
  }

  private safeParsePlatform(platform: string): Platform | undefined {
    const parsed = platformSchema.safeParse(platform.toUpperCase());
    return parsed.success ? parsed.data : undefined;
  }

  private accountsUrl(params: Record<string, string | undefined>): string {
    const url = new URL('/accounts', this.env.WEB_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private redirectToAccounts(
    reply: FastifyReply,
    params: Record<string, string | undefined>,
  ): FastifyReply {
    return reply.code(303).redirect(this.accountsUrl(params));
  }

  private auditContext(request: FastifyRequest) {
    return {
      actorIp: request.ip,
      actorUserAgent: request.headers['user-agent'],
      requestId: getRequestId(request),
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('OAUTH_CALLBACK_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
