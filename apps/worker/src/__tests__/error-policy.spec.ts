import { createPlatformError } from '@socialhub/platform-adapters';
import { describe, expect, it } from 'vitest';
import { decideOnError } from '../queue/error-policy';

describe('decideOnError — chính sách retry của worker', () => {
  describe('lỗi KHÔNG retry được', () => {
    it('nội dung vi phạm → thất bại NGAY, không thử lại 5 lần', () => {
      const error = createPlatformError('VALIDATION', 'FACEBOOK', 'Nội dung vi phạm chính sách');
      const decision = decideOnError(error, 1, 5);

      expect(decision.action).toBe('FAIL_PERMANENTLY');
      expect(decision.notifyUser).toBe(true);
    });

    it('thiếu scope → thất bại ngay (thử lại không tự sinh ra quyền)', () => {
      const decision = decideOnError(
        createPlatformError('PERMISSION_DENIED', 'YOUTUBE', 'Thiếu scope'),
        1,
        5,
      );
      expect(decision.action).toBe('FAIL_PERMANENTLY');
    });

    it('nền tảng không hỗ trợ → thất bại ngay', () => {
      const decision = decideOnError(
        createPlatformError('CAPABILITY_UNSUPPORTED', 'PINTEREST', 'Không hỗ trợ'),
        1,
        5,
      );
      expect(decision.action).toBe('FAIL_PERMANENTLY');
    });

    it('token bị THU HỒI → đánh dấu tài khoản mất kết nối để DỪNG mọi job liên quan', () => {
      const decision = decideOnError(
        createPlatformError('AUTH_INVALID', 'INSTAGRAM', 'Token đã bị thu hồi'),
        1,
        5,
      );
      expect(decision.action).toBe('FAIL_PERMANENTLY');
      expect(decision.markAccountDisconnected).toBe(true);
      expect(decision.notifyUser).toBe(true);
    });
  });

  describe('lỗi retry được', () => {
    it('lỗi 5xx của nền tảng → retry', () => {
      const decision = decideOnError(
        createPlatformError('PLATFORM_ERROR', 'TIKTOK', 'Internal server error'),
        1,
        5,
      );
      expect(decision.action).toBe('RETRY');
    });

    it('lỗi mạng → retry', () => {
      expect(
        decideOnError(createPlatformError('NETWORK', 'FACEBOOK', 'timeout'), 1, 5).action,
      ).toBe('RETRY');
    });

    it('token HẾT HẠN → retry (khác hẳn token bị thu hồi)', () => {
      const decision = decideOnError(
        createPlatformError('AUTH_EXPIRED', 'YOUTUBE', 'Token hết hạn'),
        1,
        5,
      );
      expect(decision.action).toBe('RETRY');
      expect(decision.markAccountDisconnected).toBe(false);
    });

    it('rate limit → retry và tôn trọng thời gian nền tảng yêu cầu', () => {
      const decision = decideOnError(
        createPlatformError('RATE_LIMITED', 'FACEBOOK', 'Vượt quota', { retryAfterMs: 120_000 }),
        1,
        5,
      );
      expect(decision.action).toBe('RETRY');
      expect(decision.retryAfterMs).toBe(120_000);
    });

    it('hết số lần thử → thất bại vĩnh viễn và báo người dùng', () => {
      const decision = decideOnError(
        createPlatformError('PLATFORM_ERROR', 'TIKTOK', 'lỗi server'),
        5,
        5,
      );
      expect(decision.action).toBe('FAIL_PERMANENTLY');
      expect(decision.notifyUser).toBe(true);
      expect(decision.reason).toContain('5');
    });

    it('rate limit lặp lại nhiều lần → cảnh báo sớm cho admin', () => {
      const error = createPlatformError('RATE_LIMITED', 'FACEBOOK', 'quota');
      expect(decideOnError(error, 1, 5).notifyUser).toBe(false);
      expect(decideOnError(error, 3, 5).notifyUser).toBe(true);
    });
  });

  describe('lỗi không phải từ nền tảng', () => {
    it('lỗi lập trình → retry có giới hạn', () => {
      const decision = decideOnError(new TypeError('undefined is not a function'), 1, 3);
      expect(decision.action).toBe('RETRY');
    });

    it('lỗi lập trình khi đã hết lần thử → thất bại vĩnh viễn', () => {
      const decision = decideOnError(new TypeError('lỗi'), 3, 3);
      expect(decision.action).toBe('FAIL_PERMANENTLY');
      expect(decision.notifyUser).toBe(true);
    });

    it('không bao giờ đánh dấu mất kết nối vì lỗi nội bộ của chính ta', () => {
      expect(decideOnError(new Error('lỗi'), 3, 3).markAccountDisconnected).toBe(false);
    });
  });
});
