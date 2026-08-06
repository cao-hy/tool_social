import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkProxyAwareNetwork,
  resolveProxyConfigPath,
  createProxyAwareFetch,
  ProxyConfigurationError,
} from '../proxy';

const originalCwd = process.cwd();
const originalProxyConfigPath = process.env.PROXY_CONFIG_PATH;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalProxyConfigPath === undefined) {
    delete process.env.PROXY_CONFIG_PATH;
  } else {
    process.env.PROXY_CONFIG_PATH = originalProxyConfigPath;
  }
});

describe('proxy config path', () => {
  it('relative PROXY_CONFIG_PATH resolves from workspace root so api and worker share one file', () => {
    const root = mkdtempSync(join(tmpdir(), 'socialhub-proxy-root-'));
    const appDir = join(root, 'apps', 'api');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'socialhub-manager' }));
    process.chdir(appDir);
    process.env.PROXY_CONFIG_PATH = '.proxy-config.json';

    try {
      expect(resolveProxyConfigPath()).toBe(join(root, '.proxy-config.json'));
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkProxyAwareNetwork', () => {
  it('does not enforce country lock when proxy is disabled', async () => {
    const response = new Response(
      JSON.stringify({
        ip: '203.0.113.10',
        country_code: 'VN',
        country: 'Vietnam',
        city: 'Ho Chi Minh City',
        connection: { isp: 'Example ISP' },
      }),
      { status: 200 },
    );
    const fetchImpl = (() => Promise.resolve(response)) as typeof fetch;

    const status = await checkProxyAwareNetwork({ enabled: false, countryLock: 'US' }, fetchImpl);

    expect(status.proxyActive).toBe(false);
    expect(status.countryCode).toBe('VN');
    expect(status.countryLockSatisfied).toBe(true);
  });

  it('fails country lock when proxy is enabled but URL is missing', async () => {
    const fetchImpl = (() => Promise.reject(new Error('Should not reach here'))) as typeof fetch;

    const status = await checkProxyAwareNetwork(
      { enabled: true, proxyUrl: null, countryLock: 'US' },
      fetchImpl,
    );

    expect(status.proxyActive).toBe(false);
    expect(status.checkOk).toBe(false);
    expect(status.countryLockSatisfied).toBe(false);
  });

  it('fails country lock when proxy is enabled but returns wrong country', async () => {
    const response = new Response(
      JSON.stringify({
        ip: '203.0.113.10',
        country_code: 'VN',
      }),
      { status: 200 },
    );
    const fetchImpl = (() => Promise.resolve(response)) as typeof fetch;

    const status = await checkProxyAwareNetwork(
      { enabled: true, proxyUrl: 'http://test:8080', countryLock: 'US' },
      fetchImpl,
    );

    expect(status.proxyActive).toBe(true);
    expect(status.countryCode).toBe('VN');
    expect(status.countryLockSatisfied).toBe(false);
  });
});

describe('createProxyAwareFetch', () => {
  it('throws ProxyConfigurationError if proxy is enabled but missing proxyUrl', async () => {
    const fetchImpl = createProxyAwareFetch({
      enabled: true,
      proxyUrl: null,
      countryLock: null,
      source: 'WORKSPACE',
    });
    await expect(fetchImpl('http://example.com')).rejects.toThrowError(ProxyConfigurationError);
  });

  it('does not throw if proxy is disabled and proxyUrl is missing', async () => {
    const fetchImpl = createProxyAwareFetch({
      enabled: false,
      proxyUrl: null,
      countryLock: null,
      source: 'WORKSPACE',
    });
    try {
      await fetchImpl('http://127.0.0.1:0');
    } catch (err) {
      expect(err).not.toBeInstanceOf(ProxyConfigurationError);
    }
  });
});
