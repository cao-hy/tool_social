import {
  createProxiedFetch,
  ProxyRuntimeService,
  type WorkerEnv,
  type WorkspaceAdapterContext,
} from '@socialhub/config';
import { decryptToken, ProxyPolicyService, RedisProxyPolicyCache } from '@socialhub/security';
import type { PrismaClient } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { createRuntimeAdapterRegistry, TIKTOK_OAUTH_SCOPES } from '@socialhub/platform-adapters';
import { createDirectFetch } from '@socialhub/config';

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

    const fetchImpl = ctx.dispatcherHandle
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        createProxiedFetch(
          { ...ctx.config, enabled: true, proxyUrl: ctx.config.proxyUrl! },
          ctx.dispatcherHandle,
        )
      : createDirectFetch(); // Default global fetch or direct fetch if proxy is off

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
        environment: this.env.PINTEREST_API_ENVIRONMENT,
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

    return {
      adapters,
      proxy: {
        enabled: ctx.config.enabled,
        configVersion: ctx.configVersion,
        fingerprint: ctx.fingerprint,
        attestation: ctx.attestation,
      },
    };
  }
}
