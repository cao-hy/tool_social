import { PLATFORMS } from '@socialhub/shared';
import { AdapterRegistry } from './core/registry';
import { DevelopmentFixtureAdapter } from './dev/development-fixture.adapter';
import { FacebookPagesAdapter, type FacebookPagesAdapterConfig } from './facebook/facebook.adapter';
import { InstagramAdapter, type InstagramAdapterConfig } from './instagram/instagram.adapter';
import { PinterestAdapter, type PinterestAdapterConfig } from './pinterest/pinterest.adapter';
import { YouTubeAdapter, type YouTubeAdapterConfig } from './youtube/youtube.adapter';
import { TikTokAdapter, type TikTokAdapterConfig } from './tiktok/tiktok.adapter';
import type { AdapterFetch } from './core/types';

export interface AdapterRegistryRuntimeConfig {
  nodeEnv: string;
  fetch?: AdapterFetch;
  facebook?: Partial<FacebookPagesAdapterConfig>;
  instagram?: Partial<InstagramAdapterConfig>;
  pinterest?: Partial<PinterestAdapterConfig>;
  youtube?: Partial<YouTubeAdapterConfig>;
  tiktok?: Partial<TikTokAdapterConfig>;
}

export function createRuntimeAdapterRegistry(
  config: AdapterRegistryRuntimeConfig,
): AdapterRegistry {
  const registry = new AdapterRegistry();
  const facebookConfig = completeFacebookConfig(config.facebook, config.fetch);
  const instagramConfig = completeInstagramConfig(config.instagram, config.fetch);
  const pinterestConfig = completePinterestConfig(config.nodeEnv, config.pinterest, config.fetch);
  const youtubeConfig = completeYouTubeConfig(config.youtube, config.fetch);
  const tiktokConfig = completeTikTokConfig(config.tiktok, config.fetch);

  if (facebookConfig) {
    registry.register(new FacebookPagesAdapter(facebookConfig));
  }

  if (instagramConfig) {
    registry.register(new InstagramAdapter(instagramConfig));
  }

  if (pinterestConfig) {
    registry.register(new PinterestAdapter(pinterestConfig));
  }

  if (youtubeConfig) {
    registry.register(new YouTubeAdapter(youtubeConfig));
  }

  if (tiktokConfig) {
    registry.register(new TikTokAdapter(tiktokConfig));
  }

  if (config.nodeEnv !== 'production') {
    for (const platform of PLATFORMS) {
      if (!registry.has(platform)) registry.register(new DevelopmentFixtureAdapter(platform));
    }
  }

  return registry;
}

function completeTikTokConfig(
  config: Partial<TikTokAdapterConfig> | undefined,
  fetch: AdapterFetch | undefined,
): TikTokAdapterConfig | null {
  const values = [config?.clientKey, config?.clientSecret];
  const hasAny = values.some((value) => Boolean(value));
  const hasAll = values.every((value) => Boolean(value));

  if (!hasAny) return null;
  if (!hasAll) {
    throw new Error(
      'TIKTOK_CLIENT_KEY và TIKTOK_CLIENT_SECRET phải được cấu hình cùng nhau để bật TikTok adapter thật.',
    );
  }

  return {
    clientKey: config?.clientKey ?? '',
    clientSecret: config?.clientSecret ?? '',
    fetch,
    scopes: config?.scopes,
  };
}

function completeYouTubeConfig(
  config: Partial<YouTubeAdapterConfig> | undefined,
  fetch: AdapterFetch | undefined,
): YouTubeAdapterConfig | null {
  const values = [config?.clientId, config?.clientSecret];
  const hasAny = values.some((value) => Boolean(value));
  const hasAll = values.every((value) => Boolean(value));

  if (!hasAny) return null;
  if (!hasAll) {
    throw new Error(
      'YOUTUBE_CLIENT_ID và YOUTUBE_CLIENT_SECRET phải được cấu hình cùng nhau để bật YouTube adapter thật.',
    );
  }

  return {
    clientId: config?.clientId ?? '',
    clientSecret: config?.clientSecret ?? '',
    fetch,
    scopes: config?.scopes,
  };
}

function completeFacebookConfig(
  config: Partial<FacebookPagesAdapterConfig> | undefined,
  fetch: AdapterFetch | undefined,
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
    fetch,
    scopes: config?.scopes,
  };
}

function completeInstagramConfig(
  config: Partial<InstagramAdapterConfig> | undefined,
  fetch: AdapterFetch | undefined,
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
    fetch,
    scopes: config?.scopes,
  };
}

function completePinterestConfig(
  nodeEnv: string,
  config: Partial<PinterestAdapterConfig> | undefined,
  fetch: AdapterFetch | undefined,
): PinterestAdapterConfig | null {
  const values = [config?.appId, config?.appSecret];
  const hasAny = values.some((value) => Boolean(value));
  const hasAll = values.every((value) => Boolean(value));

  if (!hasAny) return null;
  if (!hasAll) {
    throw new Error(
      'PINTEREST_APP_ID và PINTEREST_APP_SECRET phải được cấu hình cùng nhau để bật Pinterest adapter thật.',
    );
  }

  return {
    appId: config?.appId ?? '',
    appSecret: config?.appSecret ?? '',
    defaultBoardName: config?.defaultBoardName,
    environment: config?.environment ?? (nodeEnv === 'production' ? 'production' : 'sandbox'),
    fetch,
    scopes: config?.scopes,
  };
}

function normalizeApiVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
