import { PLATFORMS } from '@socialhub/shared';
import { AdapterRegistry } from './core/registry';
import { DevelopmentFixtureAdapter } from './dev/development-fixture.adapter';
import { FacebookPagesAdapter, type FacebookPagesAdapterConfig } from './facebook/facebook.adapter';
import { InstagramAdapter, type InstagramAdapterConfig } from './instagram/instagram.adapter';

export interface AdapterRegistryRuntimeConfig {
  nodeEnv: string;
  facebook?: Partial<FacebookPagesAdapterConfig>;
  instagram?: Partial<InstagramAdapterConfig>;
}

export function createRuntimeAdapterRegistry(
  config: AdapterRegistryRuntimeConfig,
): AdapterRegistry {
  const registry = new AdapterRegistry();
  const facebookConfig = completeFacebookConfig(config.facebook);
  const instagramConfig = completeInstagramConfig(config.instagram);

  if (facebookConfig) {
    registry.register(new FacebookPagesAdapter(facebookConfig));
  }

  if (instagramConfig) {
    registry.register(new InstagramAdapter(instagramConfig));
  }

  if (config.nodeEnv !== 'production') {
    for (const platform of PLATFORMS) {
      if (!registry.has(platform)) registry.register(new DevelopmentFixtureAdapter(platform));
    }
  }

  return registry;
}

function completeFacebookConfig(
  config: Partial<FacebookPagesAdapterConfig> | undefined,
): FacebookPagesAdapterConfig | null {
  const values = [config?.appId, config?.appSecret, config?.apiVersion];
  const hasAny = values.some((value) => Boolean(value));
  const hasAll = values.every((value) => Boolean(value));

  if (!hasAny) return null;
  if (!hasAll) {
    throw new Error(
      'FACEBOOK_APP_ID, FACEBOOK_APP_SECRET và FACEBOOK_API_VERSION phải được cấu hình cùng nhau để bật Facebook adapter thật.',
    );
  }

  return {
    appId: config?.appId ?? '',
    appSecret: config?.appSecret ?? '',
    apiVersion: normalizeApiVersion(config?.apiVersion ?? ''),
    loginConfigId: config?.loginConfigId,
    scopes: config?.scopes,
  };
}

function completeInstagramConfig(
  config: Partial<InstagramAdapterConfig> | undefined,
): InstagramAdapterConfig | null {
  const values = [config?.appId, config?.appSecret, config?.apiVersion];
  const hasAny = values.some((value) => Boolean(value));
  const hasAll = values.every((value) => Boolean(value));

  if (!hasAny) return null;
  if (!hasAll) {
    throw new Error(
      'INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET và FACEBOOK_API_VERSION phải được cấu hình cùng nhau để bật Instagram adapter thật.',
    );
  }

  return {
    appId: config?.appId ?? '',
    appSecret: config?.appSecret ?? '',
    apiVersion: normalizeApiVersion(config?.apiVersion ?? ''),
    scopes: config?.scopes,
  };
}

function normalizeApiVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
