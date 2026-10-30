import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import {
  DevelopmentFixtureAdapter,
  FACEBOOK_PAGES_OAUTH_SCOPES,
  INSTAGRAM_OAUTH_SCOPES,
  PINTEREST_OAUTH_SCOPES,
  TIKTOK_OAUTH_SCOPES,
  YOUTUBE_OAUTH_SCOPES,
  type SocialPlatformAdapter,
  type TikTokCreatorInfo,
  type TokenSet,
} from '@socialhub/platform-adapters';
import type { Prisma } from '@socialhub/db';
import type { Platform } from '@socialhub/shared';
import { RedisTokenRefreshLock } from '@socialhub/social-runtime';
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
import { getFreshAccessTokenViaCentralService } from '../../infrastructure/token-refresh';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { formatStoreProxySummary, formatStoreShopifySummary } from './store-integrations.service';

const OAUTH_STATE_TTL_SECONDS = 60 * 60;

interface OAuthStatePayload {
  userId: string;
  workspaceId: string;
  storeId?: string;
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
    @Optional() @Inject(EventsService) private readonly events?: EventsService,
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

  async list(workspaceId: string, storeId?: string) {
    const where: Prisma.SocialAccountWhereInput = {
      workspaceId,
      deletedAt: null,
    };
    if (storeId === 'UNASSIGNED') {
      where.storeId = null;
    } else if (storeId) {
      where.storeId = storeId;
    }

    const accounts = await this.prisma.socialAccount.findMany({
      where,
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            color: true,
            isDefault: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      items: accounts.map((account) => ({
        id: account.id,
        storeId: account.storeId ?? null,
        store: account.store ?? null,
        platform: account.platform,
        externalAccountId: account.externalAccountId,
        externalPageId: account.externalPageId ?? null,
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

  async listStores(workspaceId: string) {
    const stores = await this.prisma.store.findMany({
      where: { workspaceId },
      include: {
        proxySetting: true,
        shopifySetting: true,
        socialAccounts: {
          where: { deletedAt: null },
          select: {
            id: true,
            platform: true,
            name: true,
            username: true,
            avatarUrl: true,
            status: true,
            externalAccountId: true,
            externalPageId: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    return {
      items: stores.map((store) => ({
        id: store.id,
        workspaceId: store.workspaceId,
        name: store.name,
        slug: store.slug,
        description: store.description,
        color: store.color,
        avatarUrl: store.avatarUrl,
        isDefault: store.isDefault,
        accountCount: store.socialAccounts.length,
        accounts: store.socialAccounts,
        proxy: formatStoreProxySummary(store.proxySetting),
        shopify: formatStoreShopifySummary(store.shopifySetting),
        createdAt: store.createdAt,
        updatedAt: store.updatedAt,
      })),
    };
  }

  async createStore(
    workspaceId: string,
    actorUserId: string,
    input: {
      name: string;
      description?: string | null;
      color?: string | null;
      isDefault?: boolean;
      socialAccountIds?: string[];
    },
    auditContext: AuditContext,
  ) {
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      throw AppError.validation('Tên Store không được để trống.');
    }

    const baseSlug = slugifyStoreName(trimmedName);
    const existingByName = await this.prisma.store.findFirst({
      where: { workspaceId, name: { equals: trimmedName, mode: 'insensitive' } },
    });
    if (existingByName) {
      throw AppError.conflict(`Store "${trimmedName}" đã tồn tại trong Workspace này.`);
    }

    const existingCount = await this.prisma.store.count({ where: { workspaceId } });
    const color =
      input.color?.trim() || STORE_PALETTE[existingCount % STORE_PALETTE.length] || '#2563eb';

    const store = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.store.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const slug = await this.resolveUniqueStoreSlug(tx, workspaceId, baseSlug);
      const created = await tx.store.create({
        data: {
          workspaceId,
          name: trimmedName,
          slug,
          description: input.description?.trim() || null,
          color,
          isDefault: Boolean(input.isDefault),
        },
      });

      if (input.socialAccountIds && input.socialAccountIds.length > 0) {
        await tx.socialAccount.updateMany({
          where: {
            workspaceId,
            id: { in: input.socialAccountIds },
            deletedAt: null,
          },
          data: { storeId: created.id },
        });
      }

      return created;
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'Store',
      resourceId: store.id,
      after: { name: store.name, slug: store.slug },
    });

    const refreshed = await this.listStores(workspaceId);
    return refreshed.items.find((item) => item.id === store.id) ?? store;
  }

  async updateStore(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    input: {
      name?: string;
      description?: string | null;
      color?: string | null;
      isDefault?: boolean;
      socialAccountIds?: string[];
    },
    auditContext: AuditContext,
  ) {
    const existing = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
    });
    if (!existing) throw AppError.notFound('store');

    const nextName = input.name !== undefined ? input.name.trim() : existing.name;
    if (!nextName) {
      throw AppError.validation('Tên Store không được để trống.');
    }

    if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await this.prisma.store.findFirst({
        where: {
          workspaceId,
          id: { not: storeId },
          name: { equals: nextName, mode: 'insensitive' },
        },
      });
      if (duplicate) {
        throw AppError.conflict(`Store "${nextName}" đã tồn tại trong Workspace này.`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.store.updateMany({
          where: { workspaceId, isDefault: true, id: { not: storeId } },
          data: { isDefault: false },
        });
      }

      const nextSlug =
        nextName.toLowerCase() !== existing.name.toLowerCase()
          ? await this.resolveUniqueStoreSlug(tx, workspaceId, slugifyStoreName(nextName), storeId)
          : existing.slug;

      await tx.store.update({
        where: { id: storeId },
        data: {
          name: nextName,
          slug: nextSlug,
          ...(input.description !== undefined
            ? { description: input.description?.trim() || null }
            : {}),
          ...(input.color !== undefined ? { color: input.color?.trim() || existing.color } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });

      if (input.socialAccountIds !== undefined) {
        await tx.socialAccount.updateMany({
          where: {
            workspaceId,
            storeId,
            id: { notIn: input.socialAccountIds },
          },
          data: { storeId: null },
        });
        if (input.socialAccountIds.length > 0) {
          await tx.socialAccount.updateMany({
            where: {
              workspaceId,
              id: { in: input.socialAccountIds },
              deletedAt: null,
            },
            data: { storeId },
          });
        }
      }
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'Store',
      resourceId: storeId,
      before: { name: existing.name },
      after: { name: nextName },
    });

    const refreshed = await this.listStores(workspaceId);
    return refreshed.items.find((item) => item.id === storeId);
  }

  async deleteStore(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const existing = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
    });
    if (!existing) throw AppError.notFound('store');

    await this.prisma.$transaction([
      this.prisma.socialAccount.updateMany({
        where: { workspaceId, storeId },
        data: { storeId: null },
      }),
      this.prisma.contentPost.updateMany({
        where: { workspaceId, storeId },
        data: { storeId: null },
      }),
      this.prisma.store.delete({
        where: { id: storeId },
      }),
    ]);

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'Store',
      resourceId: storeId,
      before: { name: existing.name, slug: existing.slug },
    });

    return { deleted: true };
  }

  async assignAccountStore(
    workspaceId: string,
    socialAccountId: string,
    storeId: string | null,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
    });
    if (!account) throw AppError.notFound('social account');

    if (storeId !== null) {
      const store = await this.prisma.store.findFirst({
        where: { id: storeId, workspaceId },
      });
      if (!store) throw AppError.notFound('store');
    }

    const updated = await this.prisma.socialAccount.update({
      where: { id: account.id },
      data: { storeId },
      include: {
        store: {
          select: { id: true, name: true, slug: true, color: true, isDefault: true },
        },
      },
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      before: { storeId: account.storeId },
      after: { storeId },
    });

    return {
      id: updated.id,
      storeId: updated.storeId ?? null,
      store: updated.store ?? null,
    };
  }

  async autoGroupStores(workspaceId: string, actorUserId: string, auditContext: AuditContext) {
    if (!this.prisma.store) {
      return { groupedAccounts: 0, storesCreated: 0 };
    }

    const accounts = await this.prisma.socialAccount.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (accounts.length === 0) {
      return { groupedAccounts: 0, storesCreated: 0 };
    }

    let storesCreated = 0;
    let groupedAccounts = 0;

    await this.prisma.$transaction(async (tx) => {
      const existingStores = await tx.store.findMany({ where: { workspaceId } });
      const storeBySlug = new Map(existingStores.map((s) => [s.slug, s]));
      const storeByNameLower = new Map(existingStores.map((s) => [s.name.toLowerCase(), s]));

      const ensureStoreForBrand = async (rawBrandName: string, avatarUrl?: string | null) => {
        const cleanName = inferBrandStoreName(rawBrandName);
        const slugBase = slugifyStoreName(cleanName);
        const matched = storeByNameLower.get(cleanName.toLowerCase()) ?? storeBySlug.get(slugBase);
        if (matched) return matched;

        const slug = await this.resolveUniqueStoreSlug(tx, workspaceId, slugBase);
        const color =
          STORE_PALETTE[(existingStores.length + storesCreated) % STORE_PALETTE.length] ??
          '#2563eb';
        const created = await tx.store.create({
          data: {
            workspaceId,
            name: cleanName,
            slug,
            color,
            avatarUrl: avatarUrl ?? null,
          },
        });
        storesCreated += 1;
        storeBySlug.set(created.slug, created);
        storeByNameLower.set(created.name.toLowerCase(), created);
        return created;
      };

      const fbByExternalId = new Map(
        accounts
          .filter((a) => a.platform === 'FACEBOOK')
          .map((a) => [a.externalPageId ?? a.externalAccountId, a]),
      );

      for (const fbAccount of accounts.filter((a) => a.platform === 'FACEBOOK')) {
        if (!fbAccount.storeId) {
          const store = await ensureStoreForBrand(fbAccount.name, fbAccount.avatarUrl);
          await tx.socialAccount.update({
            where: { id: fbAccount.id },
            data: { storeId: store.id },
          });
          fbAccount.storeId = store.id;
          groupedAccounts += 1;
        }
      }

      for (const account of accounts.filter((a) => a.platform !== 'FACEBOOK')) {
        if (account.storeId) continue;

        if (account.platform === 'INSTAGRAM' && account.externalPageId) {
          const pairedFb = fbByExternalId.get(account.externalPageId);
          if (pairedFb?.storeId) {
            await tx.socialAccount.update({
              where: { id: account.id },
              data: { storeId: pairedFb.storeId },
            });
            account.storeId = pairedFb.storeId;
            groupedAccounts += 1;
            continue;
          }
        }

        const brandCandidate = inferBrandStoreName(account.name);
        const existingMatch =
          storeByNameLower.get(brandCandidate.toLowerCase()) ??
          storeBySlug.get(slugifyStoreName(brandCandidate));
        if (existingMatch) {
          await tx.socialAccount.update({
            where: { id: account.id },
            data: { storeId: existingMatch.id },
          });
          account.storeId = existingMatch.id;
          groupedAccounts += 1;
        }
      }
    });

    if (storesCreated > 0 || groupedAccounts > 0) {
      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'WORKSPACE_SETTINGS_CHANGED',
        resourceType: 'Store',
        metadata: { storesCreated, groupedAccounts, autoGroup: true },
      });
    }

