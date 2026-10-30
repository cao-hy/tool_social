import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import {
  maskProxyUrl,
  normalizeStoreProxyTargets,
  type StoreProxySettingRecord,
} from '@socialhub/config';
import type { Prisma } from '@socialhub/db';
import {
  decryptToken,
  encryptToken,
  ProxyEndpointBlockedError,
  ProxyEndpointValidator,
  scrubSecretsFromText,
  type Keyring,
} from '@socialhub/security';
import type { StoreProxyTarget } from '@socialhub/shared';
import { AppError } from '../../common/errors/app-error';
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { KEYRING } from '../../infrastructure/infrastructure.module';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { Optional } from '@nestjs/common';

const SHOPIFY_ADMIN_API_VERSION = '2026-01';
const SHOPIFY_TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;
const SHORT_CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
const DEFAULT_SHORT_CODE_LENGTH = 6;
const MAX_REDIRECT_COLLISION_RETRIES = 5;
const BATCH_SHORTEN_CONCURRENCY = 4;

const RESERVED_SHOPIFY_PREFIXES = new Set([
  '/admin/',
  '/products/',
  '/collections/',
  '/pages/',
  '/blogs/',
  '/cart/',
  '/checkout/',
  '/orders/',
  '/account/',
  '/apps/',
  '/cdn/',
  '/search/',
]);

const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'ttclid',
  'msclkid',
  'twclid',
  'dclid',
  'wbraid',
  'gbraid',
  'epik',
  'sccid',
  'igshid',
  'si',
  '_pos',
  '_sid',
  '_ss',
  '_v',
  '_ga',
  '_gl',
  'mc_cid',
  'mc_eid',
  'pr_prod_strat',
  'pr_rec_id',
  'pr_rec_pid',
  'pr_ref_pid',
  'pr_seq',
  'shpxid',
  'oseid',
]);

export interface StoreProxySummary {
  enabled: boolean;
  hasProxyUrl: boolean;
  proxyUrlMasked: string | null;
  countryLock: string | null;
  targets: StoreProxyTarget[];
  configVersion: number;
  lastCheckedAt: Date | null;
  lastCheckStatus: string | null;
  lastIp: string | null;
  lastCountryCode: string | null;
  lastCheckError: string | null;
}

export interface StoreShopifySummary {
  connected: boolean;
  enabled: boolean;
  shopDomain: string | null;
  publicDomain: string | null;
  shortPathPrefix: string;
  clientId: string | null;
  clientSecretMasked: string | null;
  grantedScopes: string | null;
  tokenExpiresAt: Date | null;
  shopName: string | null;
  lastCheckedAt: Date | null;
  lastCheckStatus: string | null;
  lastCheckError: string | null;
}

export interface ShortenedLinkItem {
  inputUrl: string;
  targetUrl: string;
  shortUrl: string | null;
  shortPath: string | null;
  reused: boolean;
  alreadyShort?: boolean;
  error?: string;
}

export function formatStoreProxySummary(
  setting?: {
    enabled: boolean;
    proxyUrl: string | null;
    proxyUrlMasked: string | null;
    countryLock: string | null;
    targets: string[];
    configVersion: number;
    lastCheckedAt: Date | null;
    lastCheckStatus: string | null;
    lastIp: string | null;
    lastCountryCode: string | null;
    lastCheckError: string | null;
  } | null,
): StoreProxySummary {
  if (!setting) {
    return {
      enabled: false,
      hasProxyUrl: false,
      proxyUrlMasked: null,
      countryLock: null,
      targets: [],
      configVersion: 0,
      lastCheckedAt: null,
      lastCheckStatus: null,
      lastIp: null,
      lastCountryCode: null,
      lastCheckError: null,
    };
  }

  return {
    enabled: setting.enabled,
    hasProxyUrl: Boolean(setting.proxyUrl),
    proxyUrlMasked: setting.proxyUrlMasked,
    countryLock: setting.countryLock,
    targets: normalizeStoreProxyTargets(setting.targets),
    configVersion: setting.configVersion,
    lastCheckedAt: setting.lastCheckedAt,
    lastCheckStatus: setting.lastCheckStatus,
    lastIp: setting.lastIp,
    lastCountryCode: setting.lastCountryCode,
    lastCheckError: setting.lastCheckError,
  };
}

export function formatStoreShopifySummary(
  setting?: {
    enabled: boolean;
    shopDomain: string;
    publicDomain: string;
    shortPathPrefix: string;
    clientId: string;
    clientSecretMasked: string;
    grantedScopes: string | null;
    tokenExpiresAt: Date | null;
    shopName: string | null;
    lastCheckedAt: Date | null;
    lastCheckStatus: string | null;
    lastCheckError: string | null;
  } | null,
): StoreShopifySummary {
  if (!setting) {
    return {
      connected: false,
      enabled: false,
      shopDomain: null,
      publicDomain: null,
      shortPathPrefix: '/s/',
      clientId: null,
      clientSecretMasked: null,
      grantedScopes: null,
      tokenExpiresAt: null,
      shopName: null,
      lastCheckedAt: null,
      lastCheckStatus: null,
      lastCheckError: null,
    };
  }

  return {
    connected: true,
    enabled: setting.enabled,
    shopDomain: setting.shopDomain,
    publicDomain: setting.publicDomain,
    shortPathPrefix: setting.shortPathPrefix,
    clientId: setting.clientId,
    clientSecretMasked: setting.clientSecretMasked,
    grantedScopes: setting.grantedScopes,
    tokenExpiresAt: setting.tokenExpiresAt,
    shopName: setting.shopName,
    lastCheckedAt: setting.lastCheckedAt,
    lastCheckStatus: setting.lastCheckStatus,
    lastCheckError: setting.lastCheckError,
  };
}

