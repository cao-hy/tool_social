import { resolveWorkspaceProxyConfig, createProxyAwareFetch } from '@socialhub/config';
import { decryptToken } from '@socialhub/security';
import type { PrismaClient } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import type { AdapterRegistry } from '@socialhub/platform-adapters';

import { type WorkerEnv } from '@socialhub/config';
import { createRuntimeAdapterRegistry, TIKTOK_OAUTH_SCOPES } from '@socialhub/platform-adapters';
export class WorkerAdapterFactory {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly keyring: Keyring,
    private readonly env: WorkerEnv,
  ) {
    // Redis client kept for interface compatibility if needed, else we can remove it later
  }

  async forWorkspace(workspaceId: string): Promise<AdapterRegistry> {
    const setting = await this.prisma.workspaceProxySetting.findUnique({
      where: { workspaceId },
    });

    const proxyConfig = resolveWorkspaceProxyConfig(setting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );

    return createRuntimeAdapterRegistry({
      nodeEnv: this.env.NODE_ENV,
      fetch: createProxyAwareFetch(proxyConfig),
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
  }
}
