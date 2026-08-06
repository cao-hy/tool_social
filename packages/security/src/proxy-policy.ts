import { createHmac, randomUUID } from 'node:crypto';
import type { ProxyConfig } from '@socialhub/shared';

export interface ProxyAttestation {
  workspaceId: string;
  configVersion: number;
  proxyFingerprint: string;
  checkedAt: string;
  expiresAt: string;
  ip: string;
  countryCode: string | null;
  provider: string;
}

export type CachedProxyPolicyResult =
  | {
      kind: 'SUCCESS';
      attestation: ProxyAttestation;
    }
  | {
      kind: 'FAILURE';
      errorCode: string;
      safeMessage: string;
      createdAt: string;
      expiresAt: string;
    };

export interface CheckNetworkResult {
  checkOk: boolean;
  ip: string | null;
  countryCode: string | null;
  provider: string | null;
  checkError: string | null;
  checkedAt: string;
}

export interface ProxyAttestationLock {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  extend(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
}

export interface ProxyPolicyCache {
  get(key: string): Promise<CachedProxyPolicyResult | null>;
  set(key: string, value: CachedProxyPolicyResult, ttlMs: number): Promise<void>;
  getLock(): ProxyAttestationLock;
}

export function computeProxyFingerprint(proxyUrl: string, secret: string): string {
  return createHmac('sha256', secret).update(proxyUrl).digest('hex');
}

export class ProxyPolicyService {
  private readonly fingerprintSecret: string;

  constructor(private readonly cache: ProxyPolicyCache) {
    // eslint-disable-next-line no-restricted-properties
    const secret = process.env.PROXY_FINGERPRINT_SECRET;
    if (!secret) {
      throw new Error('PROXY_FINGERPRINT_SECRET is required');
    }
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length < 32) {
      throw new Error('PROXY_FINGERPRINT_SECRET phải có tối thiểu 32 byte sau khi decode base64.');
    }
    this.fingerprintSecret = secret;
  }

  async getAttestation(
    workspaceId: string,
    config: ProxyConfig,
    configVersion: number,
    checkNetworkFn: () => Promise<CheckNetworkResult>,
  ): Promise<ProxyAttestation> {
    if (!config.enabled || !config.proxyUrl) {
      throw new Error('Proxy is not enabled or proxyUrl is missing');
    }

    const fingerprint = computeProxyFingerprint(config.proxyUrl, this.fingerprintSecret);
    const countryLock = config.countryLock ?? 'none';
    const cacheKey = `proxy-attestation:${workspaceId}:${configVersion}:${fingerprint}:${countryLock}`;

    let cached = await this.cache.get(cacheKey);
    if (cached) {
      if (cached.kind === 'FAILURE') throw new Error(cached.safeMessage);
      return cached.attestation;
    }

    const lockKey = `proxy-attestation-lock:${cacheKey}`;
    const token = randomUUID();
    const lock = this.cache.getLock();
    const locked = await lock.acquire(lockKey, token, 15000);

    if (!locked) {
      let attempts = 0;
      while (attempts < 10) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * Math.pow(1.5, attempts) + Math.random() * 50),
        );
        cached = await this.cache.get(cacheKey);
        if (cached) {
          if (cached.kind === 'FAILURE') throw new Error(cached.safeMessage);
          return cached.attestation;
        }
        attempts++;
      }
      throw new Error('Timeout waiting for proxy attestation');
    }

    try {
      const status = await checkNetworkFn();
      if (!status.checkOk || !status.ip) {
        throw new Error(status.checkError || 'Network check failed');
      }

      if (config.countryLock && status.countryCode !== config.countryLock) {
        throw new Error(
          `Proxy IP is in ${status.countryCode}, but country lock requires ${config.countryLock}`,
        );
      }

      const attestation: ProxyAttestation = {
        workspaceId,
        configVersion,
        proxyFingerprint: fingerprint,
        checkedAt: status.checkedAt,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        ip: status.ip,
        countryCode: status.countryCode ?? null,
        provider: status.provider ?? 'unknown',
      };

      await this.cache.set(cacheKey, { kind: 'SUCCESS', attestation }, 5 * 60 * 1000);
      return attestation;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Unknown proxy error';
      await this.cache.set(
        cacheKey,
        {
          kind: 'FAILURE',
          errorCode: 'CHECK_FAILED',
          safeMessage: errMessage,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15000).toISOString(),
        },
        15000,
      );
      throw error;
    } finally {
      await lock.release(lockKey, token);
    }
  }
}