export function normalizeUserProxyUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  // Format phổ biến từ các nhà cung cấp proxy: host:port:username:password
  const hostPortUserPass = /^([^:@/\s]+):(\d{2,5}):([^:@/\s]+):([^/\s]+)$/.exec(trimmed);
  if (hostPortUserPass) {
    const [, host = '', port = '', user = '', pass = ''] = hostPortUserPass;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Format user:pass@host:port
  const userPassAtHostPort = /^([^:@/\s]+):([^@/\s]+)@([^:/\s]+):(\d{2,5})$/.exec(trimmed);
  if (userPassAtHostPort) {
    return `http://${trimmed}`;
  }

  // Format host:port
  const hostPort = /^([^:/\s]+):(\d{2,5})$/.exec(trimmed);
  if (hostPort) {
    return `http://${trimmed}`;
  }

  return trimmed;
}

export function normalizeShopAdminDomain(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw AppError.validation('Vui lòng nhập Shop Admin Domain (ví dụ: preaureum.myshopify.com).');
  }

  // Hỗ trợ dán nguyên link https://admin.shopify.com/store/<handle>/...
  const adminUrlMatch =
    /(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-zA-Z0-9-]+)(?:\/|$|\?)/i.exec(trimmed);
  if (adminUrlMatch?.[1]) {
    return `${adminUrlMatch[1].toLowerCase()}.myshopify.com`;
  }

  // Hỗ trợ nhập mã handle ngắn gọn (ví dụ: "preaureum")
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(trimmed) && !trimmed.includes('.')) {
    return `${trimmed.toLowerCase()}.myshopify.com`;
  }

  let hostname = trimmed;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    hostname = new URL(withProtocol).hostname.toLowerCase();
  } catch {
    throw AppError.validation('Shop Admin Domain không đúng định dạng.');
  }

  if (hostname.endsWith('.myshopify.com') && hostname.split('.').length === 3) {
    const handle = hostname.replace(/\.myshopify\.com$/, '');
    if (/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
      return `${handle}.myshopify.com`;
    }
  }

  throw AppError.validation(
    `Shop Admin Domain phải có dạng *.myshopify.com hoặc link admin.shopify.com/store/... (nhận được "${hostname}"). Tên miền khách truy cập như "${hostname}" hãy nhập ở ô Public Domain để tránh lỗi redirect mất Access Token.`,
  );
}

export function normalizePublicDomain(raw?: string | null): string | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || !host.includes('.')) {
      throw new Error('Invalid host');
    }
    return host;
  } catch {
    throw AppError.validation('Public Domain không hợp lệ (ví dụ hợp lệ: preaureum.com).');
  }
}

export function normalizeShortPathPrefix(raw?: string | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return '/s/';

  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
  if (!/^\/[a-zA-Z0-9_-]{1,24}\/$/.test(normalized)) {
    throw AppError.validation(
      'Tiền tố link rút gọn chỉ được chứa chữ cái, số, dấu gạch ngang (ví dụ: /s/ hoặc /go/).',
    );
  }
  if (RESERVED_SHOPIFY_PREFIXES.has(normalized.toLowerCase())) {
    throw AppError.validation(
      `Không được dùng tiền tố "${normalized}" vì trùng đường dẫn hệ thống của Shopify.`,
    );
  }
  return normalized;
}

