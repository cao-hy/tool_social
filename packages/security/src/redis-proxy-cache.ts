import type { ProxyPolicyCache, ProxyAttestation } from './proxy-policy';

export interface MinimalRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', duration: number): Promise<'OK' | null>;
  set(key: string, value: string, mode: 'PX', duration: number, flag: 'NX'): Promise<'OK' | null>;
}

export class RedisProxyPolicyCache implements ProxyPolicyCache {
  constructor(private readonly redis: MinimalRedisClient) {}

  async get(key: string): Promise<ProxyAttestation | null> {
    const data = await this.redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as ProxyAttestation;
    } catch {
      return null;
    }
  }

  async set(key: string, value: ProxyAttestation, ttlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }
}
