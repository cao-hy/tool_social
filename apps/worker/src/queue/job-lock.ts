import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Khóa phân tán quanh tài nguyên bị mutate — lớp phòng thủ thứ HAI chống double
 * post (rủi ro R9).
 *
 * Vì sao cần lớp thứ hai khi đã có jobId idempotent?
 * jobId chặn được việc *thêm* job trùng vào hàng đợi. Nhưng một job đã rời hàng
 * đợi và đang chạy thì không còn được jobId bảo vệ: nếu worker A bị coi là
 * "stalled" (mạng chậm, GC lâu) trong khi vẫn đang gọi API publish, BullMQ sẽ
 * giao job đó cho worker B. Lúc đó hai worker cùng publish một bài.
 *
 * Lớp thứ ba là kiểm tra `externalPostId` trong DB trước khi gọi API — có giá
 * trị nghĩa là đã đăng rồi.
 */

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface JobLock {
  key: string;
  token: string;
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
   *
   * Kiểm tra token là bắt buộc: nếu khóa đã hết hạn và được tiến trình khác
   * giành lấy, việc xóa mù quáng sẽ mở khóa cho tiến trình đó giữa chừng.
   */
  async release(lock: JobLock): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
    return result === 1;
  }

  /** Gia hạn khóa cho job chạy lâu (upload video). */
  async extend(lock: JobLock, ttlMs: number): Promise<boolean> {
    const current = await this.redis.get(lock.key);
    if (current !== lock.token) return false;
    const result = await this.redis.pexpire(lock.key, ttlMs);
    return result === 1;
  }

  /** Chạy `fn` khi giành được khóa; trả `null` nếu tài nguyên đang bận. */
  async withLock<T>(resource: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
    const lock = await this.acquire(resource, ttlMs);
    if (!lock) return null;
    try {
      return await fn();
    } finally {
      await this.release(lock);
    }
  }
}