export function cleanShopifyTargetUrl(rawUrl: string, cleanTracking = true): string {
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw AppError.validation(`URL không hợp lệ: ${rawUrl}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw AppError.validation(`Chỉ hỗ trợ URL http/https: ${rawUrl}`);
  }

  if (cleanTracking) {
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_value, key) => {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(lower)) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }
  }

  if (parsed.hash === '#') {
    parsed.hash = '';
  }

  return parsed.toString();
}

function maskShopifySecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 12) return 'shpss_***';
  return `${trimmed.slice(0, 9)}...${trimmed.slice(-4)}`;
}

class ShopifyUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyUnauthorizedError';
  }
}

function generateShortCode(length = DEFAULT_SHORT_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length] ?? 'a';
  }
  return out;
}

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

@Injectable()
export class StoreIntegrationsService {
  private readonly proxyValidator = new ProxyEndpointValidator(dns);
  private readonly inflightTokenRefresh = new Map<string, Promise<string>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(EventsService) private readonly events?: EventsService,
  ) {}

  async updateStoreProxy(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    input: {
      enabled?: boolean;
      proxyUrl?: string | null;
      clearProxyUrl?: boolean;
      countryLock?: string | null;
      targets?: string[];
    },
    auditContext: AuditContext,
  ): Promise<StoreProxySummary> {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
      include: { proxySetting: true },
    });
    if (!store) throw AppError.notFound('store');

    const existing = store.proxySetting;
    let encryptedProxyUrl = existing?.proxyUrl ?? null;
    let proxyUrlMasked = existing?.proxyUrlMasked ?? null;
    let urlChanged = false;

    if (input.clearProxyUrl || input.proxyUrl === '') {
      encryptedProxyUrl = null;
      proxyUrlMasked = null;
      urlChanged = Boolean(existing?.proxyUrl);
    } else if (typeof input.proxyUrl === 'string' && input.proxyUrl.trim()) {
      const normalizedCandidate = normalizeUserProxyUrlInput(input.proxyUrl);
      let validatedUrl: string;
      try {
        const validated = await this.proxyValidator.validate(normalizedCandidate);
        validatedUrl = validated.normalizedUrl;
      } catch (error) {
        if (error instanceof ProxyEndpointBlockedError) {
          throw AppError.validation(`Proxy URL không hợp lệ: ${error.message}`);
        }
        throw error;
      }

      const encrypted = encryptToken(validatedUrl, this.keyring);
      encryptedProxyUrl = encrypted.ciphertext;
      proxyUrlMasked = maskProxyUrl(validatedUrl);
      urlChanged = true;
    }

    const nextCountryLock =
      input.countryLock === undefined
        ? (existing?.countryLock ?? null)
        : input.countryLock?.trim()
          ? input.countryLock.trim().toUpperCase()
          : null;

    if (nextCountryLock && !/^[A-Z]{2}$/.test(nextCountryLock)) {
      throw AppError.validation(
        'Country Lock phải là mã quốc gia ISO 2 ký tự (ví dụ: US, GB, DE, VN) hoặc để trống.',
      );
    }

    const nextTargets =
      input.targets !== undefined
        ? normalizeStoreProxyTargets(input.targets)
        : normalizeStoreProxyTargets(existing?.targets ?? []);

    const nextEnabled = input.enabled !== undefined ? input.enabled : (existing?.enabled ?? false);
    if (nextEnabled && !encryptedProxyUrl) {
      throw AppError.validation('Vui lòng nhập Proxy URL trước khi bật Proxy cho Store này.');
    }

    const countryChanged = nextCountryLock !== (existing?.countryLock ?? null);
    const nextVersion = (existing?.configVersion ?? 0) + 1;

    const saved = await this.prisma.storeProxySetting.upsert({
      where: { storeId },
      create: {
        storeId,
        workspaceId,
        enabled: nextEnabled,
        proxyUrl: encryptedProxyUrl,
        proxyUrlMasked,
        countryLock: nextCountryLock,
        targets: nextTargets,
        configVersion: nextVersion,
      },
      update: {
        enabled: nextEnabled,
        proxyUrl: encryptedProxyUrl,
        proxyUrlMasked,
        countryLock: nextCountryLock,
        targets: nextTargets,
        configVersion: nextVersion,
        ...(urlChanged || countryChanged
          ? {
              lastCheckStatus: null,
              lastCheckError: null,
            }
          : {}),
      },
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'StoreProxySetting',
      resourceId: saved.id,
      after: {
        storeId,
        storeName: store.name,
        enabled: saved.enabled,
        proxyUrlMasked: saved.proxyUrlMasked,
        countryLock: saved.countryLock,
        targets: saved.targets,
        configVersion: saved.configVersion,
      },
    });

    this.events?.publish(workspaceId, { type: 'accounts.changed' });
    this.events?.publish(workspaceId, { type: 'network.changed' });

    return formatStoreProxySummary(saved);
  }

  async testStoreProxy(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
      include: { proxySetting: true },
    });
    if (!store) throw AppError.notFound('store');

    const setting = store.proxySetting;
    if (!setting?.proxyUrl) {
      throw AppError.validation(
        'Store chưa có Proxy URL. Hãy lưu Proxy URL trước khi bấm Test IP.',
      );
    }

    const now = new Date();
    const syntheticSetting: StoreProxySettingRecord = {
      storeId,
      workspaceId,
      enabled: true,
      proxyUrl: setting.proxyUrl,
      proxyUrlMasked: setting.proxyUrlMasked,
      countryLock: setting.countryLock,
      targets: setting.targets,
      configVersion: setting.configVersion,
      updatedAt: setting.updatedAt,
    };

    try {
      const prepared = await this.adapterFactory.getProxyRuntime().prepareWorkspace(
        `store:${storeId}`,
        async () => syntheticSetting,
        (ciphertext) => decryptToken(ciphertext, this.keyring),
        {
          forceAttestation: true,
          getWorkspaceConfigVersion: async () => setting.configVersion,
          getWorkspaceEgressPolicy: async () => 'PROXY_REQUIRED',
        },
      );
      prepared.dispatcherHandle?.release();

      const attestation = prepared.attestation;
      const updated = await this.prisma.storeProxySetting.update({
        where: { storeId },
        data: {
          lastCheckedAt: now,
          lastCheckStatus: 'OK',
          lastIp: attestation?.ip ?? null,
          lastCountryCode: attestation?.countryCode ?? null,
          lastCheckError: null,
        },
      });

      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'WORKSPACE_SETTINGS_CHANGED',
        resourceType: 'StoreProxySetting',
        resourceId: updated.id,
        metadata: {
          action: 'test_store_proxy',
          storeId,
          checkOk: true,
          ip: attestation?.ip ?? null,
          countryCode: attestation?.countryCode ?? null,
        },
      });

      this.events?.publish(workspaceId, { type: 'accounts.changed' });

      return {
        checkOk: true,
        checkedAt: attestation?.checkedAt ?? now.toISOString(),
        ip: attestation?.ip ?? null,
        countryCode: attestation?.countryCode ?? null,
        country: attestation?.country ?? null,
        city: attestation?.city ?? null,
        isp: attestation?.isp ?? null,
        provider: attestation?.provider ?? null,
        countryLockSatisfied: true,
        checkError: null,
        proxy: formatStoreProxySummary(updated),
      };
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : 'Không thể kết nối qua Proxy này.';
      const safeError = scrubSecretsFromText(rawMsg);

      const updated = await this.prisma.storeProxySetting.update({
        where: { storeId },
        data: {
          lastCheckedAt: now,
          lastCheckStatus: 'FAILED',
          lastCheckError: safeError,
        },
      });

      this.events?.publish(workspaceId, { type: 'accounts.changed' });

      return {
        checkOk: false,
        checkedAt: now.toISOString(),
        ip: null,
        countryCode: null,
        country: null,
        city: null,
        isp: null,
        provider: null,
        countryLockSatisfied: false,
        checkError: safeError,
        proxy: formatStoreProxySummary(updated),
      };
    }
  }

  async upsertStoreShopify(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    input: {
      enabled?: boolean;
      shopDomain: string;
      publicDomain?: string | null;
      shortPathPrefix?: string | null;
      clientId?: string | null;
      clientSecret?: string | null;
    },
    auditContext: AuditContext,
  ): Promise<StoreShopifySummary> {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
      include: { shopifySetting: true },
    });
    if (!store) throw AppError.notFound('store');

    const existing = store.shopifySetting;
    const shopDomain = normalizeShopAdminDomain(input.shopDomain);
    const shortPathPrefix = normalizeShortPathPrefix(
      input.shortPathPrefix ?? existing?.shortPathPrefix ?? '/s/',
    );

    const resolvedClientId = input.clientId?.trim() || existing?.clientId?.trim() || '';
    if (!resolvedClientId) {
      throw AppError.validation(
        'Vui lòng nhập Client ID của App trên Shopify Dev Dashboard ($ shopify dev).',
      );
    }

    let plainClientSecret: string;
    let encryptedSecretCiphertext: string;
    let encryptionKeyVersion: string;
    let clientSecretMasked: string;

    if (input.clientSecret?.trim()) {
      plainClientSecret = input.clientSecret.trim();
      const encrypted = encryptToken(plainClientSecret, this.keyring);
      encryptedSecretCiphertext = encrypted.ciphertext;
      encryptionKeyVersion = encrypted.keyVersion;
      clientSecretMasked = maskShopifySecret(plainClientSecret);
    } else if (existing?.clientSecret) {
      plainClientSecret = decryptToken(existing.clientSecret, this.keyring);
      encryptedSecretCiphertext = existing.clientSecret;
      encryptionKeyVersion = existing.encryptionKeyVersion;
      clientSecretMasked = existing.clientSecretMasked || 'shpss_***';
    } else {
      throw AppError.validation(
        'Vui lòng nhập Client Secret (shpss_...) của App trên Shopify Dev Dashboard ($ shopify dev).',
      );
    }

    const targetFetch = await this.adapterFactory.prepareTargetFetch(
      workspaceId,
      storeId,
      'SHOPIFY',
    );
    let tokenResult: {
      accessToken: string;
      expiresAt: Date;
      grantedScopes: string | null;
    };
    let shopInfo: {
      shopName: string;
      myshopifyDomain: string;
      primaryDomainHost: string | null;
    };

    try {
      tokenResult = await this.exchangeShopifyClientCredentials({
        fetchImpl: targetFetch.fetch,
        shopDomain,
        clientId: resolvedClientId,
        clientSecret: plainClientSecret,
      });

      shopInfo = await this.verifyShopifyShopWithFetch({
        fetchImpl: targetFetch.fetch,
        shopDomain,
        adminAccessToken: tokenResult.accessToken,
      });
    } finally {
      await targetFetch.release();
    }

    const encryptedAccessToken = encryptToken(tokenResult.accessToken, this.keyring);

    const explicitPublicDomain = normalizePublicDomain(input.publicDomain);
    const resolvedPublicDomain =
      explicitPublicDomain ??
      normalizePublicDomain(shopInfo.primaryDomainHost) ??
      shopInfo.myshopifyDomain ??
      shopDomain;

    const now = new Date();
    const nextEnabled = input.enabled !== undefined ? input.enabled : (existing?.enabled ?? true);

    const saved = await this.prisma.storeShopifySetting.upsert({
      where: { storeId },
      create: {
        storeId,
        workspaceId,
        enabled: nextEnabled,
        shopDomain: shopInfo.myshopifyDomain || shopDomain,
        publicDomain: resolvedPublicDomain,
        shortPathPrefix,
        clientId: resolvedClientId,
        clientSecret: encryptedSecretCiphertext,
        clientSecretMasked,
        cachedAccessToken: encryptedAccessToken.ciphertext,
        tokenExpiresAt: tokenResult.expiresAt,
        grantedScopes: tokenResult.grantedScopes,
        encryptionKeyVersion,
        shopName: shopInfo.shopName,
        lastCheckedAt: now,
        lastCheckStatus: 'OK',
        lastCheckError: null,
      },
      update: {
        enabled: nextEnabled,
        shopDomain: shopInfo.myshopifyDomain || shopDomain,
        publicDomain: resolvedPublicDomain,
        shortPathPrefix,
        clientId: resolvedClientId,
        clientSecret: encryptedSecretCiphertext,
        clientSecretMasked,
        cachedAccessToken: encryptedAccessToken.ciphertext,
        tokenExpiresAt: tokenResult.expiresAt,
        grantedScopes: tokenResult.grantedScopes,
        encryptionKeyVersion,
        shopName: shopInfo.shopName,
        lastCheckedAt: now,
        lastCheckStatus: 'OK',
        lastCheckError: null,
      },
    });

    await this.audit.record({
      ...auditContext,
      actorUserId,
      workspaceId,
      action: 'WORKSPACE_SETTINGS_CHANGED',
      resourceType: 'StoreShopifySetting',
      resourceId: saved.id,
      after: {
        storeId,
        storeName: store.name,
        shopDomain: saved.shopDomain,
        publicDomain: saved.publicDomain,
        shortPathPrefix: saved.shortPathPrefix,
        clientId: saved.clientId,
        grantedScopes: saved.grantedScopes,
        shopName: saved.shopName,
      },
    });

    this.events?.publish(workspaceId, { type: 'accounts.changed' });

    return formatStoreShopifySummary(saved);
  }

  async deleteStoreShopify(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
      include: { shopifySetting: true },
    });
    if (!store) throw AppError.notFound('store');

    if (store.shopifySetting) {
      await this.prisma.storeShopifySetting.delete({
        where: { storeId },
      });

      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'WORKSPACE_SETTINGS_CHANGED',
        resourceType: 'StoreShopifySetting',
        resourceId: store.shopifySetting.id,
        before: {
          storeId,
          shopDomain: store.shopifySetting.shopDomain,
          publicDomain: store.shopifySetting.publicDomain,
        },
      });

      this.events?.publish(workspaceId, { type: 'accounts.changed' });
    }

    return {
      deleted: true,
      shopify: formatStoreShopifySummary(null),
    };
  }

  async testStoreShopify(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    auditContext: AuditContext,
  ) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
      include: { shopifySetting: true },
    });
    if (!store) throw AppError.notFound('store');
    if (!store.shopifySetting) {
      throw AppError.validation('Store chưa kết nối Shopify.');
    }

    const setting = store.shopifySetting;
    const now = new Date();
    const targetFetch = await this.adapterFactory.prepareTargetFetch(
      workspaceId,
      storeId,
      'SHOPIFY',
    );

    try {
      const freshAccessToken = await this.resolveValidShopifyAccessToken({
        storeId,
        setting,
        fetchImpl: targetFetch.fetch,
        forceRefresh: true,
      });

      const shopInfo = await this.verifyShopifyShopWithFetch({
        fetchImpl: targetFetch.fetch,
        shopDomain: setting.shopDomain,
        adminAccessToken: freshAccessToken,
      });

      const updated = await this.prisma.storeShopifySetting.update({
        where: { storeId },
        data: {
          shopName: shopInfo.shopName,
          lastCheckedAt: now,
          lastCheckStatus: 'OK',
          lastCheckError: null,
        },
      });

      await this.audit.record({
        ...auditContext,
        actorUserId,
        workspaceId,
        action: 'WORKSPACE_SETTINGS_CHANGED',
        resourceType: 'StoreShopifySetting',
        resourceId: updated.id,
        metadata: { action: 'test_store_shopify', storeId, checkOk: true },
      });

      this.events?.publish(workspaceId, { type: 'accounts.changed' });

      return {
        checkOk: true,
        shopName: shopInfo.shopName,
        myshopifyDomain: shopInfo.myshopifyDomain,
        primaryDomainHost: shopInfo.primaryDomainHost,
        checkError: null,
        shopify: formatStoreShopifySummary(updated),
      };
    } catch (error) {
      const safeError = scrubSecretsFromText(
        error instanceof Error ? error.message : 'Không thể kết nối Shopify Admin API.',
      );
      const updated = await this.prisma.storeShopifySetting.update({
        where: { storeId },
        data: {
          lastCheckedAt: now,
          lastCheckStatus: 'FAILED',
          lastCheckError: safeError,
        },
      });

      this.events?.publish(workspaceId, { type: 'accounts.changed' });

      return {
        checkOk: false,
        shopName: updated.shopName,
        myshopifyDomain: updated.shopDomain,
        primaryDomainHost: updated.publicDomain,
        checkError: safeError,
        shopify: formatStoreShopifySummary(updated),
      };
    } finally {
      await targetFetch.release();
    }
  }

  async shortenStoreUrls(
    workspaceId: string,
    storeId: string,
    actorUserId: string,
    input: {
      urls: string[];
      cleanTracking?: boolean;
      customSlug?: string;
    },
  ): Promise<{
    storeId: string;
    publicDomain: string;
    shortPathPrefix: string;
    items: ShortenedLinkItem[];
  }> {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, workspaceId },
      include: { shopifySetting: true },
    });
    if (!store) throw AppError.notFound('store');

    const setting = store.shopifySetting;
    if (!setting || !setting.enabled) {
      throw AppError.conflict(
        `Store "${store.name}" chưa kết nối hoặc đang tắt tích hợp Shopify Short Link. Hãy mở Cài đặt Store → Shopify để cấu hình trước.`,
      );
    }

    const cleanTracking = input.cleanTracking !== false;
    const customSlug = input.customSlug?.trim()
      ? input.customSlug
          .trim()
          .replace(/^\/+|\/+$/g, '')
          .replace(/[^a-zA-Z0-9_-]/g, '-')
      : undefined;

    if (customSlug && input.urls.length > 1) {
      throw AppError.validation('Custom slug chỉ áp dụng khi rút gọn 1 link đơn lẻ.');
    }

    const targetFetch = await this.adapterFactory.prepareTargetFetch(
      workspaceId,
      storeId,
      'SHOPIFY',
    );

    try {
      let currentAccessToken = await this.resolveValidShopifyAccessToken({
        storeId,
        setting,
        fetchImpl: targetFetch.fetch,
        forceRefresh: false,
      });

      const getFreshTokenOnUnauthorized = async () => {
        currentAccessToken = await this.resolveValidShopifyAccessToken({
          storeId,
          setting,
          fetchImpl: targetFetch.fetch,
          forceRefresh: true,
        });
        return currentAccessToken;
      };

      const uniqueRawUrls = [...new Set(input.urls.map((u) => u.trim()).filter(Boolean))];
      const resultsByRawUrl = new Map<string, ShortenedLinkItem>();

      for (let offset = 0; offset < uniqueRawUrls.length; offset += BATCH_SHORTEN_CONCURRENCY) {
        const chunk = uniqueRawUrls.slice(offset, offset + BATCH_SHORTEN_CONCURRENCY);
        const chunkResults = await Promise.all(
          chunk.map(async (rawUrl) => {
            try {
              const item = await this.shortenSingleUrl({
                fetchImpl: targetFetch.fetch,
                workspaceId,
                storeId,
                actorUserId,
                setting,
                adminAccessToken: currentAccessToken,
                onUnauthorizedRefresh: getFreshTokenOnUnauthorized,
                rawUrl,
                cleanTracking,
                customSlug,
              });
              return [rawUrl, item] as const;
            } catch (error) {
              const message = scrubSecretsFromText(
                error instanceof Error ? error.message : 'Không thể tạo link rút gọn.',
              );
              return [
                rawUrl,
                {
                  inputUrl: rawUrl,
                  targetUrl: rawUrl,
                  shortUrl: null,
                  shortPath: null,
                  reused: false,
                  error: message,
                } satisfies ShortenedLinkItem,
              ] as const;
            }
          }),
        );

        for (const [rawUrl, item] of chunkResults) {
          resultsByRawUrl.set(rawUrl, item);
        }
      }

      return {
        storeId,
        publicDomain: setting.publicDomain,
        shortPathPrefix: setting.shortPathPrefix,
        items: input.urls.map((raw) => {
          const key = raw.trim();
          return (
            resultsByRawUrl.get(key) ?? {
              inputUrl: raw,
              targetUrl: raw,
              shortUrl: null,
              shortPath: null,
              reused: false,
              error: 'URL trống.',
            }
          );
        }),
      };
    } finally {
      await targetFetch.release();
    }
  }

  private async shortenSingleUrl(params: {
    fetchImpl: typeof fetch;
    workspaceId: string;
    storeId: string;
    actorUserId: string;
    setting: {
      shopDomain: string;
      publicDomain: string;
      shortPathPrefix: string;
    };
    adminAccessToken: string;
    onUnauthorizedRefresh?: () => Promise<string>;
    rawUrl: string;
    cleanTracking: boolean;
    customSlug?: string;
  }): Promise<ShortenedLinkItem> {
    const { fetchImpl, workspaceId, storeId, actorUserId, setting, rawUrl } = params;
    let activeAccessToken = params.adminAccessToken;
    let refreshedOnce = false;

    const cleanedUrl = cleanShopifyTargetUrl(rawUrl, params.cleanTracking);
    const parsed = new URL(cleanedUrl);
    const parsedHostNoWww = stripWww(parsed.hostname);
    const publicHostNoWww = stripWww(setting.publicDomain);
    const shopHostNoWww = stripWww(setting.shopDomain);

    const isSameStoreDomain =
      parsedHostNoWww === publicHostNoWww || parsedHostNoWww === shopHostNoWww;

    // Bỏ qua nếu URL đã là link rút gọn /s/... của chính Store này
    if (isSameStoreDomain && parsed.pathname.startsWith(setting.shortPathPrefix)) {
      const canonicalShort = `https://${setting.publicDomain}${parsed.pathname}${parsed.search}`;
      return {
        inputUrl: rawUrl,
        targetUrl: canonicalShort,
        shortUrl: canonicalShort,
        shortPath: parsed.pathname,
        reused: true,
        alreadyShort: true,
      };
    }

    const relativePathAndQuery = `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`;
    const shopifyRedirectTarget = isSameStoreDomain ? relativePathAndQuery : cleanedUrl;
    const canonicalTargetUrl = isSameStoreDomain
      ? `https://${setting.publicDomain}${relativePathAndQuery}`
      : cleanedUrl;

    if (!params.customSlug) {
      const existing = await this.prisma.storeShortLink.findUnique({
        where: {
          storeId_targetUrl: {
            storeId,
            targetUrl: canonicalTargetUrl,
          },
        },
      });
      if (existing) {
        return {
          inputUrl: rawUrl,
          targetUrl: canonicalTargetUrl,
          shortUrl: existing.shortUrl,
          shortPath: existing.shortPath,
          reused: true,
        };
      }
    }

    const maxAttempts = params.customSlug ? 1 : MAX_REDIRECT_COLLISION_RETRIES;
    let lastError = 'Không thể tạo URL Redirect trên Shopify.';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const code = params.customSlug || generateShortCode(DEFAULT_SHORT_CODE_LENGTH);
      const shortPath = `${setting.shortPathPrefix}${code}`;

      const existingPath = await this.prisma.storeShortLink.findUnique({
        where: {
          storeId_shortPath: {
            storeId,
            shortPath,
          },
        },
      });
      if (existingPath) {
        if (existingPath.targetUrl === canonicalTargetUrl) {
          return {
            inputUrl: rawUrl,
            targetUrl: canonicalTargetUrl,
            shortUrl: existingPath.shortUrl,
            shortPath: existingPath.shortPath,
            reused: true,
          };
        }
        if (params.customSlug) {
          throw AppError.conflict(`Mã rút gọn "${shortPath}" đã được dùng cho một link khác.`);
        }
        continue;
      }

      const mutation = `
        mutation SocialHubCreateRedirect($urlRedirect: UrlRedirectInput!) {
          urlRedirectCreate(urlRedirect: $urlRedirect) {
            urlRedirect {
              id
              path
              target
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      type RedirectMutationData = {
        urlRedirectCreate?: {
          urlRedirect?: { id: string; path: string; target: string } | null;
          userErrors?: Array<{ field?: string[] | null; message: string }>;
        };
      };

      let data: RedirectMutationData;
      try {
        data = await this.executeShopifyGraphql<RedirectMutationData>({
          fetchImpl,
          shopDomain: setting.shopDomain,
          adminAccessToken: activeAccessToken,
          query: mutation,
          variables: {
            urlRedirect: {
              path: shortPath,
              target: shopifyRedirectTarget,
            },
          },
          throwOnUnauthorized: Boolean(params.onUnauthorizedRefresh && !refreshedOnce),
        });
      } catch (err) {
        if (
          err instanceof ShopifyUnauthorizedError &&
          params.onUnauthorizedRefresh &&
          !refreshedOnce
        ) {
          refreshedOnce = true;
          activeAccessToken = await params.onUnauthorizedRefresh();
          data = await this.executeShopifyGraphql<RedirectMutationData>({
            fetchImpl,
            shopDomain: setting.shopDomain,
            adminAccessToken: activeAccessToken,
            query: mutation,
            variables: {
              urlRedirect: {
                path: shortPath,
                target: shopifyRedirectTarget,
              },
            },
          });
        } else {
          throw err;
        }
      }

      const payload = data.urlRedirectCreate;
      const userErrors = payload?.userErrors ?? [];
      if (userErrors.length > 0) {
        const combined = userErrors.map((e) => e.message).join('; ');
        lastError = combined;
        const isCollision = /taken|already exists|in use/i.test(combined);
        if (isCollision && !params.customSlug) {
          continue;
        }
        throw AppError.validation(`Shopify từ chối tạo Redirect (${shortPath}): ${combined}`);
      }

      const createdRedirect = payload?.urlRedirect;
      if (!createdRedirect) {
        throw AppError.conflict('Shopify không trả về dữ liệu urlRedirect sau khi tạo.');
      }

      const saved = await this.prisma.storeShortLink.upsert({
        where: {
          storeId_targetUrl: {
            storeId,
            targetUrl: canonicalTargetUrl,
          },
        },
        create: {
          storeId,
          workspaceId,
          targetUrl: canonicalTargetUrl,
          shopifyTarget: shopifyRedirectTarget,
          shortPath: createdRedirect.path || shortPath,
          shortUrl: `https://${setting.publicDomain}${createdRedirect.path || shortPath}`,
          shopifyRedirectId: createdRedirect.id,
          createdByUserId: actorUserId,
        },
        update: {
          shopifyTarget: shopifyRedirectTarget,
          shortPath: createdRedirect.path || shortPath,
          shortUrl: `https://${setting.publicDomain}${createdRedirect.path || shortPath}`,
          shopifyRedirectId: createdRedirect.id,
        },
      });

      return {
        inputUrl: rawUrl,
        targetUrl: canonicalTargetUrl,
        shortUrl: saved.shortUrl,
        shortPath: saved.shortPath,
        reused: false,
      };
    }

    throw AppError.conflict(`Không tạo được mã rút gọn sau ${maxAttempts} lần thử: ${lastError}`);
  }

  private async resolveValidShopifyAccessToken(params: {
    storeId: string;
    setting: {
      shopDomain: string;
      clientId: string;
      clientSecret: string;
      cachedAccessToken?: string | null;
      tokenExpiresAt?: Date | null;
    };
    fetchImpl: typeof fetch;
    forceRefresh: boolean;
  }): Promise<string> {
    const { storeId, setting, fetchImpl, forceRefresh } = params;

    if (
      !forceRefresh &&
      setting.cachedAccessToken &&
      setting.tokenExpiresAt &&
      setting.tokenExpiresAt.getTime() - Date.now() > SHOPIFY_TOKEN_REFRESH_BUFFER_MS
    ) {
      try {
        return decryptToken(setting.cachedAccessToken, this.keyring);
      } catch {
        // Fall through to re-exchange if keyring decryption fails
      }
    }

    const existingPromise = this.inflightTokenRefresh.get(storeId);
    if (existingPromise) {
      return existingPromise;
    }

    const refreshPromise = (async () => {
      const plainClientSecret = decryptToken(setting.clientSecret, this.keyring);
      const exchanged = await this.exchangeShopifyClientCredentials({
        fetchImpl,
        shopDomain: setting.shopDomain,
        clientId: setting.clientId,
        clientSecret: plainClientSecret,
      });

      const encryptedAccessToken = encryptToken(exchanged.accessToken, this.keyring);
      await this.prisma.storeShopifySetting.update({
        where: { storeId },
        data: {
          cachedAccessToken: encryptedAccessToken.ciphertext,
          tokenExpiresAt: exchanged.expiresAt,
          ...(exchanged.grantedScopes ? { grantedScopes: exchanged.grantedScopes } : {}),
        },
      });

      setting.cachedAccessToken = encryptedAccessToken.ciphertext;
      setting.tokenExpiresAt = exchanged.expiresAt;

      return exchanged.accessToken;
    })();

    this.inflightTokenRefresh.set(storeId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.inflightTokenRefresh.delete(storeId);
    }
  }

  private async exchangeShopifyClientCredentials(params: {
    fetchImpl: typeof fetch;
    shopDomain: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{
    accessToken: string;
    expiresAt: Date;
    grantedScopes: string | null;
  }> {
    const endpoint = `https://${params.shopDomain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }).toString();

    let response: Response;
    try {
      response = await params.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
    } catch (error) {
      const msg = scrubSecretsFromText(
        error instanceof Error ? error.message : 'Lỗi kết nối mạng tới Shopify OAuth.',
      );
      throw AppError.conflict(`Không thể kết nối tới Shopify OAuth (${params.shopDomain}): ${msg}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      const suggestedMatch = /([a-z0-9-]+\.myshopify\.com)/i.exec(location);
      const hint = suggestedMatch?.[1]
        ? ` Hãy đổi Shop Admin Domain thành "${suggestedMatch[1].toLowerCase()}".`
        : '';
      throw AppError.validation(
        `Shopify trả về HTTP ${response.status} Redirect cho "${params.shopDomain}".${hint}`,
      );
    }

    if (response.status === 404) {
      throw AppError.validation(
        `Không tìm thấy cửa hàng Shopify "${params.shopDomain}" (HTTP 404). Hãy kiểm tra lại tên miền *.myshopify.com.`,
      );
    }

    const rawText = await response.text();
    let parsedJson: {
      access_token?: string;
      scope?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
      errors?: string | Record<string, unknown>;
    } = {};
    try {
      parsedJson = JSON.parse(rawText) as typeof parsedJson;
    } catch {
      // Non-JSON error page from Shopify
    }

    if (!response.ok) {
      const rawCode = [
        parsedJson.error,
        parsedJson.error_description,
        typeof parsedJson.errors === 'string' ? parsedJson.errors : '',
        rawText.slice(0, 240),
      ]
        .filter(Boolean)
        .join(' ');

      if (/app_not_installed/i.test(rawCode)) {
        throw AppError.validation(
          `App chưa được cài đặt lên Store "${params.shopDomain}" (app_not_installed). Trên trang $ shopify dev → chọn App → Home → bấm "Install app" lên đúng Store này rồi thử lại.`,
        );
      }
      if (/shop_not_permitted/i.test(rawCode)) {
        throw AppError.validation(
          `Shopify từ chối "shop_not_permitted": App và Store "${params.shopDomain}" không nằm cùng 1 Organization. Hãy kiểm tra góc dưới bên trái trang $ shopify dev đang chọn đúng Store này rồi tạo App trong đó.`,
        );
      }
      if (
        /invalid_client|unauthorized|invalid api key/i.test(rawCode) ||
        response.status === 401 ||
        response.status === 403
      ) {
        throw AppError.validation(
          `Client ID hoặc Client Secret không chính xác (HTTP ${response.status}). Hãy mở $ shopify dev → chọn App → Settings để copy đúng Client ID và Client Secret.`,
        );
      }

      throw AppError.validation(
        `Shopify từ chối cấp Access Token (HTTP ${response.status}): ${scrubSecretsFromText(rawCode.slice(0, 200) || 'Lỗi không xác định')}`,
      );
    }

    const accessToken = parsedJson.access_token?.trim();
    if (!accessToken) {
      throw AppError.conflict('Shopify OAuth không trả về access_token hợp lệ.');
    }

    const grantedScopes = parsedJson.scope?.trim() || null;
    if (grantedScopes) {
      const scopeSet = new Set(
        grantedScopes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (!scopeSet.has('write_online_store_navigation')) {
        throw AppError.validation(
          `App trên $ shopify dev chưa bật quyền "write_online_store_navigation" (quyền hiện tại: ${grantedScopes}). Hãy vào App → Versions → thêm "read_online_store_navigation" & "write_online_store_navigation" → bấm Release → cập nhật lên Store.`,
        );
      }
    }

    const expiresInSeconds = Math.max(300, Number(parsedJson.expires_in) || 86_399);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    return {
      accessToken,
      expiresAt,
      grantedScopes,
    };
  }

  private async verifyShopifyShopWithFetch(params: {
    fetchImpl: typeof fetch;
    shopDomain: string;
    adminAccessToken: string;
  }): Promise<{
    shopName: string;
    myshopifyDomain: string;
    primaryDomainHost: string | null;
  }> {
    const query = `
      query SocialHubVerifyShop {
        shop {
          name
          myshopifyDomain
          primaryDomain {
            host
            url
          }
        }
      }
    `;
    const data = await this.executeShopifyGraphql<{
      shop?: {
        name: string;
        myshopifyDomain: string;
        primaryDomain?: { host?: string | null; url?: string | null } | null;
      };
    }>({
      fetchImpl: params.fetchImpl,
      shopDomain: params.shopDomain,
      adminAccessToken: params.adminAccessToken,
      query,
    });

    if (!data.shop) {
      throw AppError.validation('Không đọc được thông tin cửa hàng từ Shopify Admin API.');
    }

    return {
      shopName: data.shop.name,
      myshopifyDomain: data.shop.myshopifyDomain.toLowerCase(),
      primaryDomainHost: data.shop.primaryDomain?.host?.toLowerCase() ?? null,
    };
  }

  private async executeShopifyGraphql<T>(params: {
    fetchImpl: typeof fetch;
    shopDomain: string;
    adminAccessToken: string;
    query: string;
    variables?: Record<string, Prisma.JsonValue | Record<string, unknown>>;
    throwOnUnauthorized?: boolean;
  }): Promise<T> {
    const endpoint = `https://${params.shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
    let response: Response;
    try {
      response = await params.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': params.adminAccessToken,
        },
        body: JSON.stringify({
          query: params.query,
          ...(params.variables ? { variables: params.variables } : {}),
        }),
      });
    } catch (error) {
      const msg = scrubSecretsFromText(
        error instanceof Error ? error.message : 'Lỗi kết nối mạng tới Shopify.',
      );
      throw AppError.conflict(`Không thể kết nối tới Shopify (${params.shopDomain}): ${msg}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      const suggestedMatch = /([a-z0-9-]+\.myshopify\.com)/i.exec(location);
      const hint = suggestedMatch?.[1]
        ? ` Hãy đổi Shop Admin Domain thành "${suggestedMatch[1].toLowerCase()}".`
        : '';
      throw AppError.validation(
        `Shopify trả về HTTP ${response.status} Redirect cho "${params.shopDomain}".${hint}`,
      );
    }

    if (response.status === 401 && params.throwOnUnauthorized) {
      throw new ShopifyUnauthorizedError('Shopify access token expired or revoked');
    }

    if (response.status === 401 || response.status === 403) {
      throw AppError.validation(
        `Shopify từ chối xác thực (HTTP ${response.status}). Hãy kiểm tra lại Client ID / Client Secret và đảm bảo App trên $ shopify dev đã được Install lên Store "${params.shopDomain}".`,
      );
    }

    if (response.status === 404) {
      throw AppError.validation(
        `Không tìm thấy cửa hàng Shopify "${params.shopDomain}" (HTTP 404). Hãy kiểm tra lại tên miền *.myshopify.com.`,
      );
    }

    if (!response.ok) {
      throw AppError.conflict(
        `Shopify Admin API trả về HTTP ${response.status} trên "${params.shopDomain}".`,
      );
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }> | string;
    };

    if (json.errors) {
      const rawMessage =
        typeof json.errors === 'string'
          ? json.errors
          : json.errors.map((err) => err.message || 'GraphQL error').join('; ');
      if (/access denied|write_online_store_navigation|write_content/i.test(rawMessage)) {
        throw AppError.validation(
          'App Shopify thiếu quyền tạo URL Redirect. Trên $ shopify dev → chọn App → Versions → thêm quyền "write_online_store_navigation" và "read_online_store_navigation" → bấm Release → Install/Update lại lên Store.',
        );
      }
      throw AppError.validation(`Lỗi Shopify GraphQL: ${scrubSecretsFromText(rawMessage)}`);
    }

    if (!json.data) {
      throw AppError.conflict('Shopify GraphQL phản hồi rỗng (không có trường data).');
    }

    return json.data;
  }
}
