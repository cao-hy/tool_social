import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  createProxiedFetch,
  createDirectFetch,
  normalizeStoreProxyTargets,
  ProxyRuntimeService,
  ProxyConfigurationError,
  type PreparedProxyContext,
} from '@socialhub/config';
import {
  AdapterRegistry,
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
} from '@socialhub/platform-adapters';
import type { Platform, StoreProxyTarget } from '@socialhub/shared';
import {
  decryptToken,
  ProxyPolicyService,
  RedisProxyPolicyCache,
  type Keyring,
  type MinimalRedisClient,
} from '@socialhub/security';

import { ENV, type ApiEnv } from './env.provider';
import { PrismaService } from './prisma/prisma.service';
import { KEYRING } from './tokens';
import { RedisService } from './redis/redis.service';
import type { WorkspaceAdapterContext, WorkspaceRouteOptions } from '@socialhub/social-runtime';

@Injectable()
export class AdapterRegistryFactory implements OnModuleDestroy {
  private readonly proxyRuntime: ProxyRuntimeService;
  private offlineRegistry?: AdapterRegistry;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {
    const policyCache = new RedisProxyPolicyCache(
      this.redisService.getClient() as MinimalRedisClient,
    );
    const policyService = new ProxyPolicyService(policyCache, this.env.PROXY_FINGERPRINT_SECRET);
    this.proxyRuntime = new ProxyRuntimeService(policyService, this.env.PROXY_FINGERPRINT_SECRET);
  }

  getProxyRuntime(): ProxyRuntimeService {
    return this.proxyRuntime;
  }

  offlineAdapters(): AdapterRegistry {
    if (!this.offlineRegistry) {
      const offlineFetch: typeof fetch = async () => {
        throw new ProxyConfigurationError(
          'Offline adapter registry cannot execute outbound HTTP requests. Use forWorkspace() or withWorkspace().',
        );
      };
      this.offlineRegistry = this.createInternal(offlineFetch);
    }
    return this.offlineRegistry;
  }

  async onModuleDestroy() {
    await this.proxyRuntime.closeAll();
  }

  async forWorkspace(
    workspaceId: string,
    route?: WorkspaceRouteOptions,
  ): Promise<WorkspaceAdapterContext> {
    if (route?.storeId) {
      return await this.forStoreRoute(workspaceId, route.storeId, route.target);
    }

    const directFetch = createDirectFetch();
    const fetchImpl: typeof fetch = (input, init) => directFetch(input, init);
    const directCtx: PreparedProxyContext = {
      enabled: false,
      egressPolicy: 'DIRECT_ALLOWED',
      config: {
        enabled: false,
        countryLock: null,
        proxyUrl: null,
        proxyUrlMasked: null,
        source: 'DIRECT',
        version: 0,
      },
      configVersion: 0,
      routeFingerprint: null,
      attestation: null,
    };

    return {
      adapters: this.createInternal(fetchImpl),
      proxy: directCtx,
      release: async () => undefined,
    };
  }

  async prepareTargetFetch(
    workspaceId: string,
    storeId: string,
    target: StoreProxyTarget,
    options?: { forceAttestation?: boolean },
  ): Promise<{
    fetch: typeof fetch;
    proxy: PreparedProxyContext;
    release: () => Promise<void>;
  }> {
    const storeSetting =
      (await this.prisma.storeProxySetting?.findFirst({
        where: { storeId, workspaceId },
      })) ?? null;
    const enabledTargets = storeSetting?.enabled
      ? normalizeStoreProxyTargets(storeSetting.targets)
      : [];
    const shouldProxy = Boolean(storeSetting?.enabled && enabledTargets.includes(target));

    if (!shouldProxy) {
      const directCtx: PreparedProxyContext = {
        enabled: false,
        egressPolicy: 'DIRECT_ALLOWED',
        config: {
          enabled: false,
          countryLock: storeSetting?.countryLock ?? null,
          proxyUrl: null,
          proxyUrlMasked: storeSetting?.proxyUrlMasked ?? null,
          source: 'DIRECT',
          targets: enabledTargets,
          version: storeSetting?.configVersion ?? 0,
        },
        configVersion: storeSetting?.configVersion ?? 0,
        routeFingerprint: null,
        attestation: null,
      };
      const directFetch = createDirectFetch();
      return {
        fetch: (input, init) => directFetch(input, init),
        proxy: directCtx,
        release: async () => undefined,
      };
    }

    const ctx = await this.proxyRuntime.prepareWorkspace(
      `store:${storeId}`,
      async () => storeSetting,
      (ciphertext) => decryptToken(ciphertext, this.keyring),
      {
        forceAttestation: options?.forceAttestation,
        getWorkspaceConfigVersion: async () =>
          (
            await this.prisma.storeProxySetting.findFirst({
              where: { storeId, workspaceId },
              select: { configVersion: true },
            })
          )?.configVersion ?? null,
        getWorkspaceEgressPolicy: async () => 'PROXY_REQUIRED',
      },
    );
    ctx.config = {
      ...ctx.config,
      source: 'STORE',
      targets: enabledTargets,
    };

    if (!ctx.dispatcherHandle) {
      throw new ProxyConfigurationError('Validated proxy dispatcher is missing.');
    }

    const proxiedFetch = createProxiedFetch(
      { ...ctx.config, enabled: true, proxyUrl: ctx.config.proxyUrl as string },
      ctx.dispatcherHandle,
    );

    let released = false;
    return {
      fetch: (input, init) => proxiedFetch(input, init),
      proxy: ctx,
      release: async () => {
        if (!released) {
          released = true;
          ctx.dispatcherHandle?.release();
        }
      },
    };
  }

