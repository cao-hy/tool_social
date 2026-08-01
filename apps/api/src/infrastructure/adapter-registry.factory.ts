import { Inject, Injectable } from '@nestjs/common';
import {
  createProxyAwareFetch,
  getConfiguredProxyUrl,
  maskProxyUrl,
  normalizeProxyConfig,
  proxyConfigFromWorkspaceSetting,
  readProxyConfig,
} from '@socialhub/config';
import {
  AdapterRegistry,
  createRuntimeAdapterRegistry,
  TIKTOK_OAUTH_SCOPES,
} from '@socialhub/platform-adapters';
import { decryptToken, type Keyring } from '@socialhub/security';
import { type ProxyConfig } from '@socialhub/shared';
import { ENV, type ApiEnv } from './env.provider';
import { PrismaService } from './prisma/prisma.service';
import { KEYRING } from './tokens';

@Injectable()
export class AdapterRegistryFactory {
  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
  ) {}

  async forWorkspace(workspaceId: string): Promise<AdapterRegistry> {
    return this.create(await this.workspaceProxyConfig(workspaceId));
  }

  create(proxyConfig?: ProxyConfig): AdapterRegistry {
    const env = this.env;
    return createRuntimeAdapterRegistry({
      nodeEnv: env.NODE_ENV,
      fetch: createProxyAwareFetch(proxyConfig),
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

  private async workspaceProxyConfig(workspaceId: string): Promise<ProxyConfig> {
    const setting = await this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId } });
    if (!setting) return this.envFallback(false);

    const config = proxyConfigFromWorkspaceSetting(setting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );
    if (config.proxyUrl) return config;
    const fallback = this.envFallback(config.enabled);
    return normalizeProxyConfig({
      ...config,
      proxyUrl: fallback.proxyUrl,
      proxyUrlMasked: fallback.proxyUrlMasked,
      source: fallback.source,
    });
  }

  private envFallback(enabled: boolean): ProxyConfig {
    const envProxyUrl = getConfiguredProxyUrl();
    return normalizeProxyConfig({
      ...readProxyConfig(),
      enabled,
      proxyUrl: envProxyUrl,
      proxyUrlMasked: maskProxyUrl(envProxyUrl),
      source: envProxyUrl ? 'ENV' : 'DIRECT',
    });
  }
}
