import type {
  ProxyPolicyCache,
  CachedProxyPolicyResult,
  ProxyAttestationLock,
} from './proxy-policy';

export interface MinimalRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', duration: number): Promise<'OK' | null>;
  set(key: string, value: string, mode: 'PX', duration: number, flag: 'NX'): Promise<'OK' | null>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}

export class RedisProxyAttestationLock implements ProxyAttestationLock {
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get",KEYS[1]) == ARGV[1] then
        return redis.call("del",KEYS[1])
    else
        return 0
    end
  `;

  private static readonly EXTEND_SCRIPT = `
    if redis.call("get",KEYS[1]) == ARGV[1] then
        return redis.call("pexpire",KEYS[1],ARGV[2])
    else
        return 0
    end
  `;

  constructor(private readonly redis: MinimalRedisClient) {}

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async extend(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(
      RedisProxyAttestationLock.EXTEND_SCRIPT,
      1,
      key,
      token,
      ttlMs.toString(),
    );
    return result === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    const result = await this.redis.eval(RedisProxyAttestationLock.RELEASE_SCRIPT, 1, key, token);
    return result === 1;
  }
}

export class RedisProxyPolicyCache implements ProxyPolicyCache {
  private readonly lock: ProxyAttestationLock;

  constructor(private readonly redis: MinimalRedisClient) {
    this.lock = new RedisProxyAttestationLock(redis);
  }

  async get(key: string): Promise<CachedProxyPolicyResult | null> {
    const data = await this.redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as CachedProxyPolicyResult;
    } catch {
      return null;
    }
  }

  async set(key: string, value: CachedProxyPolicyResult, ttlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  async setIfLockOwned(
    key: string,
    lockKey: string,
    token: string,
    value: CachedProxyPolicyResult,
    ttlMs: number,
  ): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("set", KEYS[2], ARGV[2], "PX", ARGV[3])
        return 1
      else
        return 0
      end
    `;
    const result = await this.redis.eval(
      script,
      2,
      lockKey,
      key,
      token,
      JSON.stringify(value),
      ttlMs.toString(),
    );
    return result === 1;
  }

  getLock(): ProxyAttestationLock {
    return this.lock;
  }
}
