import { Inject, Injectable } from '@nestjs/common';
import { createProxiedFetch, ProxyRuntimeService } from '@socialhub/config';
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
} from '@socialhub/security';

import { ENV, type ApiEnv } from './env.provider';
import { PrismaService } from './prisma/prisma.service';
import { KEYRING } from './tokens';
import { RedisService } from './redis/redis.service';
import type { WorkspaceAdapterContext } from '@socialhub/config';

@Injectable()
export class AdapterRegistryFactory {
  private readonly proxyRuntime: ProxyRuntimeService;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policyCache = new RedisProxyPolicyCache(this.redisService.getClient() as any);
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
      : fetch;

    return {
      adapters: this.createInternal(fetchImpl),
      proxy: {
        enabled: ctx.config.enabled,
        configVersion: ctx.configVersion,
        fingerprint: ctx.fingerprint,
        attestation: ctx.attestation,
      },
    };
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