  private async forStoreRoute(
    workspaceId: string,
    storeId: string,
    target?: StoreProxyTarget,
  ): Promise<WorkspaceAdapterContext> {
    if (target) {
      const prepared = await this.prepareTargetFetch(workspaceId, storeId, target);
      return {
        adapters: this.createInternal(prepared.fetch),
        proxy: prepared.proxy,
        release: prepared.release,
      };
    }

    const storeSetting =
      (await this.prisma.storeProxySetting?.findFirst({
        where: { storeId, workspaceId },
      })) ?? null;
    const enabledTargets = storeSetting?.enabled
      ? normalizeStoreProxyTargets(storeSetting.targets)
      : [];
    const socialTargets = enabledTargets.filter((t): t is Platform => t !== 'SHOPIFY');
    const directFetch = createDirectFetch();

    const firstTarget = socialTargets[0];
    if (!storeSetting?.enabled || !firstTarget) {
      const directCtx: PreparedProxyContext = {
        enabled: false,
        egressPolicy: 'DIRECT_ALLOWED',
        config: {
          enabled: false,
          countryLock: storeSetting?.countryLock ?? null,
          proxyUrl: null,
          proxyUrlMasked: storeSetting?.proxyUrlMasked ?? null,
          source: 'DIRECT',
          targets: enabledTargets,
          version: storeSetting?.configVersion ?? 0,
        },
        configVersion: storeSetting?.configVersion ?? 0,
        routeFingerprint: null,
        attestation: null,
      };
      return {
        adapters: this.createInternal((input, init) => directFetch(input, init)),
        proxy: directCtx,
        release: async () => undefined,
      };
    }

    const prepared = await this.prepareTargetFetch(workspaceId, storeId, firstTarget);
    const enabledSet = new Set<Platform>(socialTargets);
    const platformFetchOverrides: Partial<Record<Platform, typeof fetch>> = {};
    for (const platform of ['FACEBOOK', 'INSTAGRAM', 'PINTEREST', 'YOUTUBE', 'TIKTOK'] as const) {
      platformFetchOverrides[platform] = enabledSet.has(platform)
        ? prepared.fetch
        : (input, init) => directFetch(input, init);
    }

    return {
      adapters: this.createInternal(
        (input, init) => directFetch(input, init),
        platformFetchOverrides,
      ),
      proxy: prepared.proxy,
      release: prepared.release,
    };
  }

  async withWorkspace<T>(
    workspaceId: string,
    fn: (ctx: WorkspaceAdapterContext) => Promise<T>,
    route?: WorkspaceRouteOptions,
  ): Promise<T> {
    const ctx = await this.forWorkspace(workspaceId, route);
    try {
      return await fn(ctx);
    } finally {
      await ctx.release();
    }
  }

  private createInternal(
    fetchImpl: typeof fetch,
    platformFetch?: Partial<Record<Platform, typeof fetch>>,
  ): AdapterRegistry {
    const env = this.env;
    return createRuntimeAdapterRegistry({
      nodeEnv: env.NODE_ENV,
      fetch: fetchImpl,
      facebook: {
        appId: env.FACEBOOK_APP_ID,
        appSecret: env.FACEBOOK_APP_SECRET,
        apiVersion: env.FACEBOOK_API_VERSION,
        loginConfigId: env.FACEBOOK_LOGIN_CONFIG_ID,
        fetch: platformFetch?.FACEBOOK,
      },
      instagram: {
        appId: env.INSTAGRAM_APP_ID,
        appSecret: env.INSTAGRAM_APP_SECRET,
        apiVersion: env.FACEBOOK_API_VERSION,
        fetch: platformFetch?.INSTAGRAM,
      },
      pinterest: {
        appId: env.PINTEREST_APP_ID,
        appSecret: env.PINTEREST_APP_SECRET,
        defaultBoardName: env.PINTEREST_DEFAULT_BOARD_NAME,
        environment: env.PINTEREST_API_ENVIRONMENT,
        fetch: platformFetch?.PINTEREST,
      },
      youtube: {
        clientId: env.YOUTUBE_CLIENT_ID,
        clientSecret: env.YOUTUBE_CLIENT_SECRET,
        fetch: platformFetch?.YOUTUBE,
      },
      tiktok: {
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        scopes: [...TIKTOK_OAUTH_SCOPES],
        fetch: platformFetch?.TIKTOK,
      },
    });
  }
}
