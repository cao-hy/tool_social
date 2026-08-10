import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProxyPolicyService,
  type CachedProxyPolicyResult,
  type ProxyAttestationLock,
  type ProxyPolicyCache,
} from '../proxy-policy';
import type { ValidatedGatewayAddress } from '../proxy-endpoint-validator';

const proxyConfig = {
  enabled: true,
  proxyUrl: 'http://proxy.example:8080',
  proxyUrlMasked: 'http://proxy.example:8080',
  countryLock: null,
  source: 'WORKSPACE',
} as const;

const gateways: ValidatedGatewayAddress[] = [{ address: '203.0.113.10', family: 4 }];

function staleSuccess(): CachedProxyPolicyResult {
  return {
    kind: 'SUCCESS',
    attestation: {
      workspaceId: 'workspace_1',
      configVersion: 1,
      proxyFingerprint: 'stale',
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ip: '1.1.1.1',
      countryCode: 'US',
      provider: 'cached',
    },
  };
}

describe('ProxyPolicyService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('force attestation không trả stale cache khi lock đang bận', async () => {
    vi.useFakeTimers();

    const lock: ProxyAttestationLock = {
      acquire: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      extend: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    };
    const cache: ProxyPolicyCache = {
      get: vi.fn().mockResolvedValue(staleSuccess()),
      set: vi.fn().mockResolvedValue(undefined),
      getLock: () => lock,
    };
    const service = new ProxyPolicyService(cache, 'c29tZS0zMi1ieXRlLWtleS1mb3ItdGVzdGluZy1vbmx5');
    const checkNetworkFn = vi.fn().mockResolvedValue({
      checkOk: true,
      ip: '2.2.2.2',
      countryCode: 'US',
      provider: 'fresh',
      checkError: null,
      checkedAt: new Date().toISOString(),
    });

    const resultPromise = service.getAttestation(
      'workspace_1',
      proxyConfig,
      1,
      gateways,
      checkNetworkFn,
      true,
    );
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    expect(result.ip).toBe('2.2.2.2');
    expect(checkNetworkFn).toHaveBeenCalledTimes(1);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('T33 five simultaneous callers for the same route share one fresh attestation', async () => {
    let cached: CachedProxyPolicyResult | null = null;
    let locked = false;
    const lock: ProxyAttestationLock = {
      acquire: vi.fn(async () => {
        if (locked) return false;
        locked = true;
        return true;
      }),
      extend: vi.fn(async () => locked),
      release: vi.fn(async () => {
        locked = false;
        return true;
      }),
    };
    const cache: ProxyPolicyCache = {
      get: vi.fn(async () => cached),
      set: vi.fn(async (_key, value) => {
        cached = value;
      }),
      getLock: () => lock,
    };
    const service = new ProxyPolicyService(cache, 'c29tZS0zMi1ieXRlLWtleS1mb3ItdGVzdGluZy1vbmx5');
    const checkNetworkFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        checkOk: true,
        ip: '2.2.2.2',
        countryCode: 'US',
        provider: 'fresh',
        checkError: null,
        checkedAt: new Date().toISOString(),
      };
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.getAttestation('workspace_1', proxyConfig, 1, gateways, checkNetworkFn),
      ),
    );

    expect(checkNetworkFn).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.ip)).toEqual([
      '2.2.2.2',
      '2.2.2.2',
      '2.2.2.2',
      '2.2.2.2',
      '2.2.2.2',
    ]);
  });
});
