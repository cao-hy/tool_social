import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ProxyConfig } from '@socialhub/shared';

const CONFIG_FILE_NAME = '.proxy-config.json';
let proxyAgent: Dispatcher | null = null;
let proxyAgentKey: string | null = null;

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
  const fallback = readProxyConfigFromEnv();
  try {
    const configPath = resolveProxyConfigPath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return normalizeProxyConfig({ ...fallback, ...JSON.parse(data) });
    }
  } catch (err) {
    console.error('Error reading proxy config', err);
  }
  return fallback;
}

export function writeProxyConfig(config: ProxyConfig): void {
  const configPath = resolveProxyConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalizeProxyConfig(config), null, 2), 'utf8');
}

export function applyProxyConfig(config: ProxyConfig): void {
  if (!config.enabled) {
    proxyAgent = null;
    proxyAgentKey = null;
  }
}

export function hasOutboundProxyConfigured(): boolean {
  return Boolean(getConfiguredProxyUrl());
}

export function createProxyAwareFetch(): typeof fetch {
  return async (input, init) => {
    const config = readProxyConfig();
    if (!config.enabled || !hasOutboundProxyConfigured()) {
      return undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        init as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>;
    }

    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher: getProxyAgent(),
      } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>;
  };
}

export async function checkProxyAwareNetwork(
  proxyConfig = readProxyConfig(),
  fetchImpl: typeof fetch = createProxyAwareFetch(),
): Promise<ProxyAwareNetworkStatus> {
  const proxyAvailable = hasOutboundProxyConfigured();
  const activeCountryLock = proxyConfig.enabled ? proxyConfig.countryLock : null;
  const base = {
    checkedAt: new Date().toISOString(),
    proxyConfig,
    proxyAvailable,
    proxyActive: proxyConfig.enabled && proxyAvailable,
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
      return {
        ...base,
        ...parsed,
        countryCode,
        provider: provider.name,
        checkOk: true,
        checkError: null,
        checkErrors: [],
        countryLockSatisfied: !activeCountryLock || countryCode === activeCountryLock,
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
    checkOk: false,
    checkError: errors.at(-1) ?? 'Không gọi được provider kiểm tra IP',
    checkErrors: errors,
    countryLockSatisfied: !activeCountryLock,
  };
}

export function initProxyWatcher(onConfigChanged?: (config: ProxyConfig) => void): void {
  applyProxyConfig(readProxyConfig());

  let lastContent = '';
  setInterval(() => {
    try {
      const configPath = resolveProxyConfigPath();
      const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
      if (content !== lastContent) {
        lastContent = content;
        const config = readProxyConfig();
        applyProxyConfig(config);
        if (onConfigChanged) onConfigChanged(config);
      }
    } catch {
      // Best-effort watcher: invalid partial writes are retried on the next tick.
    }
  }, 2000).unref();
}

export function resolveProxyConfigPath(): string {
  const explicitPath = process.env.PROXY_CONFIG_PATH?.trim();
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(findWorkspaceRoot(), explicitPath);
  }
  return path.join(findWorkspaceRoot(), CONFIG_FILE_NAME);
}

function readProxyConfigFromEnv(): ProxyConfig {
  return normalizeProxyConfig({
    enabled: parseBoolean(process.env.PROXY_ENABLED, false),
    countryLock: process.env.PROXY_COUNTRY_LOCK,
  });
}

function getProxyAgent(): Dispatcher {
  const proxyUrl = getConfiguredProxyUrl();
  if (!proxyUrl) {
    throw new Error('HTTP_PROXY/HTTPS_PROXY chưa được cấu hình.');
  }

  const agentKey = proxyUrl;
  if (proxyAgent && proxyAgentKey === agentKey) return proxyAgent;

  proxyAgentKey = agentKey;
  proxyAgent = isSocksProxyUrl(proxyUrl)
    ? new Socks5ProxyAgent(proxyUrl)
    : new ProxyAgent(proxyUrl);
  return proxyAgent;
}

function getConfiguredProxyUrl(): string | null {
  return (
    process.env.https_proxy?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    null
  );
}

function isSocksProxyUrl(value: string | null): value is string {
  if (!value) return false;
  return value.toLowerCase().startsWith('socks5://') || value.toLowerCase().startsWith('socks://');
}

function normalizeProxyConfig(value: Partial<ProxyConfig>): ProxyConfig {
  return {
    enabled: value.enabled === true,
    countryLock:
      typeof value.countryLock === 'string' && value.countryLock.trim()
        ? value.countryLock.trim().toUpperCase()
        : null,
  };
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

function findWorkspaceRoot(startDir = process.cwd()): string {
  let current = startDir;
  const root = path.parse(current).root;

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
          name?: string;
          workspaces?: unknown;
        };
        if (packageJson.name === 'socialhub-manager' || packageJson.workspaces) {
          return current;
        }
      } catch {
        // Keep climbing; malformed package.json should not break proxy defaults.
      }
    }

    if (current === root) return startDir;
    current = path.dirname(current);
  }
}
