import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ProxyConfig } from '@socialhub/shared';

export class ProxyConfigurationError extends Error {
  readonly code = 'PROXY_CONFIGURATION_MISSING';

  constructor(message = 'Proxy đang bật nhưng chưa có Proxy URL.') {
    super(message);
    this.name = 'ProxyConfigurationError';
  }
}

const proxyAgents = new Map<string, Dispatcher>();

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
        isp: stringOrNull(connection.isp),
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
        country: stringOrNull(value.country_name),
        city: stringOrNull(value.city),
        isp: stringOrNull(value.org),
      };
    },
  },
  {
    name: 'ip-api.com',
    url: 'http://ip-api.com/json/?fields=status,message,query,countryCode,country,city,isp',
    parse: (data: unknown): ParsedIpLookup => {
      const value = asRecord(data);
      return {
        ip: stringOrNull(value.query),
        countryCode: stringOrNull(value.countryCode),
        country: stringOrNull(value.country),
        city: stringOrNull(value.city),
        isp: stringOrNull(value.isp),
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

export function createProxyAwareFetch(
  configInput?: ProxyConfig | (() => ProxyConfig),
): typeof fetch {
  return async (input, init) => {
    const config = resolveProxyConfigInput(configInput);

    // Proxy thực sự tắt thì mới được phép đi direct.
    if (!config.enabled) {
      return undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        init as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>;
    }

    const proxyUrl = resolveOutboundProxyUrl(config);

    // Proxy bật nhưng không có URL: chặn request.
    if (!proxyUrl) {
      throw new ProxyConfigurationError(
        'Proxy đang bật nhưng chưa có Proxy URL trong workspace hoặc HTTP_PROXY/HTTPS_PROXY.',
      );
    }

    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher: getProxyAgent(proxyUrl),
      } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  };
}

export async function checkProxyAwareNetwork(
  proxyConfig = readProxyConfig(),
  fetchImpl: typeof fetch = createProxyAwareFetch(proxyConfig),
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
      const response = await fetchJsonWithTimeout(fetchImpl, provider.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const parsed = provider.parse(await response.json());
      if (!parsed.ip) {
        throw new Error('Response không có IP');
      }
      const countryCode = parsed.countryCode?.toUpperCase() ?? null;
      const proxyActive = normalizedProxyConfig.enabled && proxyAvailable;

      return {
        ...base,
        ...parsed,
        proxyActive,
        countryCode,
        provider: provider.name,
        checkOk: true,
        checkError: null,
        checkErrors: [],
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

function getProxyAgent(proxyUrl: string): Dispatcher {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = isSocksProxyUrl(proxyUrl)
    ? new Socks5ProxyAgent(proxyUrl)
    : new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
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

export function publicProxyConfig(config: ProxyConfig): ProxyConfig {
  const normalized = normalizeProxyConfig(config);
  return {
    enabled: normalized.enabled,
    countryLock: normalized.countryLock,
    proxyUrlMasked: normalized.proxyUrlMasked,
    source: normalized.source,
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
  };
}

function resolveProxyConfigInput(configInput?: ProxyConfig | (() => ProxyConfig)): ProxyConfig {
  if (!configInput) return readProxyConfig();
  return normalizeProxyConfig(typeof configInput === 'function' ? configInput() : configInput);
}

function resolveOutboundProxyUrl(config?: ProxyConfig): string | null {
  const normalized = config ? normalizeProxyConfig(config) : readProxyConfig();
  if (!normalized.enabled) return null;
  return normalized.proxyUrl?.trim() || getConfiguredProxyUrl();
}

function isSocksProxyUrl(value: string | null): value is string {
  if (!value) return false;
  return value.toLowerCase().startsWith('socks5://') || value.toLowerCase().startsWith('socks://');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
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
