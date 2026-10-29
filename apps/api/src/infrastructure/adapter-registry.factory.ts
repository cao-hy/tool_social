import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  createProxiedFetch,
  createDirectFetch,
  ProxyRuntimeService,
  ProxyConfigurationError,
} from '@socialhub/config';
import {
  AdapterRegistry,
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
} from '@socialhub/platform-adapters';
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
import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';

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

  async forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> {
    const ctx = await this.proxyRuntime.prepareWorkspace(
      workspaceId,
      (id) => this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId: id } }),
      (ciphertext) => decryptToken(ciphertext, this.keyring),
      {
        getWorkspaceConfigVersion: async (id) =>
          (
            await this.prisma.workspaceProxySetting.findUnique({
              where: { workspaceId: id },
              select: { configVersion: true },
            })
          )?.configVersion ?? null,
        getWorkspaceEgressPolicy: async (id) =>
          (
            await this.prisma.workspace.findUnique({
              where: { id },
              select: { socialEgressPolicy: true },
            })
          )?.socialEgressPolicy ?? null,
      },
    );

    let baseFetch: typeof fetch;
    if (!ctx.config.enabled) {
      baseFetch = createDirectFetch();
    } else {
      if (!ctx.dispatcherHandle) {
        throw new ProxyConfigurationError('Validated proxy dispatcher is missing.');
      }
      baseFetch = createProxiedFetch(
        { ...ctx.config, enabled: true, proxyUrl: ctx.config.proxyUrl as string },
        ctx.dispatcherHandle,
      );
    }

    const fetchImpl: typeof fetch = (input, init) => baseFetch(input, init);

    let released = false;

    return {
      adapters: this.createInternal(fetchImpl),
      proxy: ctx,
      release: async () => {
        if (!released) {
          released = true;
          ctx.dispatcherHandle?.release();
        }
      },
    };
  }

  async withWorkspace<T>(
    workspaceId: string,
    fn: (ctx: WorkspaceAdapterContext) => Promise<T>,
  ): Promise<T> {
    const ctx = await this.forWorkspace(workspaceId);
    try {
      return await fn(ctx);
    } finally {
      await ctx.release();
    }
  }

  private createInternal(fetchImpl: typeof fetch): AdapterRegistry {
    const env = this.env;
    return createRuntimeAdapterRegistry({
      nodeEnv: env.NODE_ENV,
      fetch: fetchImpl,
      facebook: {
        appId: env.FACEBOOK_APP_ID,
        appSecret: env.FACEBOOK_APP_SECRET,
        apiVersion: env.FACEBOOK_API_VERSION,
        loginConfigId: env.FACEBOOK_LOGIN_CONFIG_ID,
      },
      instagram: {
        appId: env.INSTAGRAM_APP_ID,
        appSecret: env.INSTAGRAM_APP_SECRET,
        apiVersion: env.FACEBOOK_API_VERSION,
      },
      pinterest: {
        appId: env.PINTEREST_APP_ID,
        appSecret: env.PINTEREST_APP_SECRET,
        defaultBoardName: env.PINTEREST_DEFAULT_BOARD_NAME,
        environment: env.PINTEREST_API_ENVIRONMENT,
      },
      youtube: {
        clientId: env.YOUTUBE_CLIENT_ID,
        clientSecret: env.YOUTUBE_CLIENT_SECRET,
      },
      tiktok: {
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        scopes: [...TIKTOK_OAUTH_SCOPES],
      },
    });
  }
}
