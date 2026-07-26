import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { JobLockService } from '../queue/job-lock';
import { buildJobOptions, buildWorkerOptions } from '../queue/queue-options';

/**
 * Redis giả tối giản, chỉ hiện thực đúng ngữ nghĩa mà JobLockService dựa vào:
 * SET NX (chỉ đặt khi chưa tồn tại) và so-sánh-rồi-xóa nguyên tử.
 *
 * Đây là test đơn vị cho LOGIC KHÓA, không phải test tích hợp Redis. Test với
 * Redis thật nằm ở Phase 5 khi có processor thực sự dùng khóa này.
 */
function createFakeRedis(): Redis {
  const store = new Map<string, string>();

  return {
    set: vi.fn(async (key: string, value: string, _px: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
    pexpire: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  } as unknown as Redis;
}

describe('JobLockService — lớp phòng thủ thứ hai chống double post (R9)', () => {
  it('giành được khóa khi tài nguyên đang rảnh', async () => {
    const service = new JobLockService(createFakeRedis());
    const lock = await service.acquire('platform-post:pp_1', 60_000);

    expect(lock).not.toBeNull();
    expect(lock?.key).toBe('lock:platform-post:pp_1');
    expect(lock?.token).toBeTruthy();
  });

  it('WORKER THỨ HAI KHÔNG giành được khóa của cùng một bài đăng', async () => {
    const redis = createFakeRedis();
    const workerA = new JobLockService(redis);
    const workerB = new JobLockService(redis);

    const lockA = await workerA.acquire('platform-post:pp_1', 60_000);
    const lockB = await workerB.acquire('platform-post:pp_1', 60_000);

    expect(lockA).not.toBeNull();
    expect(lockB).toBeNull();
  });

  it('bài đăng khác nhau khóa độc lập — không chặn nhầm nhau', async () => {
    const redis = createFakeRedis();
    const service = new JobLockService(redis);

    expect(await service.acquire('platform-post:pp_1', 60_000)).not.toBeNull();
    expect(await service.acquire('platform-post:pp_2', 60_000)).not.toBeNull();
  });

  it('giải phóng khóa rồi thì worker khác vào được', async () => {
    const redis = createFakeRedis();
    const service = new JobLockService(redis);

    const lock = await service.acquire('platform-post:pp_1', 60_000);
    expect(await service.release(lock!)).toBe(true);
    expect(await service.acquire('platform-post:pp_1', 60_000)).not.toBeNull();
  });

  it('KHÔNG giải phóng được khóa của tiến trình khác', async () => {
    const redis = createFakeRedis();
    const service = new JobLockService(redis);

    await service.acquire('platform-post:pp_1', 60_000);
    const forged = { key: 'lock:platform-post:pp_1', token: 'token-gia-mao' };

    expect(await service.release(forged)).toBe(false);
  });

  it('withLock tự giải phóng khóa kể cả khi hàm bên trong ném lỗi', async () => {
    const redis = createFakeRedis();
    const service = new JobLockService(redis);

    await expect(
      service.withLock('platform-post:pp_1', 60_000, async () => {
        throw new Error('publish thất bại');
      }),
    ).rejects.toThrow('publish thất bại');

    // Khóa đã được trả lại — nếu không, bài đăng này sẽ kẹt vĩnh viễn.
    expect(await service.acquire('platform-post:pp_1', 60_000)).not.toBeNull();
  });

  it('withLock trả null khi tài nguyên đang bận, KHÔNG chạy hàm bên trong', async () => {
    const redis = createFakeRedis();
    const service = new JobLockService(redis);
    const fn = vi.fn();

    await service.acquire('platform-post:pp_1', 60_000);
    const result = await service.withLock('platform-post:pp_1', 60_000, fn);

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('cấu hình queue', () => {
  it('publish-post: 5 lần thử với exponential backoff', () => {
    const options = buildJobOptions('publish-post', 'publish-post:pp_1');
    expect(options.attempts).toBe(5);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 5000 });
    expect(options.jobId).toBe('publish-post:pp_1');
  });

  it('retry-failed-post KHÔNG tự backoff — người dùng chủ động bấm retry', () => {
    const options = buildJobOptions('retry-failed-post', 'retry-failed-post:pp_1');
    expect(options.attempts).toBe(1);
    expect(options.backoff).toBeUndefined();
  });

  it('job luôn được dọn khỏi Redis — nếu không Redis sẽ đầy trong vài ngày', () => {
    const options = buildJobOptions('sync-post-metrics', 'x');
    expect(options.removeOnComplete).toBeTruthy();
    expect(options.removeOnFail).toBeTruthy();
  });

  it('concurrency scale được theo biến môi trường', () => {
    expect(buildWorkerOptions('publish-post', 1).concurrency).toBe(5);
    expect(buildWorkerOptions('publish-post', 2).concurrency).toBe(10);
    // Không bao giờ xuống 0 — worker với concurrency 0 sẽ im lặng không làm gì.
    expect(buildWorkerOptions('cleanup-unused-media', 0.1).concurrency).toBe(1);
  });
});