    return {
      storesCreated,
      groupedAccounts,
      stores: (await this.listStores(workspaceId)).items,
    };
  }

  private async resolveUniqueStoreSlug(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    baseSlug: string,
    excludeStoreId?: string,
  ): Promise<string> {
    const cleanBase = baseSlug || 'store';
    let candidate = cleanBase;
    let suffix = 2;

    while (true) {
      const existing = await tx.store.findFirst({
        where: {
          workspaceId,
          slug: candidate,
          ...(excludeStoreId ? { id: { not: excludeStoreId } } : {}),
        },
        select: { id: true },
      });
      if (!existing) return candidate;
      candidate = `${cleanBase}-${suffix}`;
      suffix += 1;
    }
  }

  async startOAuth(
    userId: string,
    workspaceId: string,
    platform: Platform,
    storeId?: string,
  ): Promise<{ authorizationUrl: string; expiresInSeconds: number; developmentFixture: boolean }> {
    const cleanStoreId = storeId?.trim() || undefined;
    if (cleanStoreId) {
      const storeExists = await this.prisma.store?.findFirst({
        where: { id: cleanStoreId, workspaceId },
        select: { id: true },
      });
      if (!storeExists) throw AppError.notFound('store');
    }

    const state = generateOAuthState();
    const pkce = generatePkcePair();
    const scopes = this.scopesFor(platform);
    const redirectUri = this.redirectUri(platform);
    const adapterState =
      typeof this.adapterFactory.offlineAdapters === 'function'
        ? (() => {
            const adapter = this.adapterFactory.offlineAdapters().get(platform);
            return {
              authorizationUrl: adapter.buildAuthorizationUrl({
                redirectUri,
                state,
                scopes,
                codeChallenge: pkce.challenge,
              }),
              developmentFixture: adapter instanceof DevelopmentFixtureAdapter,
            };
          })()
        : await this.adapterFactory.withWorkspace(
            workspaceId,
            async ({ adapters }) => {
              const adapter = adapters.get(platform);
              return {
                authorizationUrl: adapter.buildAuthorizationUrl({
                  redirectUri,
                  state,
                  scopes,
                  codeChallenge: pkce.challenge,
                }),
                developmentFixture: adapter instanceof DevelopmentFixtureAdapter,
              };
            },
            { storeId: cleanStoreId ?? null, target: platform },
          );

    await this.redis.connect();
    await this.redis.getClient().set(
      this.stateKey(state),
      JSON.stringify({
        userId,
        workspaceId,
        ...(cleanStoreId ? { storeId: cleanStoreId } : {}),
        platform,
        codeVerifier: pkce.verifier,
        scopes,
        createdAt: new Date().toISOString(),
      } satisfies OAuthStatePayload),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );

    return {
      authorizationUrl: adapterState.authorizationUrl,
      expiresInSeconds: OAUTH_STATE_TTL_SECONDS,
      developmentFixture: adapterState.developmentFixture,
    };
  }

  async completeOAuth(input: {
    code: string;
    state: string;
    platform: Platform;
    currentUserId?: string;
    cookieHeader?: string;
    auditContext: AuditContext;
  }): Promise<{
    workspaceId: string;
    socialAccountId: string;
    accountName: string;
    platform: Platform;
    crossBrowser: boolean;
  }> {
    const payload = await this.consumeState(input.state);
    if (payload.platform !== input.platform) throw AppError.validation('OAuth state sai nền tảng.');
    const currentUserId =
      input.currentUserId ?? (await this.userIdFromSessionCookie(input.cookieHeader));

    if (currentUserId && payload.userId !== currentUserId) {
      throw AppError.forbidden(
        'OAuth callback yêu cầu phiên đăng nhập hợp lệ và phải khớp với tài khoản yêu cầu kết nối.',
      );
    }
    const crossBrowser = !currentUserId;

    const adapterCtx = await this.adapterFactory.forWorkspace(payload.workspaceId, {
      storeId: payload.storeId ?? null,
      target: input.platform,
    });
    try {
      const adapter = adapterCtx.adapters.get(input.platform);
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
            ...(profile.externalPageId
              ? { OR: [{ externalPageId: profile.externalPageId }, { externalPageId: null }] }
              : { externalPageId: null }),
          },
        });

        const socialAccount = existingAccount
          ? await tx.socialAccount.update({
              where: { id: existingAccount.id },
              data: {
                ...(profile.externalPageId ? { externalPageId: profile.externalPageId } : {}),
                ...(payload.storeId ? { storeId: payload.storeId } : {}),
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
                ...(payload.storeId ? { storeId: payload.storeId } : {}),
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

      if (tokenSet.additionalAccounts?.length) {
        for (const extraTokenSet of tokenSet.additionalAccounts) {
          await this.upsertSocialAccountFromTokenSet({
            workspaceId: payload.workspaceId,
            platform: input.platform,
            actorUserId: payload.userId,
            tokenSet: extraTokenSet,
            adapter,
            auditContext: input.auditContext,
            storeId: payload.storeId,
          });
        }
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
        accountName: account.name,
        platform: input.platform,
        crossBrowser,
      };
    } finally {
      await adapterCtx.release();
    }
  }

  async completeOAuthFromCallbackUrl(input: {
    workspaceId: string;
    actorUserId: string;
    callbackUrl: string;
    auditContext: AuditContext;
  }) {
    const raw = input.callbackUrl.trim();
    if (!raw) {
      throw AppError.validation(
        'Vui lòng dán đường link Callback OAuth từ trình duyệt Multilogin.',
      );
    }

    const normalizedUrl = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw AppError.validation('Đường link Callback không đúng định dạng URL.');
    }

    const oauthError = parsedUrl.searchParams.get('error');
    const oauthErrorDesc = parsedUrl.searchParams.get('error_description');
    if (oauthError) {
      throw AppError.validation(
        `Nền tảng từ chối cấp quyền OAuth: ${oauthError}${oauthErrorDesc ? ` (${oauthErrorDesc})` : ''}`,
      );
    }

    const code = parsedUrl.searchParams.get('code')?.trim();
    const state = parsedUrl.searchParams.get('state')?.trim();
    if (!code || !state) {
      throw AppError.validation(
        'Đường link không chứa mã code và state OAuth. Hãy đảm bảo bạn copy link sau khi trang nhảy về localhost:4000/api/v1/oauth/.../callback.',
      );
    }

    const rawState = await this.redis.getClient().get(this.stateKey(state));
    if (!rawState) {
      throw AppError.validation(
        'Mã OAuth state đã hết hạn hoặc đã được sử dụng trước đó. Hãy bấm Copy link OAuth mới và thử lại.',
      );
    }

    const statePayload = JSON.parse(rawState) as OAuthStatePayload;
    if (statePayload.workspaceId !== input.workspaceId) {
      throw AppError.forbidden('Link Callback này thuộc về một Workspace khác.');
    }

    const result = await this.completeOAuth({
      code,
      state,
      platform: statePayload.platform,
      currentUserId: input.actorUserId,
      auditContext: input.auditContext,
    });

    return {
      connected: true as const,
      socialAccountId: result.socialAccountId,
      accountName: result.accountName,
      platform: result.platform,
      workspaceId: result.workspaceId,
    };
  }

  async syncMetaToken(input: {
    workspaceId: string;
    actorUserId: string;
    accessToken?: string;
    platforms?: Array<'FACEBOOK' | 'INSTAGRAM'>;
    pageIds?: string[];
    storeId?: string | null;
    autoCreateStores?: boolean;
    auditContext: AuditContext;
  }) {
    const rawToken = input.accessToken?.trim() || this.env.META_ACCESS_TOKEN?.trim() || '';
    if (!rawToken) {
      throw AppError.validation(
        'Vui lòng nhập Meta Access Token hoặc cấu hình META_ACCESS_TOKEN trong .env.',
      );
    }

    if (input.storeId) {
      const storeExists = await this.prisma.store?.findFirst({
        where: { id: input.storeId, workspaceId: input.workspaceId },
      });
      if (!storeExists) throw AppError.notFound('store');
    }

    const platforms: Array<'FACEBOOK' | 'INSTAGRAM'> =
      input.platforms && input.platforms.length > 0 ? input.platforms : ['FACEBOOK', 'INSTAGRAM'];
    const pageIdFilter =
      input.pageIds && input.pageIds.length > 0
        ? new Set(input.pageIds.map((id) => id.trim()).filter(Boolean))
        : null;

    return await this.adapterFactory.withWorkspace(
      input.workspaceId,
      async ({ adapters }) => {
        const syncedAccounts: Array<
          Awaited<ReturnType<typeof this.upsertSocialAccountFromTokenSet>>
        > = [];
        const errors: string[] = [];

        for (const platform of platforms) {
          const adapter = adapters.get(platform);
          if (!adapter.discoverAccountsFromToken) continue;

          try {
            const discovered = await adapter.discoverAccountsFromToken(rawToken);
            const filtered = pageIdFilter
              ? discovered.filter((item) => {
                  const extId = item.accountProfile?.externalAccountId;
                  const pageId = item.accountProfile?.externalPageId;
                  return (extId && pageIdFilter.has(extId)) || (pageId && pageIdFilter.has(pageId));
                })
              : discovered;

            for (const tokenSet of filtered) {
              const saved = await this.upsertSocialAccountFromTokenSet({
                workspaceId: input.workspaceId,
                platform,
                actorUserId: input.actorUserId,
                tokenSet,
                adapter,
                auditContext: input.auditContext,
                source: 'META_TOKEN_SYNC',
                storeId: input.storeId ?? undefined,
              });
              syncedAccounts.push(saved);
            }
          } catch (err) {
            errors.push(
              `${platform}: ${err instanceof Error ? err.message : 'Không thể đọc tài khoản từ token'}`,
            );
          }
        }

        if (syncedAccounts.length === 0) {
          throw AppError.validation(
            errors.length > 0
              ? `Không đồng bộ được tài khoản nào từ Meta Token (${errors.join(' | ')}).`
              : 'Không tìm thấy Facebook Page hoặc Instagram Business nào khớp với token và bộ lọc.',
          );
        }

        if (!input.storeId && input.autoCreateStores !== false && this.prisma.store) {
          await this.autoGroupStores(input.workspaceId, input.actorUserId, input.auditContext);
        }

        return {
          syncedCount: syncedAccounts.length,
          items: syncedAccounts.map((account) => ({
            id: account.id,
            storeId: account.storeId ?? null,
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
      },
      {
        storeId: input.storeId ?? null,
        target: platforms.length === 1 ? platforms[0] : undefined,
      },
    );
  }

  private async upsertSocialAccountFromTokenSet(input: {
    workspaceId: string;
    platform: Platform;
    actorUserId: string;
    tokenSet: TokenSet;
    adapter: SocialPlatformAdapter;
    auditContext: AuditContext;
    source?: string;
    storeId?: string;
  }) {
    const encryptedAccessToken = encryptToken(input.tokenSet.accessToken, this.keyring);
    const encryptedRefreshToken = input.tokenSet.refreshToken
      ? encryptToken(input.tokenSet.refreshToken, this.keyring)
      : null;

    const profile =
      input.tokenSet.accountProfile ??
      (await input.adapter.getAccountProfile({
        accessToken: input.tokenSet.accessToken,
        externalAccountId: 'pending',
        correlationId: input.auditContext.requestId ?? 'token-sync',
      }));

    const account = await this.prisma.$transaction(async (tx) => {
      const existingAccount = await tx.socialAccount.findFirst({
        where: {
          workspaceId: input.workspaceId,
          platform: input.platform,
          externalAccountId: profile.externalAccountId,
          ...(profile.externalPageId
            ? { OR: [{ externalPageId: profile.externalPageId }, { externalPageId: null }] }
            : { externalPageId: null }),
        },
      });

      const socialAccount = existingAccount
        ? await tx.socialAccount.update({
            where: { id: existingAccount.id },
            data: {
              ...(profile.externalPageId ? { externalPageId: profile.externalPageId } : {}),
              ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
              name: profile.name,
              username: profile.username,
              avatarUrl: profile.avatarUrl,
              profileUrl: profile.profileUrl,
              status: 'CONNECTED',
              scopes: input.tokenSet.scopes,
              lastErrorAt: null,
              lastErrorMessage: null,
              deletedAt: null,
            },
          })
        : await tx.socialAccount.create({
            data: {
              workspaceId: input.workspaceId,
              ...(input.storeId !== undefined ? { storeId: input.storeId } : {}),
              platform: input.platform,
              externalAccountId: profile.externalAccountId,
              externalPageId: profile.externalPageId,
              name: profile.name,
              username: profile.username,
              avatarUrl: profile.avatarUrl,
              profileUrl: profile.profileUrl,
              status: 'CONNECTED',
              scopes: input.tokenSet.scopes,
            },
          });

      await tx.socialToken.upsert({
        where: { socialAccountId: socialAccount.id },
        create: this.tokenCreateData(
          socialAccount.id,
          input.tokenSet,
          encryptedAccessToken,
          encryptedRefreshToken,
        ),
        update: this.tokenUpdateData(input.tokenSet, encryptedAccessToken, encryptedRefreshToken),
      });

      return socialAccount;
    });

    await this.audit.record({
      ...input.auditContext,
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      action: 'SOCIAL_ACCOUNT_CONNECTED',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      metadata: {
        platform: input.platform,
        source: input.source ?? 'OAUTH',
        developmentFixture: input.adapter instanceof DevelopmentFixtureAdapter,
      },
    });

    if (input.tokenSet.refreshToken) {
      await this.enqueueRefreshJob(account.id, input.workspaceId);
    }

    return account;
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

    const disconnecting = await this.prisma.socialAccount.updateMany({
      where: { id: socialAccountId, workspaceId, deletedAt: null, status: { not: 'DISCONNECTED' } },
      data: {
        status: 'DISCONNECTING',
        disconnectGeneration: { increment: 1 },
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
    if (disconnecting.count !== 1) throw AppError.conflict('Tài khoản đang ngắt kết nối.');

    await this.removePendingJobsForSocialAccount(workspaceId, socialAccountId).catch((error) => {
      logger.warn(
        {
          socialAccountId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove pending jobs during disconnection. DISCONNECTING state still blocks dispatch.',
      );
    });

    try {
      await this.adapterFactory.withWorkspace(
        workspaceId,
        async ({ adapters }) => {
          const adapter = adapters.get(account.platform);
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
        },
        { storeId: account.storeId ?? null, target: account.platform },
      );
    } catch (error) {
      logger.warn(
        {
          socialAccountId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to prepare revoke route during disconnection. Proceeding to delete account anyway.',
      );
    }

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

    const profile = await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
        const adapter = adapters.get(account.platform);
        const accessToken = await this.getFreshAccessToken(account, adapter);
        return await adapter.getAccountProfile({
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: auditContext.requestId ?? 'test-connection',
        });
      },
      { storeId: account.storeId ?? null, target: account.platform },
    );

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

    const creatorInfo = await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
        const adapter = adapters.get(account.platform);
        if (!hasTikTokCreatorInfo(adapter)) {
          throw AppError.capabilityUnsupported('TIKTOK', 'queryCreatorInfo');
        }

        const accessToken = await this.getFreshAccessToken(account, adapter);
        return await adapter.queryCreatorInfo({
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: auditContext.requestId ?? 'tiktok-creator-info',
        });
      },
      { storeId: account.storeId ?? null, target: account.platform },
    );

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

    const items = await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
        const adapter = adapters.get(account.platform);
        if (!hasPinterestBoardBrowser(adapter)) {
          throw AppError.conflict(
            'Pinterest API có hỗ trợ đọc board/section, nhưng adapter đang chạy chưa có chức năng này. Hãy kiểm tra app đang dùng Pinterest adapter thật và build/deploy đã cập nhật.',
          );
        }

        const accessToken = await this.getFreshAccessToken(account, adapter);
        return await adapter.listBoards({
          accessToken,
          externalAccountId: account.externalAccountId,
          externalPageId: account.externalPageId ?? undefined,
          correlationId: auditContext.requestId ?? 'pinterest-list-boards',
        });
      },
      { storeId: account.storeId ?? null, target: account.platform },
    );
    return {
      items,
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

    const items = await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
        const adapter = adapters.get(account.platform);
        if (!hasPinterestBoardBrowser(adapter)) {
          throw AppError.conflict(
            'Pinterest API có hỗ trợ đọc board/section, nhưng adapter đang chạy chưa có chức năng này. Hãy kiểm tra app đang dùng Pinterest adapter thật và build/deploy đã cập nhật.',
          );
        }

        const accessToken = await this.getFreshAccessToken(account, adapter);
        return await adapter.listBoardSections(
          {
            accessToken,
            externalAccountId: account.externalAccountId,
            externalPageId: account.externalPageId ?? undefined,
            correlationId: auditContext.requestId ?? 'pinterest-list-board-sections',
          },
          boardId,
        );
      },
      { storeId: account.storeId ?? null, target: account.platform },
    );
    return {
      items,
      fetchedAt: new Date().toISOString(),
    };
  }

  async searchInstagramLocations(
    workspaceId: string,
    socialAccountId: string,
    query: string,
    auditContext: AuditContext,
  ) {
    if (!query) return [];

    const account = await this.prisma.socialAccount.findFirst({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
      include: { token: true },
    });
    if (!account) throw AppError.notFound('social account');
    if (account.platform !== 'INSTAGRAM') {
      throw AppError.validation('Tính năng này chỉ áp dụng cho Instagram.');
    }
    if (!account.token) throw AppError.conflict('Instagram account chưa có token để kiểm tra.');

    return await this.adapterFactory.withWorkspace(
      workspaceId,
      async ({ adapters }) => {
        const adapter = adapters.get(account.platform);

        // Kiểm tra xem adapter có phương thức searchLocations không
        if (
          !('searchLocations' in adapter) ||
          typeof (adapter as unknown as { searchLocations: unknown }).searchLocations !== 'function'
        ) {
          throw AppError.conflict('Instagram adapter chưa hỗ trợ tính năng tìm kiếm vị trí.');
        }

        const accessToken = await this.getFreshAccessToken(account, adapter);
        return await (
          adapter as unknown as {
            searchLocations: (ctx: unknown, query: string) => Promise<unknown[]>;
          }
        ).searchLocations(
          {
            accessToken,
            externalAccountId: account.externalAccountId,
            externalPageId: account.externalPageId ?? undefined,
            correlationId: auditContext.requestId ?? 'instagram-search-locations',
          },
          query,
        );
      },
      { storeId: account.storeId ?? null, target: account.platform },
    );
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

    if (!account.token.refreshToken) {
      throw AppError.conflict('Token đã hết hạn. Hãy ngắt kết nối rồi kết nối lại tài khoản.');
    }

    return await getFreshAccessTokenViaCentralService(
      {
        prisma: this.prisma,
        keyring: this.keyring,
        adapterFactory: this.adapterFactory,
        tokenRefreshLock: new RedisTokenRefreshLock(this.redis.getClient()),
        account,
      },
      adapter,
    );
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
    this.events?.publish(workspaceId, {
      type: 'accounts.changed',
      socialAccountId,
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

    const removals = [
      removeQueueJob(
        this.refreshQueue,
        buildJobId('refresh-social-token', { socialAccountId, workspaceId }),
      ),
      ...platformPosts.flatMap((platformPost) => {
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
        return [
          removeQueueJob(this.publishQueue, buildJobId('publish-post', publishPayload)),
          removeQueueJob(this.retryQueue, buildJobId('retry-failed-post', retryPayload)),
        ];
      }),
    ];

    const results = await Promise.allSettled(removals);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
  async triggerSyncExternalPosts(
    workspaceId: string,
    socialAccountId: string,
    requestedByUserId: string,
    auditCtx: AuditContext,
    options?: {
      cutoffDays?: number;
      sinceDate?: string;
      force?: boolean;
    },
  ) {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId, workspaceId, deletedAt: null },
    });
    if (!account) throw AppError.notFound('Không tìm thấy tài khoản');

    if (typeof this.adapterFactory.offlineAdapters === 'function') {
      this.adapterFactory.offlineAdapters().requireCapability(account.platform, 'getPosts');
    } else {
      await this.adapterFactory.withWorkspace(
        workspaceId,
        async ({ adapters }) => {
          adapters.requireCapability(account.platform, 'getPosts');
        },
        { storeId: account.storeId ?? null, target: account.platform },
      );
    }

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

    if (!options?.force) {
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
    }

    await this.audit.record({
      action: 'EXTERNAL_POSTS_SYNC_REQUESTED',
      workspaceId,
      actorUserId: requestedByUserId,
      metadata: { socialAccountId, platform: account.platform },
      ...auditCtx,
    });

    let cutoffDays = options?.cutoffDays ?? this.env.EXTERNAL_POST_SYNC_CUTOFF_DAYS;
    let cutoffDate = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000);
    if (options?.sinceDate) {
      const parsedSince = new Date(options.sinceDate);
      if (!Number.isNaN(parsedSince.getTime())) {
        cutoffDate = parsedSince;
        cutoffDays = Math.max(
          1,
          Math.ceil((Date.now() - parsedSince.getTime()) / (24 * 60 * 60 * 1000)),
        );
      }
    }

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

    await this.prisma.backgroundJob.deleteMany({
      where: {
        workspaceId,
        queueName: 'sync-external-posts',
        status: { in: ['FAILED', 'DEAD'] },
        jobId: { startsWith: `sync-external-posts-${socialAccountId}-` },
      },
    });

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
    this.events?.publish(workspaceId, {
      type: 'job.queued',
      queueName: 'sync-external-posts',
      jobId,
      socialAccountId,
    });
    this.events?.publish(workspaceId, {
      type: 'accounts.changed',
      socialAccountId,
    });

    return {
      jobId: syncJob.id,
      backgroundJobId: backgroundJob.id,
      status: 'QUEUED' as const,
      message: 'Đã đưa job đồng bộ lịch sử vào queue.',
    };
  }

  async triggerSyncExternalPostsByFilter(
    workspaceId: string,
    requestedByUserId: string,
    input: {
      storeId?: string;
      platform?: Platform;
      socialAccountId?: string;
      socialAccountIds?: string[];
      cutoffDays?: number;
      sinceDate?: string;
      force?: boolean;
    },
    auditCtx: AuditContext,
  ) {
    const accounts = await this.prisma.socialAccount.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: 'CONNECTED',
        ...(input.storeId === 'UNASSIGNED'
          ? { storeId: null }
          : input.storeId
            ? { storeId: input.storeId }
            : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.socialAccountId
          ? { id: input.socialAccountId }
          : input.socialAccountIds && input.socialAccountIds.length > 0
            ? { id: { in: input.socialAccountIds } }
            : {}),
      },
      orderBy: [{ platform: 'asc' }, { name: 'asc' }],
    });

    if (accounts.length === 0) {
      throw AppError.validation(
        'Không có kênh mạng xã hội nào đang CONNECTED khớp với bộ lọc đã chọn.',
      );
    }

    const results: Array<{
      socialAccountId: string;
      accountName: string;
      platform: Platform;
      queued: boolean;
      jobId?: string;
      backgroundJobId?: string;
      message: string;
    }> = [];

    let queuedCount = 0;
    let skippedCount = 0;

    for (const account of accounts) {
      try {
        const res = await this.triggerSyncExternalPosts(
          workspaceId,
          account.id,
          requestedByUserId,
          auditCtx,
          {
            cutoffDays: input.cutoffDays,
            sinceDate: input.sinceDate,
            force: input.force ?? true,
          },
        );
        queuedCount += 1;
        results.push({
          socialAccountId: account.id,
          accountName: account.name,
          platform: account.platform,
          queued: true,
          jobId: res.jobId,
          backgroundJobId: res.backgroundJobId,
          message: res.message,
        });
      } catch (error) {
        skippedCount += 1;
        results.push({
          socialAccountId: account.id,
          accountName: account.name,
          platform: account.platform,
          queued: false,
          message: error instanceof Error ? error.message : 'Không thể đưa vào hàng đợi đồng bộ.',
        });
      }
    }

    return {
      matchedCount: accounts.length,
      queuedCount,
      skippedCount,
      results,
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

async function removeQueueJob(queue: Queue, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId);
  await job?.remove();
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

const STORE_PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#059669',
  '#0891b2',
  '#4f46e5',
  '#b45309',
];

function slugifyStoreName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function inferBrandStoreName(rawName: string): string {
  const cleaned = rawName
    .trim()
    .replace(/\s+(store|official|shop|page|brand)$/i, '')
    .trim();
  return cleaned || rawName.trim() || 'Store';
}
