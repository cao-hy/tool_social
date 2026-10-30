import { z } from 'zod';

export const STORE_PROXY_TARGETS = [
  'FACEBOOK',
  'INSTAGRAM',
  'YOUTUBE',
  'PINTEREST',
  'TIKTOK',
  'SHOPIFY',
] as const;

export type StoreProxyTarget = (typeof STORE_PROXY_TARGETS)[number];

export const storeProxyTargetSchema = z.enum(STORE_PROXY_TARGETS);

export const STORE_PROXY_TARGET_LABELS: Record<StoreProxyTarget, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  YOUTUBE: 'YouTube',
  PINTEREST: 'Pinterest',
  TIKTOK: 'TikTok',
  SHOPIFY: 'Shopify API',
};

export interface ProxyConfig {
  enabled: boolean;
  countryLock: string | null;
  proxyUrl?: string | null;
  proxyUrlMasked?: string | null;
  source?: 'STORE' | 'WORKSPACE' | 'ENV' | 'DIRECT';
  targets?: StoreProxyTarget[];
  version?: number;
}

export type SocialEgressPolicy = 'DIRECT_ALLOWED' | 'PROXY_REQUIRED';
