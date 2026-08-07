import { describe, it, expect } from 'vitest';
import { createProxiedFetch, createDirectFetch, ProxyDispatcherPool } from '@socialhub/config';
import type { ValidatedProxyEndpoint } from '@socialhub/security';
import { createServer } from 'node:http';

describe('Proxy Canary Test', () => {
  it('đảm bảo request qua proxy không leak tới IP thật trực tiếp', async () => {
    // 1. Dựng 1 fake target server (destination) đóng vai trò là API thật
    let targetCalled = false;
    const targetServer = createServer((_req, res) => {
      targetCalled = true;
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const targetPort = (targetServer.address() as any).port;
    const targetUrl = `http://127.0.0.1:${targetPort}/test`;

    // 2. Dựng 1 fake proxy server
    let proxyCalled = false;
    const proxyServer = createServer((_req, res) => {
      proxyCalled = true;
      // Trả về mock data từ proxy mà không gọi đến target server
      res.writeHead(200);
      res.end('proxy_response');
    });

    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxyServer.address() as any).port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const pool = new ProxyDispatcherPool('test-secret');
    const endpoint: ValidatedProxyEndpoint = {
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: proxyPort,
      normalizedUrl: proxyUrl,
      gatewayAddresses: [{ address: '127.0.0.1', family: 4 }],
      validatedAt: Date.now(),
    };

    const dispatcherHandle = await pool.acquire(endpoint);

    // 3. Sử dụng createProxiedFetch để gọi target
    const fetchProxy = createProxiedFetch(
      {
        enabled: true,
        proxyUrl,
        countryLock: null,
        proxyUrlMasked: 'mask',
        source: 'ENV',
        version: 1,
      },
      dispatcherHandle,
    );

    const res = await fetchProxy(targetUrl);
    const body = await res.text();

    // 4. Assert
    expect(body).toBe('proxy_response');
    expect(proxyCalled).toBe(true);
    expect(targetCalled).toBe(false); // IP Leak prevention: Target không bao giờ nhận được request trực tiếp

    // Cleanup
    pool.closeAll();
    await new Promise((r) => targetServer.close(r));
    await new Promise((r) => proxyServer.close(r));
  });

  it('createDirectFetch vẫn gọi đến đích trực tiếp', async () => {
    let targetCalled = false;
    const targetServer = createServer((_req, res) => {
      targetCalled = true;
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const targetPort = (targetServer.address() as any).port;
    const targetUrl = `http://127.0.0.1:${targetPort}/test`;

    const fetchDirect = createDirectFetch();
    const res = await fetchDirect(targetUrl);
    const body = await res.text();

    expect(body).toBe('ok');
    expect(targetCalled).toBe(true);

    await new Promise((r) => targetServer.close(r));
  });
});
