import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { platformSchema, storeProxyTargetSchema, type Platform } from '@socialhub/shared';
import { isPlatformError } from '@socialhub/platform-adapters';
import { scrubSecretsFromText } from '@socialhub/security';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { getRequestId } from '../../common/request-context';
import { logger } from '../../common/logger';
import { AppError } from '../../common/errors/app-error';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { SocialAccountsService } from './social-accounts.service';
import { StoreIntegrationsService } from './store-integrations.service';

const OAUTH_CALLBACK_TIMEOUT_MS = 20_000;

const syncMetaTokenSchema = z.object({
  accessToken: z.string().trim().optional(),
  platforms: z
    .array(z.enum(['FACEBOOK', 'INSTAGRAM']))
    .min(1)
    .optional(),
  pageIds: z.array(z.string().trim().min(1)).optional(),
  storeId: z.string().trim().min(1).nullable().optional(),
  autoCreateStores: z.boolean().optional(),
});
type SyncMetaTokenInput = z.infer<typeof syncMetaTokenSchema>;

const completeOAuthCallbackUrlSchema = z.object({
  callbackUrl: z.string().trim().min(1, 'Vui lòng dán đường link Callback OAuth.'),
});
type CompleteOAuthCallbackUrlInput = z.infer<typeof completeOAuthCallbackUrlSchema>;

const syncPostsByFilterSchema = z.object({
  storeId: z.string().trim().min(1).optional(),
  platform: platformSchema.optional(),
  socialAccountId: z.string().trim().min(1).optional(),
  socialAccountIds: z.array(z.string().trim().min(1)).optional(),
  cutoffDays: z.coerce.number().int().min(1).max(1825).optional(),
  sinceDate: z.string().trim().optional(),
  force: z.boolean().optional(),
});
type SyncPostsByFilterInput = z.infer<typeof syncPostsByFilterSchema>;

const createStoreSchema = z.object({
  name: z.string().trim().min(1, 'Tên Store không được để trống.').max(120),
  description: z.string().trim().max(500).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  isDefault: z.boolean().optional(),
  socialAccountIds: z.array(z.string().trim().min(1)).optional(),
});
type CreateStoreInput = z.infer<typeof createStoreSchema>;

const updateStoreSchema = z.object({
  name: z.string().trim().min(1, 'Tên Store không được để trống.').max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  color: z.string().trim().max(32).nullable().optional(),
  isDefault: z.boolean().optional(),
  socialAccountIds: z.array(z.string().trim().min(1)).optional(),
});
type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

const assignAccountStoreSchema = z.object({
  storeId: z.string().trim().min(1).nullable(),
});
type AssignAccountStoreInput = z.infer<typeof assignAccountStoreSchema>;

const updateStoreProxySchema = z.object({
  enabled: z.boolean().optional(),
  proxyUrl: z.string().trim().max(1000).nullable().optional(),
  clearProxyUrl: z.boolean().optional(),
  countryLock: z.string().trim().max(8).nullable().optional(),
  targets: z.array(storeProxyTargetSchema).optional(),
});
type UpdateStoreProxyInput = z.infer<typeof updateStoreProxySchema>;

const updateStoreShopifySchema = z.object({
  enabled: z.boolean().optional(),
  shopDomain: z.string().trim().min(1, 'Vui lòng nhập Shop Admin Domain.').max(255),
  publicDomain: z.string().trim().max(255).nullable().optional(),
  shortPathPrefix: z.string().trim().max(32).nullable().optional(),
  adminAccessToken: z.string().trim().max(500).nullable().optional(),
});
type UpdateStoreShopifyInput = z.infer<typeof updateStoreShopifySchema>;

const shortenStoreUrlsBatchSchema = z.object({
  urls: z
    .array(z.string().trim().min(1, 'URL không được để trống.').max(2048))
    .min(1, 'Cần ít nhất 1 URL để rút gọn.')
    .max(200, 'Tối đa 200 URL mỗi lần rút gọn.'),
  cleanTracking: z.boolean().optional(),
  customSlug: z.string().trim().max(64).optional(),
});
type ShortenStoreUrlsBatchInput = z.infer<typeof shortenStoreUrlsBatchSchema>;

