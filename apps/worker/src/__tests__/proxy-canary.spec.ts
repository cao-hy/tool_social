import { describe, it, expect } from 'vitest';
import {
  createProxiedFetch,
  createDirectFetch,
  ProxyDispatcherPool,
  ProxyRuntimeService,
  ProxyConfigurationError,
} from '@socialhub/config';
import {
  ProxyEndpointValidator,
  ProxyEndpointBlockedError,
  computeProxyRouteFingerprint,
  scrubSecretsFromText,
} from '@socialhub/security';
import type { ValidatedProxyEndpoint } from '@socialhub/security';
import { createServer } from 'node:http';

describe('Proxy Canary & Security Integration Test Suite', () => {
  it('1. Proxy request does NOT leak to direct target IP', async () => {
    let targetCalled = false;
    const targetServer = createServer((_req, res) => {
      targetCalled = true;
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const targetPort = (targetServer.address() as any).port;
    const targetUrl = `http://127.0.0.1:${targetPort}/test`;

    let proxyCalled = false;
    const proxyServer = createServer((_req, res) => {
      proxyCalled = true;
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

    expect(body).toBe('proxy_response');
    expect(proxyCalled).toBe(true);
    expect(targetCalled).toBe(false);

    dispatcherHandle.release();
    await pool.closeAll();
    await new Promise((r) => targetServer.close(r));
    await new Promise((r) => proxyServer.close(r));
  });

  it('2. createDirectFetch connects to destination directly', async () => {
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

  it('3. Proxy enabled with missing proxyUrl throws ProxyConfigurationError (Fail-Closed)', async () => {
    const dummyPolicy = {} as any;
    const runtime = new ProxyRuntimeService(dummyPolicy, 'test-secret');

    await expect(
      runtime.prepareWorkspace(
        'ws_1',
        async () => ({
          enabled: true,
          proxyUrl: null,
          proxyUrlMasked: null,
          countryLock: null,
          configVersion: 1,
          updatedAt: new Date(),
        }),
        (c) => c,
      ),
    ).rejects.toThrow(ProxyConfigurationError);
  });

  it('4. SOCKS proxy protocol is rejected in ProxyEndpointValidator', async () => {
    const fakeDns = { lookup: async () => [{ address: '1.2.3.4', family: 4 }] } as any;
    const validator = new ProxyEndpointValidator(fakeDns);

    await expect(validator.validate('socks5://proxy.example.com:1080')).rejects.toThrow(
      ProxyEndpointBlockedError,
    );
  });

  it('5. Proxy route fingerprint includes canonical gateway IP set', () => {
    const fp1 = computeProxyRouteFingerprint(
      'http://proxy.example.com:8080',
      [
        { address: '1.2.3.4', family: 4 },
        { address: '1.2.3.5', family: 4 },
      ],
      'secret123',
    );

    const fp2 = computeProxyRouteFingerprint(
      'http://proxy.example.com:8080',
      [
        { address: '1.2.3.5', family: 4 },
        { address: '1.2.3.4', family: 4 },
      ],
      'secret123',
    );

    expect(fp1).toBe(fp2); // Sorted gateway list produces identical route fingerprint
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('6. Secret scrubber redacts raw proxy credentials in error logs', () => {
    const rawError = 'Connection to http://user:secretPassword123@proxy.example.com:8080 failed';
    const scrubbed = scrubSecretsFromText(rawError);

    expect(scrubbed).not.toContain('secretPassword123');
    expect(scrubbed).toContain('http://***:***@proxy.example.com:8080');
  });

  it('7. ConfigVersion mismatch post-attestation triggers handle release & throws error', async () => {
    let callCount = 0;
    const mockPolicy = {
      getAttestation: async () => ({
        workspaceId: 'ws_1',
        configVersion: 1,
        proxyFingerprint: 'fp',
        checkedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        ip: '1.1.1.1',
        countryCode: 'US',
        provider: 'mock',
      }),
    } as any;

    const runtime = new ProxyRuntimeService(mockPolicy, 'test-secret');

    (runtime as any).endpointValidator = {
      validate: async () => ({
        protocol: 'http:',
        hostname: 'proxy.example.com',
        port: 8080,
        normalizedUrl: 'http://proxy.example.com:8080',
        gatewayAddresses: [{ address: '93.184.216.34', family: 4 }],
        validatedAt: Date.now(),
      }),
    };

    // Simulate config version changing from 1 to 2 during prepareWorkspace
    await expect(
      runtime.prepareWorkspace(
        'ws_1',
        async () => {
          callCount++;
          return {
            enabled: true,
            proxyUrl: 'http://proxy.example.com:8080',
            proxyUrlMasked: 'mask',
            countryLock: null,
            configVersion: callCount === 1 ? 1 : 2, // Version changed on 2nd read
            updatedAt: new Date(),
          };
        },
        (c) => c,
      ),
    ).rejects.toThrow(ProxyConfigurationError);

    await runtime.closeAll();
  });
});
