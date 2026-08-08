import { fetch as undiciFetch } from 'undici';
import { isIP } from 'node:net';
import type { ProxyConfig } from '@socialhub/shared';

export class ProxyConfigurationError extends Error {
  readonly code = 'PROXY_CONFIGURATION_MISSING';

  constructor(message = 'Proxy đang bật nhưng chưa có Proxy URL.') {
    super(message);
    this.name = 'ProxyConfigurationError';
  }
}

export interface ProxyAwareNetworkStatus {
  checkedAt: string;
  ip: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  isp: string | null;
  provider: string | null;
  checkOk: boolean;
  checkError: string | null;
  checkErrors: string[];
  proxyConfig: ProxyConfig;
  proxyAvailable: boolean;
  proxyActive: boolean;
  countryLockSatisfied: boolean;
}

export interface WorkspaceProxySettingRecord {
  enabled: boolean;
  proxyUrl: string | null;
  proxyUrlMasked: string | null;
  countryLock: string | null;
  configVersion: number;
  updatedAt: Date;
}

interface ParsedIpLookup {
  ip: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  isp: string | null;
}

const IP_LOOKUP_PROVIDERS = [
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: (data: unknown): ParsedIpLookup => {
      const value = asRecord(data);
      const connection = asRecord(value.connection);
      return {
        ip: stringOrNull(value.ip),
        countryCode: stringOrNull(value.country_code),
        country: stringOrNull(value.country),
        city: stringOrNull(value.city),
        isp:
          stringOrNull(connection.isp) ||
          stringOrNull(connection.org) ||
          stringOrNull(value.isp) ||
          stringOrNull(value.org),
      };
    },
  },
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    parse: (data: unknown): ParsedIpLookup => {
      const value = asRecord(data);
      return {
        ip: stringOrNull(value.ip),
        countryCode: stringOrNull(value.country_code),
        country: stringOrNull(value.country_name) || stringOrNull(value.country),
        city: stringOrNull(value.city),
        isp: stringOrNull(value.org) || stringOrNull(value.asn) || stringOrNull(value.isp),
      };
    },
  },
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    parse: (data: unknown): ParsedIpLookup => {
      const value = asRecord(data);
      return {
        ip: stringOrNull(value.ip),
        countryCode: stringOrNull(value.country),
        country: stringOrNull(value.country),
        city: stringOrNull(value.city),
        isp: stringOrNull(value.org),
      };
    },
  },
] as const;

export function readProxyConfig(): ProxyConfig {
  const proxyUrl = getConfiguredProxyUrl();
  return normalizeProxyConfig({
    enabled: parseBoolean(process.env.PROXY_ENABLED, false),
    countryLock: process.env.PROXY_COUNTRY_LOCK,
    proxyUrl,
    proxyUrlMasked: maskProxyUrl(proxyUrl),
    source: proxyUrl ? 'ENV' : 'DIRECT',
  });
}

export function hasOutboundProxyConfigured(config?: ProxyConfig): boolean {
  return Boolean(resolveOutboundProxyUrl(config));
}

import type { ProxyDispatcherHandle } from './proxy-dispatcher-pool';

export interface EnabledProxyConfig extends ProxyConfig {
  enabled: true;
  proxyUrl: string;
}

export function createDirectFetch(): typeof fetch {
  return undiciFetch as unknown as typeof fetch;
}

export function createProxiedFetch(
  config: EnabledProxyConfig,
  dispatcherHandle: ProxyDispatcherHandle,
): typeof fetch {
  if (!config.enabled || !config.proxyUrl || !dispatcherHandle) {
    throw new ProxyConfigurationError('Validated proxy dispatcher is required.');
  }

  return async (input, init) => {
    const lease = dispatcherHandle.acquireRequestLease();
    try {
      const response = await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        {
          ...init,
          dispatcher: dispatcherHandle.dispatcher,
        } as Parameters<typeof undiciFetch>[1],
      );

      if (!response.body) {
        lease.release();
        return response as unknown as Response;
      }

      const reader = response.body.getReader();
      let released = false;
      const releaseOnce = () => {
        if (!released) {
          released = true;
          lease.release();
        }
      };

      const wrappedStream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              releaseOnce();
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (err) {
            releaseOnce();
            controller.error(err);
          }
        },
        async cancel(reason) {
          releaseOnce();
          await reader.cancel(reason);
        },
      });

      const cloned = new Response(wrappedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperty(cloned, 'url', { value: response.url });

      return cloned as unknown as Response;
    } catch (err) {
      lease.release();
      throw err;
    }
  };
}

