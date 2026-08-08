import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Khóa phân tán quanh tài nguyên bị mutate — lớp phòng thủ thứ HAI chống double
 * post (rủi ro R9).
 */

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface JobLock {
  key: string;
  token: string;
}

export interface OwnedJobLock extends JobLock {
  isOwned(): boolean;
  assertOwned(): void;
}

export class JobLockService {
  constructor(private readonly redis: Redis) {}

  /** Trả về `null` khi tài nguyên đang bị khóa bởi tiến trình khác. */
  async acquire(resource: string, ttlMs: number): Promise<JobLock | null> {
    const key = `lock:${resource}`;
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token } : null;
  }

  /**
   * Giải phóng khóa bằng script Lua để so-sánh-và-xóa là thao tác nguyên tử.
   */
  async release(lock: JobLock): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
    return result === 1;
  }

  /** Gia hạn khóa nguyên tử bằng Lua script (so sánh token + PEXPIRE). */
  async extend(lock: JobLock, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(EXTEND_SCRIPT, 1, lock.key, lock.token, ttlMs);
    return result === 1;
  }

  /** Chạy `fn` khi giành được khóa; tự động heartbeat gia hạn lock mỗi 30s; trả `null` nếu tài nguyên đang bận. */
  async withLock<T>(
    resource: string,
    ttlMs: number,
    fn: (lock: OwnedJobLock) => Promise<T>,
  ): Promise<T | null> {
    const lock = await this.acquire(resource, ttlMs);
    if (!lock) return null;

    let lockOwned = true;
    const heartbeatTimer = setInterval(async () => {
      try {
        const extended = await this.extend(lock, ttlMs);
        if (!extended) lockOwned = false;
      } catch {
        lockOwned = false;
      }
    }, 30000);

    const ownedLock: OwnedJobLock = {
      ...lock,
      isOwned: () => lockOwned,
      assertOwned: () => {
        if (!lockOwned) throw new Error(`Lost lock ownership for resource ${resource}`);
      },
    };

    try {
      return await fn(ownedLock);
    } finally {
      clearInterval(heartbeatTimer);
      await this.release(lock).catch(() => {});
    }
  }
}
