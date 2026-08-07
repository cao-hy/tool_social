import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyDispatcherPool, UnsupportedProxyProtocolError } from '../proxy-dispatcher-pool';
import type { ValidatedProxyEndpoint } from '@socialhub/security';
import { Dispatcher } from 'undici';

describe('ProxyDispatcherPool', () => {
  let pool: ProxyDispatcherPool;
  const FINGERPRINT_SECRET = 'test-fingerprint-secret-that-is-at-least-32-bytes-long';

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new ProxyDispatcherPool(FINGERPRINT_SECRET);
  });

  afterEach(() => {
    pool.closeAll();
    vi.restoreAllMocks();
  });

  const mockHttpEndpoint: ValidatedProxyEndpoint = {
    protocol: 'http:',
    hostname: 'proxy.example.com',
    port: 8080,
    normalizedUrl: 'http://proxy.example.com:8080',
    gatewayAddresses: [{ address: '192.168.1.1', family: 4 }],
    validatedAt: Date.now(),
  };

  const mockSocksEndpoint: ValidatedProxyEndpoint = {
    ...mockHttpEndpoint,
    protocol: 'socks5:',
    normalizedUrl: 'socks5://proxy.example.com:1080',
  };

  it('từ chối SOCKS5 outright', async () => {
    await expect(pool.acquire(mockSocksEndpoint)).rejects.toThrow(UnsupportedProxyProtocolError);
  });

  it('cấp phát dispatcher handle và quản lý activeRequests lease (idempotent release)', async () => {
    const handle = await pool.acquire(mockHttpEndpoint);
    expect(handle).toBeDefined();
    expect(handle.dispatcher).toBeInstanceOf(Dispatcher);

    const lease1 = handle.acquireRequestLease();
    const lease2 = handle.acquireRequestLease();

    expect(typeof lease1.release).toBe('function');

    // Release nhiều lần không throw
    lease1.release();
    lease1.release();
    lease1.release();

    lease2.release();
  });

  it('idle eviction dọn dẹp các dispatcher không còn activeRequests', async () => {
    const handle = await pool.acquire(mockHttpEndpoint);
    const lease = handle.acquireRequestLease();

    // Giả lập dispatcher.close
    const closeSpy = vi.spyOn(handle.dispatcher, 'close').mockResolvedValue(undefined);

    // Qua 1 phút nhưng vẫn còn activeRequests -> không evict
    vi.advanceTimersByTime(61000);
    expect(closeSpy).not.toHaveBeenCalled();

    // Release lease
    lease.release();

    // Đợi thêm 1 khoảng idle timeout nữa
    vi.advanceTimersByTime(95000);

    // Dispatcher.close phải được gọi
    expect(closeSpy).toHaveBeenCalled();
  });
});