export async function checkProxyAwareNetwork(
  proxyConfig: ProxyConfig,
  fetchImpl: typeof fetch,
): Promise<ProxyAwareNetworkStatus> {
  const normalizedProxyConfig = normalizeProxyConfig(proxyConfig);
  const proxyAvailable = hasOutboundProxyConfigured(normalizedProxyConfig);
  const activeCountryLock = proxyConfig.enabled ? proxyConfig.countryLock : null;
  const base = {
    checkedAt: new Date().toISOString(),
    proxyConfig: normalizedProxyConfig,
    proxyAvailable,
  };
  const errors: string[] = [];

  for (const provider of IP_LOOKUP_PROVIDERS) {
    try {
      const json = await fetchJsonWithTimeout(fetchImpl, provider.url);
      const parsed = provider.parse(json);
      if (!parsed.ip || !isIP(parsed.ip)) {
        throw new Error('Response không có IP hợp lệ');
      }
      const countryCode = parsed.countryCode?.toUpperCase() ?? null;
      if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
        throw new Error('Country code không hợp lệ');
      }
      const proxyActive = normalizedProxyConfig.enabled && proxyAvailable;

      return {
        ...base,
        ...parsed,
        proxyActive,
        countryCode,
        provider: provider.name,
        checkOk: true,
        checkError: null,
        checkErrors: errors,
        countryLockSatisfied:
          !normalizedProxyConfig.enabled ||
          (proxyActive && (!activeCountryLock || countryCode === activeCountryLock)),
      };
    } catch (error) {
      errors.push(`${provider.name}: ${formatError(error)}`);
    }
  }

  return {
    ...base,
    ip: null,
    countryCode: null,
    country: null,
    city: null,
    isp: null,
    provider: null,
    proxyActive: false,
    checkOk: false,
    checkError: errors.at(-1) ?? 'Không gọi được provider kiểm tra IP',
    checkErrors: errors,
    countryLockSatisfied: !normalizedProxyConfig.enabled,
  };
}

export function getConfiguredProxyUrl(): string | null {
  return (
    process.env.https_proxy?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    null
  );
}

export function maskProxyUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username ? '***' : '';
    return url.toString();
  } catch {
    return value.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
  }
}

export function publicProxyConfig(config: ProxyConfig) {
  const normalized = normalizeProxyConfig(config);
  return {
    enabled: normalized.enabled,
    countryLock: normalized.countryLock,
    proxyUrlMasked: normalized.proxyUrlMasked,
    source: normalized.source,
    configVersion: normalized.version,
  };
}

export function proxyConfigFromWorkspaceSetting(
  setting: WorkspaceProxySettingRecord | null,
  decryptProxyUrl: (ciphertext: string) => string,
): ProxyConfig {
  if (!setting) {
    return normalizeProxyConfig({
      enabled: false,
      countryLock: null,
      proxyUrl: null,
      proxyUrlMasked: null,
      source: 'DIRECT',
    });
  }

  const proxyUrl = setting.proxyUrl ? decryptProxyUrl(setting.proxyUrl) : null;
  return normalizeProxyConfig({
    enabled: setting.enabled,
    countryLock: setting.countryLock,
    proxyUrl,
    proxyUrlMasked: setting.proxyUrlMasked,
    source: 'WORKSPACE',
    version: setting.configVersion,
  });
}

export function resolveWorkspaceProxyConfig(
  setting: WorkspaceProxySettingRecord | null | undefined,
  decryptProxyUrl: (ciphertext: string) => string,
): ProxyConfig {
  const allowEnvFallback = process.env.ALLOW_ENV_PROXY_FALLBACK === 'true';
  const envProxyUrl = allowEnvFallback ? getConfiguredProxyUrl() : null;

  if (!setting) {
    return normalizeProxyConfig({
      enabled: false,
      countryLock: null,
      proxyUrl: envProxyUrl,
      proxyUrlMasked: maskProxyUrl(envProxyUrl),
      source: envProxyUrl ? 'ENV' : 'DIRECT',
    });
  }

  const workspaceConfig = proxyConfigFromWorkspaceSetting(setting, decryptProxyUrl);

  if (workspaceConfig.proxyUrl) {
    return workspaceConfig;
  }

  return normalizeProxyConfig({
    ...workspaceConfig,
    proxyUrl: envProxyUrl,
    proxyUrlMasked: maskProxyUrl(envProxyUrl),
    source: envProxyUrl ? 'ENV' : 'DIRECT',
  });
}

export function normalizeProxyConfig(value: Partial<ProxyConfig>): ProxyConfig {
  const proxyUrl =
    typeof value.proxyUrl === 'string' && value.proxyUrl.trim() ? value.proxyUrl.trim() : null;
  const source = value.source ?? (proxyUrl ? 'WORKSPACE' : 'DIRECT');
  return {
    enabled: value.enabled === true,
    countryLock:
      typeof value.countryLock === 'string' && value.countryLock.trim()
        ? value.countryLock.trim().toUpperCase()
        : null,
    proxyUrl,
    proxyUrlMasked: value.proxyUrlMasked ?? maskProxyUrl(proxyUrl),
    source,
    version: value.version,
  };
}

function resolveOutboundProxyUrl(config?: ProxyConfig): string | null {
  const normalized = config ? normalizeProxyConfig(config) : readProxyConfig();
  if (!normalized.enabled) return null;
  return normalized.proxyUrl?.trim() || null;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SocialHub/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('Response không có body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytesRead = 0;
    const maxBytes = 256 * 1024; // 256KB

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel('Response body too large');
          throw new Error('Nội dung response quá lớn (vượt quá 256KB)');
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();

    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const cause = formatCause(error);
    const message = error.message || error.name;
    return cause ? `${message} (${cause})` : message;
  }
  return 'Unknown error';
}

function formatCause(error: Error): string | null {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return null;
  const record = cause as Record<string, unknown>;
  const parts = [record.code, record.errno, record.syscall, record.hostname]
    .filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    )
    .map(String);
  if (typeof record.message === 'string') parts.push(record.message);
  return parts.length ? [...new Set(parts)].join(' ') : null;
}
