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
import { isPlatformError } from '@socialhub/platform-adapters';
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

  @Post('workspaces/:workspaceId/social-accounts/:socialAccountId/tiktok/creator-info')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  tiktokCreatorInfo(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.getTikTokCreatorInfo(
      workspaceId,
      socialAccountId,
      this.auditContext(request),
    );
  }

  @Get('workspaces/:workspaceId/social-accounts/:socialAccountId/pinterest/boards')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  pinterestBoards(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.getPinterestBoards(
      workspaceId,
      socialAccountId,
      this.auditContext(request),
    );
  }

  @Get(
    'workspaces/:workspaceId/social-accounts/:socialAccountId/pinterest/boards/:boardId/sections',
  )
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  pinterestBoardSections(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Param('boardId') boardId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.getPinterestBoardSections(
      workspaceId,
      socialAccountId,
      boardId,
      this.auditContext(request),
    );
  }

  @Get('oauth/:platform/callback')
  async callback(
    @Param('platform') platform: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Query('error_description') oauthErrorDescription: string | undefined,
    @Query('granted_scopes') grantedScopes: string | undefined,
    @Query('denied_scopes') deniedScopes: string | undefined,
    @Req() request: FastifyRequest & AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const platformValue = this.safeParsePlatform(platform);

    if (oauthError) {
      logger.warn(
        {
          requestId: getRequestId(request),
          platform: platformValue,
          oauthError,
          oauthErrorDescription,
          deniedScopes,
          grantedScopes,
        },
        'OAuth provider trả lỗi trước khi callback có code',
      );
      return this.redirectToAccounts(reply, {
        oauth: 'cancelled',
        platform: platformValue,
        reason: this.oauthProviderReason(
          platformValue,
          oauthError,
          oauthErrorDescription,
          deniedScopes,
        ),
      });
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
          err: this.errorLogObject(error),
        },
        timedOut ? 'OAuth callback quá thời gian chờ' : 'OAuth callback thất bại',
      );
      return this.redirectToAccounts(reply, {
        oauth: timedOut ? 'timeout' : 'failed',
        platform: platformValue,
        reason: timedOut ? 'timeout' : this.oauthFailureReason(error),
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

  private oauthProviderReason(
    platform: Platform | undefined,
    error: string,
    description: string | undefined,
    deniedScopes: string | undefined,
  ): string {
    const text = `${error} ${description ?? ''} ${deniedScopes ?? ''}`.toLowerCase();
    if (
      platform === 'FACEBOOK' &&
      (text.includes('invalid scope') || text.includes('pages_read_user_content'))
    ) {
      return 'facebook_permission_not_available';
    }
    if (platform === 'YOUTUBE' && text.includes('invalid')) return 'youtube_auth_invalid';
    if (text.includes('access_denied')) return 'cancelled';
    return 'provider_error';
  }

  private oauthFailureReason(error: unknown): string {
    if (isPlatformError(error)) {
      if (error.platform === 'FACEBOOK' && error.kind === 'PERMISSION_DENIED') {
        return 'facebook_permission_not_available';
      }
      if (
        error.kind === 'PERMISSION_DENIED' &&
        /pages_read_user_content|invalid scope|permission/i.test(error.message)
      ) {
        return 'facebook_permission_not_available';
      }
      if (error.kind === 'AUTH_INVALID') {
        return error.platform === 'FACEBOOK'
          ? 'facebook_auth_invalid'
          : `${error.platform.toLowerCase()}_auth_invalid`;
      }
      return `platform_${error.kind.toLowerCase()}`;
    }
    if (error instanceof Error && /OAuth state/i.test(error.message)) return 'invalid_state';
    if (error instanceof Error && /callback không khớp phiên/i.test(error.message)) {
      return 'session_mismatch';
    }
    return 'unknown';
  }

  private errorLogObject(error: unknown): unknown {
    if (isPlatformError(error)) {
      return {
        ...error.toLogObject(),
        raw: error.raw,
        cause: this.errorCauseLogObject(error.cause),
      };
    }
    return error instanceof Error ? { name: error.name, message: error.message } : error;
  }

  private errorCauseLogObject(cause: unknown): unknown {
    if (!cause) return undefined;
    if (cause instanceof Error) {
      return {
        name: cause.name,
        message: cause.message,
        issues:
          'issues' in cause && Array.isArray(cause.issues) ? cause.issues.slice(0, 10) : undefined,
      };
    }
    return cause;
  }

  @Post('workspaces/:workspaceId/social-accounts/:accountId/sync-posts')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:sync')
  syncExternalPosts(
    @Param('workspaceId') workspaceId: string,
    @Param('accountId') accountId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    const user = requireUser(request);
    return this.socialAccounts.triggerSyncExternalPosts(
      workspaceId,
      accountId,
      user.id,
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
