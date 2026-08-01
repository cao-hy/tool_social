import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProxyAwareNetwork, resolveProxyConfigPath } from '../proxy';

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
});
