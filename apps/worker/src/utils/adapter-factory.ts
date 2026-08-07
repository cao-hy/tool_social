import {
  createProxiedFetch,
  createDirectFetch,
  ProxyRuntimeService,
  ProxyConfigurationError,
} from '@socialhub/config';
import { decryptToken, ProxyPolicyService, RedisProxyPolicyCache } from '@socialhub/security';
import type { PrismaClient } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import {
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
  type PinterestApiEnvironment,
} from '@socialhub/platform-adapters';
import type { WorkspaceAdapterContext } from '@socialhub/config';

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

  async forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> {
    const ctx = await this.proxyRuntime.prepareWorkspace(
      workspaceId,
      (id) => this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId: id } }),
      (ciphertext) => decryptToken(ciphertext, this.keyring),
    );

    let fetchImpl: typeof fetch;
    if (!ctx.config.enabled) {
      fetchImpl = createDirectFetch();
    } else {
      if (!ctx.dispatcherHandle) {
        throw new ProxyConfigurationError('Validated proxy dispatcher is missing.');
      }
      fetchImpl = createProxiedFetch(
        { ...ctx.config, enabled: true, proxyUrl: ctx.config.proxyUrl as string },
        ctx.dispatcherHandle,
      );
    }

    const adapters = createRuntimeAdapterRegistry({
      nodeEnv: this.env.NODE_ENV,
      fetch: fetchImpl,
      facebook: {
        appId: this.env.FACEBOOK_APP_ID,
        appSecret: this.env.FACEBOOK_APP_SECRET,
        apiVersion: this.env.FACEBOOK_API_VERSION,
        loginConfigId: this.env.FACEBOOK_LOGIN_CONFIG_ID,
      },
      instagram: {
        appId: this.env.INSTAGRAM_APP_ID,
        appSecret: this.env.INSTAGRAM_APP_SECRET,
        apiVersion: this.env.FACEBOOK_API_VERSION,
      },
      pinterest: {
        appId: this.env.PINTEREST_APP_ID,
        appSecret: this.env.PINTEREST_APP_SECRET,
        defaultBoardName: this.env.PINTEREST_DEFAULT_BOARD_NAME,
        environment: this.env.PINTEREST_API_ENVIRONMENT as PinterestApiEnvironment | undefined,
      },
      youtube: {
        clientId: this.env.YOUTUBE_CLIENT_ID,
        clientSecret: this.env.YOUTUBE_CLIENT_SECRET,
      },
      tiktok: {
        clientKey: this.env.TIKTOK_CLIENT_KEY,
        clientSecret: this.env.TIKTOK_CLIENT_SECRET,
        scopes: [...TIKTOK_OAUTH_SCOPES],
      },
    });

    let released = false;

    return {
      adapters,
      proxy: ctx,
      release: async () => {
        if (!released) {
          released = true;
          ctx.dispatcherHandle?.release();
        }
      },
    };
  }

  async close(): Promise<void> {
    await this.proxyRuntime.closeAll();
  }
}
