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

export class ProxyAttestationLockLostError extends Error {
  readonly code = 'PROXY_ATTESTATION_LOCK_LOST';
  constructor() {
    super('Lost attestation lock ownership during check execution');
    this.name = 'ProxyAttestationLockLostError';
  }
}

export function computeProxyRouteFingerprint(
  proxyUrl: string,
  gatewayAddresses: { address: string; family: number }[],
  secret: string,
): string {
  const gateways = [...gatewayAddresses]
    .map((x) => `${x.family}:${x.address}`)
    .sort()
    .filter((x, i, arr) => i === 0 || x !== arr[i - 1]);

  const input = ['proxy-route-v1', proxyUrl, ...gateways].join('\0');
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function computeProxyFingerprint(proxyUrl: string, secret: string): string {
  return createHmac('sha256', secret).update(proxyUrl).digest('hex');
}

export class ProxyPolicyService {
  constructor(
    private readonly cache: ProxyPolicyCache,
    private readonly fingerprintSecret: string,
  ) {}

  async getAttestation(
    workspaceId: string,
    config: ProxyConfig,
    configVersion: number,
    checkNetworkFn: () => Promise<CheckNetworkResult>,
    forceAttestation = false,
  ): Promise<ProxyAttestation> {
    if (!config.enabled || !config.proxyUrl) {
      throw new Error('Proxy is not enabled or proxyUrl is missing');
    }

    const fingerprint = computeProxyFingerprint(config.proxyUrl, this.fingerprintSecret);
    const countryLock = config.countryLock ?? 'none';
    const cacheKey = `proxy-attestation:${workspaceId}:${configVersion}:${fingerprint}:${countryLock}`;

    if (!forceAttestation) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        if (cached.kind === 'FAILURE') throw new Error(cached.safeMessage);
        return cached.attestation;
      }
    }

    const lockKey = `proxy-attestation-lock:${cacheKey}`;
    const token = randomUUID();
    const lock = this.cache.getLock();
    const LOCK_TTL = 30000;
    const HEARTBEAT_MS = 10000;
    const SUCCESS_TTL = 120000;
    const FAILURE_TTL = 10000;

    const locked = await lock.acquire(lockKey, token, LOCK_TTL);

    if (!locked) {
      let attempts = 0;
      while (attempts < 15) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * Math.pow(1.3, attempts) + Math.random() * 50),
        );
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          if (cached.kind === 'FAILURE') throw new Error(cached.safeMessage);
          return cached.attestation;
        }
        attempts++;
      }
      throw new Error('Timeout waiting for proxy attestation lock');
    }

    let lockOwned = true;
    const heartbeatTimer = setInterval(async () => {
      try {
        const extended = await lock.extend(lockKey, token, LOCK_TTL);
        if (!extended) lockOwned = false;
      } catch {
        lockOwned = false;
      }
    }, HEARTBEAT_MS);

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

      if (!lockOwned) {
        throw new ProxyAttestationLockLostError();
      }

      const attestation: ProxyAttestation = {
        workspaceId,
        configVersion,
        proxyFingerprint: fingerprint,
        checkedAt: status.checkedAt,
        expiresAt: new Date(Date.now() + SUCCESS_TTL).toISOString(),
        ip: status.ip,
        countryCode: status.countryCode ?? null,
        provider: status.provider ?? 'unknown',
      };

      await this.cache.set(cacheKey, { kind: 'SUCCESS', attestation }, SUCCESS_TTL);
      return attestation;
    } catch (error) {
      if (lockOwned) {
        const errMessage = error instanceof Error ? error.message : 'Unknown proxy error';
        await this.cache.set(
          cacheKey,
          {
            kind: 'FAILURE',
            errorCode: 'CHECK_FAILED',
            safeMessage: errMessage,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + FAILURE_TTL).toISOString(),
          },
          FAILURE_TTL,
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      await lock.release(lockKey, token).catch(() => {});
    }
  }
}
