import { describe, it, expect, vi } from 'vitest';
import {
  createProxiedFetch,
  createDirectFetch,
  ProxyDispatcherPool,
  ProxyRuntimeService,
  ProxyConfigurationMissingError,
  ProxyConfigurationChangedError,
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
    proxyServer.on('connect', (_req, socket) => {
      proxyCalled = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\nproxy_response');
      });
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

  it('3. Proxy enabled with missing proxyUrl throws ProxyConfigurationMissingError (Fail-Closed)', async () => {
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
    ).rejects.toThrow(ProxyConfigurationMissingError);
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
    ).rejects.toThrow(ProxyConfigurationChangedError);

    await runtime.closeAll();
  });

  it.each([
    ['T30 PROXY_REQUIRED + missing proxy setting fails closed', null, 'PROXY_REQUIRED'],
    [
      'PROXY_REQUIRED + decrypt failure fails closed',
      {
        enabled: true,
        proxyUrl: 'encrypted-proxy-url',
        proxyUrlMasked: 'mask',
        countryLock: null,
        configVersion: 1,
        updatedAt: new Date(),
      },
      'PROXY_REQUIRED',
    ],
  ] as const)('%s with direct transport count 0', async (_name, setting, egressPolicy) => {
    let directCount = 0;
    const targetServer = createServer((_req, res) => {
      directCount += 1;
      res.writeHead(200);
      res.end('direct');
    });
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const runtime = new ProxyRuntimeService({ getAttestation: vi.fn() } as any, 'test-secret');

    await expect(
      runtime.prepareWorkspace(
        'ws_1',
        async () => setting,
        () => {
          throw new Error('decrypt failed');
        },
        { getWorkspaceEgressPolicy: async () => egressPolicy },
      ),
    ).rejects.toThrow();

    expect(directCount).toBe(0);
    await runtime.closeAll();
    await new Promise((resolve) => targetServer.close(resolve));
  });

  it.each([
    ['PROXY_REQUIRED + DNS validation failure fails closed', 'PROXY_REQUIRED', 'dns failed'],
    [
      'T31 DIRECT_ALLOWED + configured proxy failure does not fallback direct',
      'DIRECT_ALLOWED',
      'dns failed',
    ],
  ] as const)('%s with direct transport count 0', async (_name, egressPolicy, errorMessage) => {
    let directCount = 0;
    const targetServer = createServer((_req, res) => {
      directCount += 1;
      res.writeHead(200);
      res.end('direct');
    });
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const runtime = new ProxyRuntimeService({ getAttestation: vi.fn() } as any, 'test-secret');
    (runtime as any).endpointValidator = {
      validate: vi.fn(async () => {
        throw new ProxyEndpointBlockedError(errorMessage);
      }),
    };

    await expect(
      runtime.prepareWorkspace(
        'ws_1',
        async () => ({
          enabled: true,
          proxyUrl: 'http://proxy.example.com:8080',
          proxyUrlMasked: 'mask',
          countryLock: null,
          configVersion: 1,
          updatedAt: new Date(),
        }),
        (ciphertext) => ciphertext,
        { getWorkspaceEgressPolicy: async () => egressPolicy as any },
      ),
    ).rejects.toThrow(ProxyEndpointBlockedError);

    expect(directCount).toBe(0);
    await runtime.closeAll();
    await new Promise((resolve) => targetServer.close(resolve));
  });

  it.each([
    ['PROXY_REQUIRED + dispatcher failure fails closed', 'dispatcher failed'],
    ['PROXY_REQUIRED + attestation failure fails closed and releases handle', 'attestation failed'],
  ] as const)('%s with direct transport count 0', async (_name, failure) => {
    let directCount = 0;
    const release = vi.fn();
    const targetServer = createServer((_req, res) => {
      directCount += 1;
      res.writeHead(200);
      res.end('direct');
    });
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const runtime = new ProxyRuntimeService(
      {
        getAttestation: vi.fn(async () => {
          throw new Error('attestation failed');
        }),
      } as any,
      'test-secret',
    );
    (runtime as any).endpointValidator = {
      validate: vi.fn(async () => ({
        protocol: 'http:',
        hostname: 'proxy.example.com',
        port: 8080,
        normalizedUrl: 'http://proxy.example.com:8080',
        gatewayAddresses: [{ address: '93.184.216.34', family: 4 }],
        validatedAt: Date.now(),
      })),
    };
    (runtime as any).dispatcherPool = {
      acquire: vi.fn(async () => {
        if (failure === 'dispatcher failed') throw new Error('dispatcher failed');
        return { release, acquireRequestLease: vi.fn(), dispatcher: {} };
      }),
      closeAll: vi.fn(),
    };

    await expect(
      runtime.prepareWorkspace(
        'ws_1',
        async () => ({
          enabled: true,
          proxyUrl: 'http://proxy.example.com:8080',
          proxyUrlMasked: 'mask',
          countryLock: null,
          configVersion: 1,
          updatedAt: new Date(),
        }),
        (ciphertext) => ciphertext,
        { getWorkspaceEgressPolicy: async () => 'PROXY_REQUIRED' },
      ),
    ).rejects.toThrow(failure);

    expect(directCount).toBe(0);
    if (failure === 'attestation failed') expect(release).toHaveBeenCalledTimes(1);
    await runtime.closeAll();
    await new Promise((resolve) => targetServer.close(resolve));
  });

  it('DIRECT_ALLOWED + proxy absent/disabled allows direct transport', async () => {
    let directCount = 0;
    const targetServer = createServer((_req, res) => {
      directCount += 1;
      res.writeHead(200);
      res.end('direct');
    });
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const targetPort = (targetServer.address() as any).port;
    const runtime = new ProxyRuntimeService({ getAttestation: vi.fn() } as any, 'test-secret');
    const ctx = await runtime.prepareWorkspace(
      'ws_1',
      async () => null,
      (ciphertext) => ciphertext,
      { getWorkspaceEgressPolicy: async () => 'DIRECT_ALLOWED' },
    );

    expect(ctx.enabled).toBe(false);
    await createDirectFetch()(`http://127.0.0.1:${targetPort}/direct`);
    expect(directCount).toBe(1);

    await runtime.closeAll();
    await new Promise((resolve) => targetServer.close(resolve));
  });

  it('T34 multi-chunk upload reuses one immutable prepared dispatcher without config DB queries per chunk', async () => {
    const acquireRequestLease = vi.fn(() => ({ release: vi.fn() }));
    const handle = { release: vi.fn(), acquireRequestLease, dispatcher: {} };
    const proxyConfigDbQuery = vi.fn(async () => ({
      enabled: true,
      proxyUrl: 'http://proxy-a.example.com:8080',
      proxyUrlMasked: 'mask-a',
      countryLock: 'US',
      configVersion: 1,
      updatedAt: new Date(),
    }));
    const getAttestation = vi.fn(async () => ({
      workspaceId: 'ws_1',
      configVersion: 1,
      proxyFingerprint: 'fp-a',
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ip: '203.0.113.1',
      countryCode: 'US',
      provider: 'test',
    }));
    const runtime = new ProxyRuntimeService(
      {
        getAttestation,
      } as any,
      'test-secret',
    );
    (runtime as any).endpointValidator = {
      validate: vi.fn(async () => ({
        protocol: 'http:',
        hostname: 'proxy-a.example.com',
        port: 8080,
        normalizedUrl: 'http://proxy-a.example.com:8080',
        gatewayAddresses: [{ address: '203.0.113.10', family: 4 }],
        validatedAt: Date.now(),
      })),
    };
    (runtime as any).dispatcherPool = { acquire: vi.fn(async () => handle), closeAll: vi.fn() };

    const ctx = await runtime.prepareWorkspace(
      'ws_1',
      proxyConfigDbQuery,
      (ciphertext) => ciphertext,
    );
    const dbQueriesAfterPrepare = proxyConfigDbQuery.mock.calls.length;
    const chunkCount = 7;
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      ctx.dispatcherHandle?.acquireRequestLease().release();
    }

    expect(ctx.dispatcherHandle).toBe(handle);
    expect(acquireRequestLease).toHaveBeenCalledTimes(chunkCount);
    expect(proxyConfigDbQuery).toHaveBeenCalledTimes(2);
    expect(proxyConfigDbQuery.mock.calls.length).toBe(dbQueriesAfterPrepare);
    expect((runtime as any).endpointValidator.validate).toHaveBeenCalledTimes(1);
    expect((runtime as any).dispatcherPool.acquire).toHaveBeenCalledTimes(1);
    expect(getAttestation).toHaveBeenCalledTimes(1);
    expect((ctx as any).assertCurrentVersion).toBeUndefined();
    expect((ctx as any).assertProxyConfigVersion).toBeUndefined();
    expect((ctx as any).reAttest).toBeUndefined();
    await runtime.closeAll();
  });

  it('T35 prepared route snapshot does not switch after config changes; newer operation gets newer route', async () => {
    const handleA = { release: vi.fn(), acquireRequestLease: vi.fn(), dispatcher: {} };
    const handleB = { release: vi.fn(), acquireRequestLease: vi.fn(), dispatcher: {} };
    let setting = {
      enabled: true,
      proxyUrl: 'http://proxy-a.example.com:8080',
      proxyUrlMasked: 'mask-a',
      countryLock: null,
      configVersion: 1,
      updatedAt: new Date(),
    };
    const runtime = new ProxyRuntimeService(
      {
        getAttestation: vi.fn(async (_workspaceId, config) => ({
          workspaceId: 'ws_1',
          configVersion: config.version,
          proxyFingerprint: config.proxyUrl?.includes('proxy-a') ? 'fp-a' : 'fp-b',
          checkedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          ip: '203.0.113.1',
          countryCode: 'US',
          provider: 'test',
        })),
      } as any,
      'test-secret',
    );
    (runtime as any).endpointValidator = {
      validate: vi.fn(async (url: string) => ({
        protocol: 'http:',
        hostname: new URL(url).hostname,
        port: 8080,
        normalizedUrl: url,
        gatewayAddresses: [
          { address: url.includes('proxy-a') ? '203.0.113.10' : '203.0.113.11', family: 4 },
        ],
        validatedAt: Date.now(),
      })),
    };
    (runtime as any).dispatcherPool = {
      acquire: vi.fn(async (endpoint: ValidatedProxyEndpoint) =>
        endpoint.hostname.includes('proxy-a') ? handleA : handleB,
      ),
      closeAll: vi.fn(),
    };

    const routeA = await runtime.prepareWorkspace(
      'ws_1',
      async () => setting,
      (ciphertext) => ciphertext,
    );
    setting = {
      ...setting,
      proxyUrl: 'http://proxy-b.example.com:8080',
      proxyUrlMasked: 'mask-b',
      configVersion: 2,
    };
    routeA.dispatcherHandle?.acquireRequestLease();
    const routeB = await runtime.prepareWorkspace(
      'ws_1',
      async () => setting,
      (ciphertext) => ciphertext,
    );

    expect(routeA.configVersion).toBe(1);
    expect(routeA.routeFingerprint).toBe('fp-a');
    expect(routeA.dispatcherHandle).toBe(handleA);
    expect(routeB.configVersion).toBe(2);
    expect(routeB.routeFingerprint).toBe('fp-b');
    expect(routeB.dispatcherHandle).toBe(handleB);
    await runtime.closeAll();
  });

  it('T36 successful dispatcher handle lifecycle releases exactly once and returns to baseline', async () => {
    const pool = new ProxyDispatcherPool('test-secret');
    const endpoint: ValidatedProxyEndpoint = {
      protocol: 'http:',
      hostname: 'proxy.example.com',
      port: 8080,
      normalizedUrl: 'http://proxy.example.com:8080',
      gatewayAddresses: [{ address: '203.0.113.10', family: 4 }],
      validatedAt: Date.now(),
    };

    const handle = await pool.acquire(endpoint);
    const entriesAfterAcquire = [...(pool as any).dispatchers.values()];
    expect(entriesAfterAcquire[0].activeHandles).toBe(1);

    const lease = handle.acquireRequestLease();
    expect(entriesAfterAcquire[0].activeRequests).toBe(1);
    lease.release();
    lease.release();
    expect(entriesAfterAcquire[0].activeRequests).toBe(0);

    handle.release();
    handle.release();
    expect(entriesAfterAcquire[0].activeHandles).toBe(0);
    await pool.closeAll();
  });

  it.each([
    ['T37 attestation failure releases acquired route once', 'attestation'],
    ['T37 config-version change releases acquired route once', 'config-change'],
  ] as const)('%s', async (_name, mode) => {
    const release = vi.fn();
    const runtime = new ProxyRuntimeService(
      {
        getAttestation: vi.fn(async () => {
          if (mode === 'attestation') throw new Error('attestation failed');
          return {
            workspaceId: 'ws_1',
            configVersion: 1,
            proxyFingerprint: 'fp',
            checkedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            ip: '203.0.113.1',
            countryCode: 'US',
            provider: 'test',
          };
        }),
      } as any,
      'test-secret',
    );
    (runtime as any).endpointValidator = {
      validate: vi.fn(async () => ({
        protocol: 'http:',
        hostname: 'proxy.example.com',
        port: 8080,
        normalizedUrl: 'http://proxy.example.com:8080',
        gatewayAddresses: [{ address: '203.0.113.10', family: 4 }],
        validatedAt: Date.now(),
      })),
    };
    (runtime as any).dispatcherPool = {
      acquire: vi.fn(async () => ({ release, acquireRequestLease: vi.fn(), dispatcher: {} })),
      closeAll: vi.fn(),
    };
    let configReads = 0;

    await expect(
      runtime.prepareWorkspace(
        'ws_1',
        async () => {
          configReads += 1;
          return {
            enabled: true,
            proxyUrl: 'http://proxy.example.com:8080',
            proxyUrlMasked: 'mask',
            countryLock: null,
            configVersion: mode === 'config-change' && configReads > 1 ? 2 : 1,
            updatedAt: new Date(),
          };
        },
        (ciphertext) => ciphertext,
        { getWorkspaceEgressPolicy: async () => 'PROXY_REQUIRED' },
      ),
    ).rejects.toThrow();

    expect(release).toHaveBeenCalledTimes(1);
    await runtime.closeAll();
  });
});
