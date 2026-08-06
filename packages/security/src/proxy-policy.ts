import { createHmac } from 'node:crypto';
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

export interface ProxyPolicyCache {
  get(key: string): Promise<ProxyAttestation | null>;
  set(key: string, value: ProxyAttestation, ttlMs: number): Promise<void>;
  /** Must return true if lock was acquired, false if already locked */
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
}

export function computeProxyFingerprint(proxyUrl: string): string {
  // Using HMAC to avoid storing raw URL with credentials
  // Ensure same proxyUrl always generates same fingerprint.
  return createHmac('sha256', 'proxy-fingerprint-salt').update(proxyUrl).digest('hex');
}

export class ProxyPolicyService {
  constructor(private readonly cache: ProxyPolicyCache) {}

  async getAttestation(
    workspaceId: string,
    config: ProxyConfig,
    configVersion: number,
    checkNetworkFn: () => Promise<unknown>,
  ): Promise<ProxyAttestation> {
    if (!config.enabled || !config.proxyUrl) {
      throw new Error('Proxy is not enabled or proxyUrl is missing');
    }

    const fingerprint = computeProxyFingerprint(config.proxyUrl);
    const countryLock = config.countryLock ?? 'none';
    const cacheKey = `proxy-attestation:${workspaceId}:${configVersion}:${fingerprint}:${countryLock}`;

    // Anti Cache Stampede with single-flight lock
    let attestation = await this.cache.get(cacheKey);
    if (attestation) {
      return attestation;
    }

    const lockKey = `proxy-attestation-lock:${cacheKey}`;
    const locked = await this.cache.acquireLock(lockKey, 15000); // 15s lock

    if (!locked) {
      // Wait briefly and try reading cache again
      await new Promise((resolve) => setTimeout(resolve, 500));
      attestation = await this.cache.get(cacheKey);
      if (attestation) {
        return attestation;
      }
      // If still missing, another request might be taking too long or failed
      // Fall through to check network itself (or we could wait longer, but simple fallback is fine)
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

      const newAttestation: ProxyAttestation = {
        workspaceId,
        configVersion,
        proxyFingerprint: fingerprint,
        checkedAt: status.checkedAt,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min ttl
        ip: status.ip,
        countryCode: status.countryCode,
        provider: status.provider ?? 'unknown',
      };

      await this.cache.set(cacheKey, newAttestation, 5 * 60 * 1000);
      return newAttestation;
    } catch (error) {
      // Short cache for errors to avoid hammering the provider
      // 15 seconds
      const errAttestation: ProxyAttestation = {
        workspaceId,
        configVersion,
        proxyFingerprint: fingerprint,
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15000).toISOString(),
        ip: '',
        countryCode: null,
        provider: 'error',
      };
      await this.cache.set(cacheKey, errAttestation, 15000);
      throw error;
    }
  }
}
