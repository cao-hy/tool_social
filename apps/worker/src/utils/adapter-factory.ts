import {
  createProxiedFetch,
  createDirectFetch,
  normalizeStoreProxyTargets,
  ProxyRuntimeService,
  ProxyConfigurationError,
  type PreparedProxyContext,
} from '@socialhub/config';
import { decryptToken, ProxyPolicyService, RedisProxyPolicyCache } from '@socialhub/security';
import type { PrismaClient } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import {
  AdapterRegistry,
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
  type PinterestApiEnvironment,
} from '@socialhub/platform-adapters';
import type { Platform, StoreProxyTarget } from '@socialhub/shared';
import type { WorkspaceAdapterContext, WorkspaceRouteOptions } from '@socialhub/social-runtime';

export interface WorkerEnv {
  NODE_ENV: string;
  PROXY_FINGERPRINT_SECRET: string;
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  FACEBOOK_API_VERSION?: string;
  FACEBOOK_LOGIN_CONFIG_ID?: string;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  PINTEREST_APP_ID?: string;
  PINTEREST_APP_SECRET?: string;
  PINTEREST_DEFAULT_BOARD_NAME?: string;
  PINTEREST_API_ENVIRONMENT?: string;
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
}

export class WorkerAdapterFactory {
  private readonly proxyRuntime: ProxyRuntimeService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keyring: Keyring,
    private readonly env: WorkerEnv,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisClient: any,
  ) {
    const policyCache = new RedisProxyPolicyCache(redisClient);
    const policyService = new ProxyPolicyService(policyCache, this.env.PROXY_FINGERPRINT_SECRET);
    this.proxyRuntime = new ProxyRuntimeService(policyService, this.env.PROXY_FINGERPRINT_SECRET);
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

  private async prepareTargetFetch(
    workspaceId: string,
    storeId: string,
    target: StoreProxyTarget,
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

  private createInternal(
    fetchImpl: typeof fetch,
    platformFetch?: Partial<Record<Platform, typeof fetch>>,
  ): AdapterRegistry {
    return createRuntimeAdapterRegistry({
      nodeEnv: this.env.NODE_ENV,
      fetch: fetchImpl,
      facebook: {
        appId: this.env.FACEBOOK_APP_ID,
        appSecret: this.env.FACEBOOK_APP_SECRET,
        apiVersion: this.env.FACEBOOK_API_VERSION,
        loginConfigId: this.env.FACEBOOK_LOGIN_CONFIG_ID,
        fetch: platformFetch?.FACEBOOK,
      },
      instagram: {
        appId: this.env.INSTAGRAM_APP_ID,
        appSecret: this.env.INSTAGRAM_APP_SECRET,
        apiVersion: this.env.FACEBOOK_API_VERSION,
        fetch: platformFetch?.INSTAGRAM,
      },
      pinterest: {
        appId: this.env.PINTEREST_APP_ID,
        appSecret: this.env.PINTEREST_APP_SECRET,
        defaultBoardName: this.env.PINTEREST_DEFAULT_BOARD_NAME,
        environment: this.env.PINTEREST_API_ENVIRONMENT as PinterestApiEnvironment | undefined,
        fetch: platformFetch?.PINTEREST,
      },
      youtube: {
        clientId: this.env.YOUTUBE_CLIENT_ID,
        clientSecret: this.env.YOUTUBE_CLIENT_SECRET,
        fetch: platformFetch?.YOUTUBE,
      },
      tiktok: {
        clientKey: this.env.TIKTOK_CLIENT_KEY,
        clientSecret: this.env.TIKTOK_CLIENT_SECRET,
        scopes: [...TIKTOK_OAUTH_SCOPES],
        fetch: platformFetch?.TIKTOK,
      },
    });
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

  async close(): Promise<void> {
    await this.proxyRuntime.closeAll();
  }
}
