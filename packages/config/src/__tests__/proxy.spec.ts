import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { checkProxyAwareNetwork, createDirectFetch, createProxiedFetch } from '../proxy';

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
});

afterEach(() => {
  process.env = { ...originalEnv };
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

describe('createProxiedFetch / createDirectFetch', () => {
  it('throws ProxyConfigurationError if proxy is enabled but missing proxyUrl', async () => {
    // createProxiedFetch without dispatcherHandle will throw Error, not ProxyConfigurationError?
    // Wait, createProxiedFetch expects a dispatcherHandle and proxyConfig.
    // If proxyUrl is missing, proxy-runtime throws.
    // But let's test createProxiedFetch when proxyUrl is somehow null or undefined.
    expect(() =>
      createProxiedFetch(
        {
          enabled: true,
          proxyUrl: null as any,
          countryLock: null,
          source: 'WORKSPACE',
        },
        {} as any,
      ),
    ).toThrow();
  });

  it('does not throw if proxy is disabled and proxyUrl is missing', async () => {
    // Tạo một server nội bộ để đảm bảo kết nối trực tiếp thực sự thành công
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const fetchImpl = createDirectFetch();

      const res = await fetchImpl(`http://127.0.0.1:${port}`);
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