@Controller()
export class SocialAccountsController {
  constructor(
    @Inject(SocialAccountsService) private readonly socialAccounts: SocialAccountsService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Optional()
    @Inject(StoreIntegrationsService)
    private readonly storeIntegrations?: StoreIntegrationsService,
  ) {}

  @Get('workspaces/:workspaceId/social-accounts')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  list(@Param('workspaceId') workspaceId: string, @Query('storeId') storeId?: string) {
    return this.socialAccounts.list(workspaceId, storeId?.trim() || undefined);
  }

  @Get('workspaces/:workspaceId/stores')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  listStores(@Param('workspaceId') workspaceId: string) {
    return this.socialAccounts.listStores(workspaceId);
  }

  @Post('workspaces/:workspaceId/stores')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  createStore(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createStoreSchema)) body: CreateStoreInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.createStore(
      workspaceId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Patch('workspaces/:workspaceId/stores/:storeId')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  updateStore(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Body(zodPipe(updateStoreSchema)) body: UpdateStoreInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.updateStore(
      workspaceId,
      storeId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Delete('workspaces/:workspaceId/stores/:storeId')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  deleteStore(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.deleteStore(
      workspaceId,
      storeId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post('workspaces/:workspaceId/stores/auto-group')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  autoGroupStores(
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.autoGroupStores(
      workspaceId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Put('workspaces/:workspaceId/stores/:storeId/proxy')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  updateStoreProxy(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Body(zodPipe(updateStoreProxySchema)) body: UpdateStoreProxyInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.requireStoreIntegrations().updateStoreProxy(
      workspaceId,
      storeId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Post('workspaces/:workspaceId/stores/:storeId/proxy/test')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  testStoreProxy(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.requireStoreIntegrations().testStoreProxy(
      workspaceId,
      storeId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Put('workspaces/:workspaceId/stores/:storeId/shopify')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  updateStoreShopify(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Body(zodPipe(updateStoreShopifySchema)) body: UpdateStoreShopifyInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.requireStoreIntegrations().upsertStoreShopify(
      workspaceId,
      storeId,
      requireUser(request).id,
      body,
      this.auditContext(request),
    );
  }

  @Delete('workspaces/:workspaceId/stores/:storeId/shopify')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  deleteStoreShopify(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.requireStoreIntegrations().deleteStoreShopify(
      workspaceId,
      storeId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post('workspaces/:workspaceId/stores/:storeId/shopify/test')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  testStoreShopify(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.requireStoreIntegrations().testStoreShopify(
      workspaceId,
      storeId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post('workspaces/:workspaceId/stores/:storeId/short-links/batch')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  shortenStoreUrlsBatch(
    @Param('workspaceId') workspaceId: string,
    @Param('storeId') storeId: string,
    @Body(zodPipe(shortenStoreUrlsBatchSchema)) body: ShortenStoreUrlsBatchInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.requireStoreIntegrations().shortenStoreUrls(
      workspaceId,
      storeId,
      requireUser(request).id,
      body,
    );
  }

  @Patch('workspaces/:workspaceId/social-accounts/:socialAccountId/store')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  assignAccountStore(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Body(zodPipe(assignAccountStoreSchema)) body: AssignAccountStoreInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.assignAccountStore(
      workspaceId,
      socialAccountId,
      body.storeId,
      requireUser(request).id,
      this.auditContext(request),
    );
  }

  @Post('workspaces/:workspaceId/social-accounts/oauth/:platform/authorize')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  authorize(
    @Param('workspaceId') workspaceId: string,
    @Param('platform') platform: string,
    @Query('storeId') storeId: string | undefined,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.startOAuth(
      requireUser(request).id,
      workspaceId,
      this.parsePlatform(platform),
      storeId?.trim() || undefined,
    );
  }

  @Post('workspaces/:workspaceId/social-accounts/oauth/complete-callback')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  completeCallbackFromUrl(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(completeOAuthCallbackUrlSchema)) body: CompleteOAuthCallbackUrlInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.completeOAuthFromCallbackUrl({
      workspaceId,
      actorUserId: requireUser(request).id,
      callbackUrl: body.callbackUrl,
      auditContext: this.auditContext(request),
    });
  }

  @Post('workspaces/:workspaceId/social-accounts/meta/sync-token')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:connect')
  syncMetaToken(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(syncMetaTokenSchema)) body: SyncMetaTokenInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.syncMetaToken({
      workspaceId,
      actorUserId: requireUser(request).id,
      accessToken: body.accessToken,
      platforms: body.platforms,
      pageIds: body.pageIds,
      storeId: body.storeId,
      autoCreateStores: body.autoCreateStores,
      auditContext: this.auditContext(request),
    });
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

  @Get('workspaces/:workspaceId/social-accounts/:socialAccountId/instagram/locations')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:view')
  instagramLocations(
    @Param('workspaceId') workspaceId: string,
    @Param('socialAccountId') socialAccountId: string,
    @Query('q') query: string,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    return this.socialAccounts.searchInstagramLocations(
      workspaceId,
      socialAccountId,
      query || '',
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
        {
          requestId,
          platform: result.platform,
          workspaceId: result.workspaceId,
          crossBrowser: result.crossBrowser,
        },
        'OAuth callback hoàn tất',
      );

      if (result.crossBrowser) {
        const safeAccountName = escapeHtml(result.accountName || result.platform);
        const safePlatform = escapeHtml(result.platform);
        return reply.code(200).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Đã kết nối ${safePlatform}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { max-width: 440px; width: 100%; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px; box-shadow: 0 4px 12px rgba(15,23,42,0.05); text-align: center; }
    .badge { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 9999px; background: #ecfdf5; color: #059669; font-size: 24px; margin-bottom: 12px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 14px; color: #475569; line-height: 1.5; margin: 0; }
    .hint { margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: #f1f5f9; font-size: 12px; color: #334155; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✓</div>
    <h1>Đã kết nối thành công!</h1>
    <p>Kênh <strong>${safeAccountName}</strong> (${safePlatform}) đã được lưu vào SocialHub.</p>
    <div class="hint">Bạn có thể đóng tab này trên trình duyệt Multilogin và quay lại cửa sổ quản trị chính.</div>
  </div>
</body>
</html>`);
      }

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
        ...this.scrubLogRecord(error.toLogObject()),
        raw: this.scrubLogObject(error.raw),
        cause: this.errorCauseLogObject(error.cause),
      };
    }
    return error instanceof Error
      ? { name: error.name, message: scrubSecretsFromText(error.message) }
      : this.scrubLogObject(error);
  }

  private errorCauseLogObject(cause: unknown): unknown {
    if (!cause) return undefined;
    if (cause instanceof Error) {
      return {
        name: cause.name,
        message: scrubSecretsFromText(cause.message),
        issues:
          'issues' in cause && Array.isArray(cause.issues) ? cause.issues.slice(0, 10) : undefined,
      };
    }
    return this.scrubLogObject(cause);
  }

  private scrubLogObject(value: unknown): unknown {
    if (typeof value === 'string') return scrubSecretsFromText(value);
    if (Array.isArray(value)) return value.map((item) => this.scrubLogObject(item));
    if (!value || typeof value !== 'object') return value;

    return this.scrubLogRecord(value as Record<string, unknown>);
  }

  private scrubLogRecord(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, this.scrubLogObject(entry)]),
    );
  }

  @Post('workspaces/:workspaceId/social-accounts/sync-posts')
  @UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
  @RequirePermissions('social_account:sync')
  syncExternalPostsByFilter(
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(syncPostsByFilterSchema)) body: SyncPostsByFilterInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ) {
    const user = requireUser(request);
    return this.socialAccounts.triggerSyncExternalPostsByFilter(
      workspaceId,
      user.id,
      body,
      this.auditContext(request),
    );
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

  private requireStoreIntegrations(): StoreIntegrationsService {
    if (!this.storeIntegrations) {
      throw AppError.internal('StoreIntegrationsService chưa được khởi tạo.');
    }
    return this.storeIntegrations;
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
