import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  DevelopmentFixtureAdapter,
  FACEBOOK_PAGES_OAUTH_SCOPES,
  INSTAGRAM_OAUTH_SCOPES,
  PINTEREST_OAUTH_SCOPES,
  TIKTOK_OAUTH_SCOPES,
  YOUTUBE_OAUTH_SCOPES,
  isPlatformError,
  type SocialPlatformAdapter,
  type TikTokCreatorInfo,
  type TokenSet,
} from '@socialhub/platform-adapters';
import type { Prisma } from '@socialhub/db';
import type { Platform } from '@socialhub/shared';
import { buildJobId, buildQueueJobOptions } from '@socialhub/shared';
import {
  decryptToken,
  encryptToken,
  generateOAuthState,
  generatePkcePair,
  hashToken,
} from '@socialhub/security';
import type { Keyring } from '@socialhub/security';
import { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error';
import { logger } from '../../common/logger';
import { KEYRING } from '../../infrastructure/infrastructure.module';
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService, type AuditContext } from '../audit/audit.service';

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

interface OAuthStatePayload {
  userId: string;
  workspaceId: string;
  platform: Platform;
  codeVerifier: string;
  scopes: string[];
  createdAt: string;
}

export interface PinterestBoardSummary {
  id: string;
  name: string;
  description?: string | null;
  privacy?: string | null;
  ownerUsername?: string | null;
}

export interface PinterestBoardSectionSummary {
  id: string;
  name: string;
}

@Injectable()
export class SocialAccountsService implements OnModuleDestroy {
  private readonly refreshQueue: Queue;
  private readonly publishQueue: Queue;
  private readonly retryQueue: Queue;
  private readonly syncExternalPostsQueue: Queue;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.refreshQueue = new Queue('refresh-social-token', {
      connection: this.redis.getClient(),
    });
    this.publishQueue = new Queue('publish-post', {
      connection: this.redis.getClient(),
    });
    this.retryQueue = new Queue('retry-failed-post', {
      connection: this.redis.getClient(),
    });
    this.syncExternalPostsQueue = new Queue('sync-external-posts', {
      connection: this.redis.getClient(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.refreshQueue.close(),
      this.publishQueue.close(),
      this.retryQueue.close(),
      this.syncExternalPostsQueue.close(),
    ]);
  }

  async list(workspaceId: string) {
    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return {
      items: accounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        name: account.name,
        username: account.username,
        avatarUrl: account.avatarUrl,
        profileUrl: account.profileUrl,
        status: account.status,
        scopes: account.scopes,
        lastSyncedAt: account.lastSyncedAt,
        lastErrorAt: account.lastErrorAt,
        lastErrorMessage: account.lastErrorMessage,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })),
    };
  }

  async startOAuth(
    userId: string,
    workspaceId: string,
    platform: Platform,
  ): Promise<{ authorizationUrl: string; expiresInSeconds: number; developmentFixture: boolean }> {
    const adapter = (await this.adapterFactory.forWorkspace(workspaceId)).get(platform);
    const state = generateOAuthState();
    const pkce = generatePkcePair();
    const scopes = this.scopesFor(platform);
    const redirectUri = this.redirectUri(platform);

    await this.redis.connect();
    await this.redis.getClient().set(
      this.stateKey(state),
      JSON.stringify({
        userId,
        workspaceId,
        platform,
        codeVerifier: pkce.verifier,
        scopes,
        createdAt: new Date().toISOString(),
      } satisfies OAuthStatePayload),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    return {
      authorizationUrl: adapter.buildAuthorizationUrl({
        redirectUri,
        state,
        scopes,
        codeChallenge: pkce.challenge,
      }),
      expiresInSeconds: OAUTH_STATE_TTL_SECONDS,
      developmentFixture: adapter instanceof DevelopmentFixtureAdapter,
    };
  }

  async completeOAuth(input: {
    code: string;
    state: string;
    platform: Platform;
    currentUserId?: string;
    cookieHeader?: string;
    auditContext: AuditContext;
  }): Promise<{ workspaceId: string; socialAccountId: string; platform: Platform }> {
    const payload = await this.consumeState(input.state);
    if (payload.platform !== input.platform) throw AppError.validation('OAuth state sai nền tảng.');
    const currentUserId =
      input.currentUserId ?? (await this.userIdFromSessionCookie(input.cookieHeader));

    if (currentUserId && payload.userId !== currentUserId) {
      throw AppError.forbidden('OAuth callback không khớp phiên đăng nhập hiện tại.');
    }

    const adapter = (await this.adapterFactory.forWorkspace(payload.workspaceId)).get(
      input.platform,
    );
    logger.debug(
      { requestId: input.auditContext.requestId, platform: input.platform },
      'OAuth callback: bắt đầu exchange token',
    );
    const tokenSet = await adapter.exchangeCodeForToken(
      input.code,
      this.redirectUri(input.platform),
      payload.codeVerifier,
    );
    logger.debug(
      {
        requestId: input.auditContext.requestId,
        platform: input.platform,
        hasProfile: Boolean(tokenSet.accountProfile),
      },
      'OAuth callback: exchange token xong',
    );

    const encryptedAccessToken = encryptToken(tokenSet.accessToken, this.keyring);
    const encryptedRefreshToken = tokenSet.refreshToken
      ? encryptToken(tokenSet.refreshToken, this.keyring)
      : null;

    const profile =
      tokenSet.accountProfile ??
      (await adapter.getAccountProfile({
        accessToken: tokenSet.accessToken,
        externalAccountId: 'pending',
        correlationId: input.auditContext.requestId ?? 'oauth-callback',
      }));
    logger.debug(
      {
        requestId: input.auditContext.requestId,
        platform: input.platform,
        externalAccountId: profile.externalAccountId,
      },
      'OAuth callback: có profile account',
    );

    const account = await this.prisma.$transaction(async (tx) => {
      const existingAccount = await tx.socialAccount.findFirst({
        where: {
          workspaceId: payload.workspaceId,
          platform: input.platform,
          externalAccountId: profile.externalAccountId,
          externalPageId: profile.externalPageId ?? null,
        },
      });

      const socialAccount = existingAccount
        ? await tx.socialAccount.update({
            where: { id: existingAccount.id },
            data: {
              name: profile.name,
              username: profile.username,
              avatarUrl: profile.avatarUrl,
              profileUrl: profile.profileUrl,
              status: 'CONNECTED',
              scopes: tokenSet.scopes,
              lastErrorAt: null,
              lastErrorMessage: null,
              deletedAt: null,
            },
          })
        : await tx.socialAccount.create({
            data: {
              workspaceId: payload.workspaceId,
              platform: input.platform,
              externalAccountId: profile.externalAccountId,
              externalPageId: profile.externalPageId,
              name: profile.name,
              username: profile.username,
              avatarUrl: profile.avatarUrl,
              profileUrl: profile.profileUrl,
              status: 'CONNECTED',
              scopes: tokenSet.scopes,
            },
          });

      await tx.socialToken.upsert({
        where: { socialAccountId: socialAccount.id },
        create: this.tokenCreateData(
          socialAccount.id,
          tokenSet,
          encryptedAccessToken,
          encryptedRefreshToken,
        ),
        update: this.tokenUpdateData(tokenSet, encryptedAccessToken, encryptedRefreshToken),
      });

      return socialAccount;
    });
    logger.debug(
      {
        requestId: input.auditContext.requestId,
        platform: input.platform,
        socialAccountId: account.id,
      },
      'OAuth callback: đã lưu social account/token',
    );

    await this.audit.record({
      ...input.auditContext,
      actorUserId: payload.userId,
      workspaceId: payload.workspaceId,
      action: 'SOCIAL_ACCOUNT_CONNECTED',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      metadata: {
        platform: input.platform,
        developmentFixture: adapter instanceof DevelopmentFixtureAdapter,
      },
    });

    if (tokenSet.refreshToken) {
      await this.enqueueRefreshJob(account.id, payload.workspaceId);
    }
    logger.debug(
      {
        requestId: input.auditContext.requestId,
        platform: input.platform,
        socialAccountId: account.id,
      },
      'OAuth callback: hoàn tất service',
    );

    return {
      workspaceId: payload.workspaceId,
      socialAccountId: account.id,
      platform: input.platform,
    };
  }

  async disconnect(
    workspaceId: string,
    socialAccountId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
      include: { token: true },
    });
    if (!account) throw AppError.notFound('social account');

    const adapter = (await this.adapterFactory.forWorkspace(workspaceId)).get(account.platform);
    if (account.token && adapter.revokeToken) {
      try {
        const accessToken = decryptToken(account.token.accessToken, this.keyring);
        await adapter.revokeToken(accessToken);
      } catch (error) {
        logger.warn(
          {
            socialAccountId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to revoke token during disconnection. Proceeding to delete account anyway.',
        );
      }
    }

    await this.removePendingJobsForSocialAccount(workspaceId, socialAccountId);

    await this.prisma.$transaction([
      this.prisma.socialToken.deleteMany({ where: { socialAccountId } }),
      this.prisma.socialAccount.update({
        where: { id: socialAccountId },
        data: { status: 'DISCONNECTED', deletedAt: new Date() },
      }),
    ]);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'SOCIAL_ACCOUNT_DISCONNECTED',
      resourceType: 'SocialAccount',
      resourceId: socialAccountId,
      metadata: { platform: account.platform },
    });

    return { disconnected: true };
  }

  async testConnection(workspaceId: string, socialAccountId: string, auditContext: AuditContext) {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
      include: { token: true },
    });
    if (!account) throw AppError.notFound('social account');
    if (!account.token) throw AppError.conflict('Social account chưa có token để kiểm tra.');

    const adapter = (await this.adapterFactory.forWorkspace(workspaceId)).get(account.platform);
    const accessToken = await this.getFreshAccessToken(account, adapter);
    const profile = await adapter.getAccountProfile({
      accessToken,
      externalAccountId: account.externalAccountId,
      externalPageId: account.externalPageId ?? undefined,
      correlationId: auditContext.requestId ?? 'test-connection',
    });

    const updated = await this.prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        name: profile.name,
        username: profile.username,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
        status: 'CONNECTED',
        lastSyncedAt: new Date(),
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });

    return {
      ok: true,
      checkedAt: updated.lastSyncedAt,
      profile: {
        externalAccountId: profile.externalAccountId,
        name: profile.name,
        username: profile.username,
        profileUrl: profile.profileUrl,
      },
    };
  }

  async getTikTokCreatorInfo(
    workspaceId: string,
    socialAccountId: string,
    auditContext: AuditContext,
  ): Promise<TikTokCreatorInfo & { fetchedAt: string }> {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
      include: { token: true },
    });
    if (!account) throw AppError.notFound('social account');
    if (account.platform !== 'TIKTOK') {
      throw AppError.validation('Creator info chỉ áp dụng cho TikTok account.');
    }
    if (!account.token) throw AppError.conflict('TikTok account chưa có token để kiểm tra.');
    if (!account.scopes.includes('video.publish')) {
      throw AppError.conflict(
        'TikTok account thiếu scope video.publish. Hãy ngắt kết nối rồi kết nối lại sau khi app được cấp Direct Post.',
      );
    }

    const adapter = (await this.adapterFactory.forWorkspace(workspaceId)).get(account.platform);
    if (!hasTikTokCreatorInfo(adapter)) {
      throw AppError.capabilityUnsupported('TIKTOK', 'queryCreatorInfo');
    }

    const accessToken = await this.getFreshAccessToken(account, adapter);
    const creatorInfo = await adapter.queryCreatorInfo({
      accessToken,
      externalAccountId: account.externalAccountId,
      externalPageId: account.externalPageId ?? undefined,
      correlationId: auditContext.requestId ?? 'tiktok-creator-info',
    });

    return { ...creatorInfo, fetchedAt: new Date().toISOString() };
  }

  async getPinterestBoards(
    workspaceId: string,
    socialAccountId: string,
    auditContext: AuditContext,
  ): Promise<{ items: PinterestBoardSummary[]; fetchedAt: string }> {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
      include: { token: true },
    });
    if (!account) throw AppError.notFound('social account');
    if (account.platform !== 'PINTEREST') {
      throw AppError.validation('Danh sách board chỉ áp dụng cho Pinterest account.');
    }
    if (!account.token) throw AppError.conflict('Pinterest account chưa có token để kiểm tra.');
    if (!account.scopes.includes('boards:read')) {
      throw AppError.conflict(
        'Pinterest account thiếu scope boards:read. Hãy ngắt kết nối rồi kết nối lại sau khi app được cấp quyền boards:read.',
      );
    }

    const adapter = (await this.adapterFactory.forWorkspace(workspaceId)).get(account.platform);
    if (!hasPinterestBoardBrowser(adapter)) {
      throw AppError.conflict(
        'Pinterest API có hỗ trợ đọc board/section, nhưng adapter đang chạy chưa có chức năng này. Hãy kiểm tra app đang dùng Pinterest adapter thật và build/deploy đã cập nhật.',
      );
    }

    const accessToken = await this.getFreshAccessToken(account, adapter);
    return {
      items: await adapter.listBoards({
        accessToken,
        externalAccountId: account.externalAccountId,
        externalPageId: account.externalPageId ?? undefined,
        correlationId: auditContext.requestId ?? 'pinterest-list-boards',
      }),
      fetchedAt: new Date().toISOString(),
    };
  }

  async getPinterestBoardSections(
    workspaceId: string,
    socialAccountId: string,
    boardId: string,
    auditContext: AuditContext,
  ): Promise<{ items: PinterestBoardSectionSummary[]; fetchedAt: string }> {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
      include: { token: true },
    });
    if (!account) throw AppError.notFound('social account');
    if (account.platform !== 'PINTEREST') {
      throw AppError.validation('Board section chỉ áp dụng cho Pinterest account.');
    }
    if (!account.token) throw AppError.conflict('Pinterest account chưa có token để kiểm tra.');
    if (!account.scopes.includes('boards:read')) {
      throw AppError.conflict(
        'Pinterest account thiếu scope boards:read. Hãy ngắt kết nối rồi kết nối lại sau khi app được cấp quyền boards:read.',
      );
    }

    const adapter = (await this.adapterFactory.forWorkspace(workspaceId)).get(account.platform);
    if (!hasPinterestBoardBrowser(adapter)) {
      throw AppError.conflict(
        'Pinterest API có hỗ trợ đọc board/section, nhưng adapter đang chạy chưa có chức năng này. Hãy kiểm tra app đang dùng Pinterest adapter thật và build/deploy đã cập nhật.',
      );
    }

    const accessToken = await this.getFreshAccessToken(account, adapter);
    return {
      items: await adapter.listBoardSections(
        {
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: auditContext.requestId ?? 'pinterest-list-board-sections',
        },
        boardId,
      ),
      fetchedAt: new Date().toISOString(),
    };
  }

  private tokenCreateData(
    socialAccountId: string,
    tokenSet: TokenSet,
    accessToken: { ciphertext: string; keyVersion: string },
    refreshToken: { ciphertext: string; keyVersion: string } | null,
  ) {
    return {
      socialAccountId,
      accessToken: accessToken.ciphertext,
      refreshToken: refreshToken?.ciphertext,
      encryptionKeyVersion: accessToken.keyVersion,
      accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
    };
  }

  private tokenUpdateData(
    tokenSet: TokenSet,
    accessToken: { ciphertext: string; keyVersion: string },
    refreshToken: { ciphertext: string; keyVersion: string } | null,
  ) {
    return {
      accessToken: accessToken.ciphertext,
      refreshToken: refreshToken?.ciphertext,
      encryptionKeyVersion: accessToken.keyVersion,
      accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
      refreshFailedCount: 0,
      lastRefreshedAt: new Date(),
    };
  }

  private async getFreshAccessToken(
    account: {
      id: string;
      workspaceId: string;
      platform: Platform;
      token: {
        id: string;
        accessToken: string;
        refreshToken: string | null;
        accessTokenExpiresAt: Date | null;
        refreshTokenExpiresAt: Date | null;
      } | null;
    },
    adapter: SocialPlatformAdapter,
  ): Promise<string> {
    if (!account.token) throw AppError.conflict('Social account chưa có token để kiểm tra.');

    const refreshThreshold = Date.now() + 2 * 60 * 1000;
    if (
      !account.token.accessTokenExpiresAt ||
      account.token.accessTokenExpiresAt.getTime() > refreshThreshold
    ) {
      return decryptToken(account.token.accessToken, this.keyring);
    }

    if (!account.token.refreshToken || !adapter.refreshToken) {
      throw AppError.conflict('Token đã hết hạn. Hãy ngắt kết nối rồi kết nối lại tài khoản.');
    }

    const refreshToken = decryptToken(account.token.refreshToken, this.keyring);
    let tokenSet: TokenSet;
    try {
      tokenSet = await adapter.refreshToken(refreshToken);
    } catch (error) {
      if (isPlatformError(error) && error.kind === 'AUTH_INVALID') {
        await this.prisma.socialAccount.update({
          where: { id: account.id },
          data: {
            status: 'DISCONNECTED',
            lastErrorAt: new Date(),
            lastErrorMessage: error.message,
          },
        });
      }
      throw error;
    }
    const encryptedAccessToken = encryptToken(tokenSet.accessToken, this.keyring);
    const encryptedRefreshToken = tokenSet.refreshToken
      ? encryptToken(tokenSet.refreshToken, this.keyring)
      : null;

    await this.prisma.socialToken.update({
      where: { id: account.token.id },
      data: {
        accessToken: encryptedAccessToken.ciphertext,
        refreshToken: encryptedRefreshToken?.ciphertext ?? account.token.refreshToken,
        encryptionKeyVersion: encryptedAccessToken.keyVersion,
        accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
        refreshTokenExpiresAt:
          tokenSet.refreshTokenExpiresAt ?? account.token.refreshTokenExpiresAt,
        lastRefreshedAt: new Date(),
        refreshFailedCount: 0,
      },
    });

    return tokenSet.accessToken;
  }

  private async consumeState(state: string): Promise<OAuthStatePayload> {
    await this.redis.connect();
    const raw = (await this.redis
      .getClient()
      .eval(
        "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v",
        1,
        this.stateKey(state),
      )) as string | null;

    if (!raw) throw AppError.validation('OAuth state không hợp lệ hoặc đã hết hạn.');
    return JSON.parse(raw) as OAuthStatePayload;
  }

  private async userIdFromSessionCookie(cookieHeader: string | undefined): Promise<string | null> {
    const token = this.readSessionToken(cookieHeader);
    if (!token) return null;

    const session = await this.prisma.session.findUnique({
      where: { sessionToken: hashToken(token) },
      select: { userId: true, expiresAt: true },
    });

    if (!session || session.expiresAt <= new Date()) return null;
    return session.userId;
  }

  private readSessionToken(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const prefix = `${this.env.SESSION_COOKIE_NAME}=`;
    const cookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
  }

  private async enqueueRefreshJob(socialAccountId: string, workspaceId: string): Promise<void> {
    const payload = {
      socialAccountId,
      workspaceId,
    };
    const jobId = buildJobId('refresh-social-token', payload);
    await this.refreshQueue.add('refresh-social-token', payload, {
      ...buildQueueJobOptions('refresh-social-token', jobId, { delay: 50 * 60 * 1000 }),
    });
  }

  private async removePendingJobsForSocialAccount(
    workspaceId: string,
    socialAccountId: string,
  ): Promise<void> {
    const platformPosts = await this.prisma.platformPost.findMany({
      where: {
        workspaceId,
        socialAccountId,
        status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'FAILED'] },
      },
      select: { id: true },
    });

    await Promise.all([
      this.refreshQueue
        .getJob(buildJobId('refresh-social-token', { socialAccountId, workspaceId }))
        .then((job) => job?.remove()),
      ...platformPosts.map((platformPost) => {
        const publishPayload = {
          platformPostId: platformPost.id,
          workspaceId,
          correlationId: 'disconnect',
        };
        const retryPayload = {
          platformPostId: platformPost.id,
          workspaceId,
          requestedByUserId: 'disconnect',
        };
        return Promise.all([
          this.publishQueue
            .getJob(buildJobId('publish-post', publishPayload))
            .then((job) => job?.remove()),
          this.retryQueue
            .getJob(buildJobId('retry-failed-post', retryPayload))
            .then((job) => job?.remove()),
        ]);
      }),
    ]);
  }
  async triggerSyncExternalPosts(
    workspaceId: string,
    socialAccountId: string,
    requestedByUserId: string,
    auditCtx: AuditContext,
  ) {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
    });
    if (!account) throw AppError.notFound('Không tìm thấy tài khoản');

    const registry = await this.adapterFactory.forWorkspace(workspaceId);
    registry.requireCapability(account.platform, 'getPosts');

    const activeJob = await this.prisma.externalPostSyncJob.findFirst({
      where: {
        socialAccountId,
        workspaceId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
    if (activeJob) {
      throw AppError.conflict('Tài khoản này đang được đồng bộ bài viết. Vui lòng chờ.');
    }

    const lastCompletedJob = await this.prisma.externalPostSyncJob.findFirst({
      where: {
        socialAccountId,
        workspaceId,
        status: 'COMPLETED',
      },
      orderBy: { finishedAt: 'desc' },
    });

    if (lastCompletedJob && lastCompletedJob.finishedAt) {
      const cooldownHours = this.env.EXTERNAL_POST_SYNC_MANUAL_COOLDOWN_HOURS;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const timeSinceLastSync = Date.now() - lastCompletedJob.finishedAt.getTime();
      if (timeSinceLastSync < cooldownMs) {
        const remainingHours = Math.ceil((cooldownMs - timeSinceLastSync) / (60 * 60 * 1000));
        throw AppError.conflict(
          `Vui lòng chờ ${remainingHours} giờ nữa để đồng bộ lại (giới hạn ${cooldownHours}h/lần).`,
        );
      }
    }

    const lastFailedJob = await this.prisma.externalPostSyncJob.findFirst({
      where: {
        socialAccountId,
        workspaceId,
        status: 'FAILED',
      },
      orderBy: { finishedAt: 'desc' },
    });
    if (lastFailedJob && lastFailedJob.finishedAt) {
      const cooldownMs = 15 * 60 * 1000;
      const timeSinceLastSync = Date.now() - lastFailedJob.finishedAt.getTime();
      if (timeSinceLastSync < cooldownMs) {
        const remainingMins = Math.ceil((cooldownMs - timeSinceLastSync) / (60 * 1000));
        throw AppError.conflict(
          `Tiến trình trước bị lỗi. Vui lòng thử lại sau ${remainingMins} phút.`,
        );
      }
    }

    await this.audit.record({
      action: 'EXTERNAL_POSTS_SYNC_REQUESTED',
      workspaceId,
      actorUserId: requestedByUserId,
      metadata: { socialAccountId, platform: account.platform },
      ...auditCtx,
    });

    const cutoffDays = this.env.EXTERNAL_POST_SYNC_CUTOFF_DAYS;
    const cutoffDate = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000);

    const syncJob = await this.prisma.externalPostSyncJob.create({
      data: {
        workspaceId,
        socialAccountId,
        platform: account.platform,
        status: 'QUEUED',
        cutoffDate,
        createdByUserId: requestedByUserId,
      },
    });

    const payload = {
      workspaceId,
      socialAccountId,
      requestedByUserId,
      cutoffDays,
      resumeFromJobId: syncJob.id,
    };
    const jobId = buildJobId('sync-external-posts', payload);
    const opts = buildQueueJobOptions('sync-external-posts', jobId);
    const backgroundJob = await this.prisma.backgroundJob.upsert({
      where: { queueName_jobId: { queueName: 'sync-external-posts', jobId } },
      create: {
        workspaceId,
        queueName: 'sync-external-posts',
        jobId,
        status: 'QUEUED',
        payload: payload as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: opts.attempts,
        correlationId: syncJob.id,
      },
      update: {
        workspaceId,
        status: 'QUEUED',
        payload: payload as Prisma.InputJsonValue,
        attempts: 0,
        maxAttempts: opts.attempts,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        isDead: false,
        correlationId: syncJob.id,
      },
    });

    await this.syncExternalPostsQueue.add('sync-external-posts', payload, opts);

    return {
      jobId: syncJob.id,
      backgroundJobId: backgroundJob.id,
      status: 'QUEUED',
      message: 'Đã đưa job đồng bộ lịch sử vào queue.',
    };
  }

  private redirectUri(platform: Platform): string {
    return `${this.env.API_BASE_URL.replace(/\/$/, '')}/api/v1/oauth/${platform.toLowerCase()}/callback`;
  }

  private scopesFor(platform: Platform): string[] {
    if (platform === 'FACEBOOK') return [...FACEBOOK_PAGES_OAUTH_SCOPES];
    if (platform === 'INSTAGRAM') return [...INSTAGRAM_OAUTH_SCOPES];
    if (platform === 'PINTEREST') return [...PINTEREST_OAUTH_SCOPES];
    if (platform === 'YOUTUBE') return [...YOUTUBE_OAUTH_SCOPES];
    if (platform === 'TIKTOK') return [...TIKTOK_OAUTH_SCOPES];
    return ['development-fixture'];
  }

  private stateKey(state: string): string {
    return `oauth:state:${state}`;
  }
}

function hasTikTokCreatorInfo(adapter: SocialPlatformAdapter): adapter is SocialPlatformAdapter & {
  queryCreatorInfo(ctx: {
    accessToken: string;
    externalAccountId: string;
    externalPageId?: string;
    correlationId: string;
  }): Promise<TikTokCreatorInfo>;
} {
  return typeof (adapter as { queryCreatorInfo?: unknown }).queryCreatorInfo === 'function';
}

function hasPinterestBoardBrowser(
  adapter: SocialPlatformAdapter,
): adapter is SocialPlatformAdapter & {
  listBoards(ctx: {
    accessToken: string;
    externalAccountId: string;
    externalPageId?: string;
    correlationId: string;
  }): Promise<PinterestBoardSummary[]>;
  listBoardSections(
    ctx: {
      accessToken: string;
      externalAccountId: string;
      externalPageId?: string;
      correlationId: string;
    },
    boardId: string,
  ): Promise<PinterestBoardSectionSummary[]>;
} {
  const candidate = adapter as {
    listBoards?: unknown;
    listBoardSections?: unknown;
  };
  return (
    typeof candidate.listBoards === 'function' && typeof candidate.listBoardSections === 'function'
  );
}
