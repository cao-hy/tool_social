import { describe, expect, it } from 'vitest';
import {
  capabilityUnsupported,
  createPlatformError,
  fromHttpStatus,
  isPlatformError,
  isRetryableKind,
  PlatformError,
  type PlatformErrorKind,
} from '../core/platform-error';
import { normalizeFacebookError } from '../facebook/facebook.errors';

describe('phân loại retryable — quyết định quan trọng nhất của worker', () => {
  const nonRetryable: PlatformErrorKind[] = [
    'AUTH_INVALID',
    'PERMISSION_DENIED',
    'VALIDATION',
    'NOT_FOUND',
    'CAPABILITY_UNSUPPORTED',
  ];

  const retryable: PlatformErrorKind[] = [
    'AUTH_EXPIRED',
    'RATE_LIMITED',
    'PLATFORM_ERROR',
    'NETWORK',
    'UNKNOWN',
  ];

  it.each(nonRetryable)('%s KHÔNG retry — thử lại chỉ tốn quota', (kind) => {
    expect(isRetryableKind(kind)).toBe(false);
  });

  it.each(retryable)('%s CÓ retry', (kind) => {
    expect(isRetryableKind(kind)).toBe(true);
  });

  it('lỗi "nội dung vi phạm" không bao giờ được retry 5 lần', () => {
    const error = createPlatformError('VALIDATION', 'FACEBOOK', 'Nội dung vi phạm chính sách');
    expect(error.retryable).toBe(false);
  });

  it('token hết hạn thì retry được (sau khi refresh), token bị thu hồi thì không', () => {
    expect(createPlatformError('AUTH_EXPIRED', 'YOUTUBE', 'expired').retryable).toBe(true);
    expect(createPlatformError('AUTH_INVALID', 'YOUTUBE', 'revoked').retryable).toBe(false);
  });

  it('cho phép ghi đè retryable một cách tường minh khi adapter biết rõ hơn', () => {
    const error = createPlatformError('VALIDATION', 'TIKTOK', 'lỗi tạm thời', {
      retryable: true,
    });
    expect(error.retryable).toBe(true);
  });
});

describe('fromHttpStatus', () => {
  it.each([
    [401, 'AUTH_EXPIRED', true],
    [403, 'PERMISSION_DENIED', false],
    [404, 'NOT_FOUND', false],
    [429, 'RATE_LIMITED', true],
    [400, 'VALIDATION', false],
    [500, 'PLATFORM_ERROR', true],
    [503, 'PLATFORM_ERROR', true],
  ])('HTTP %i → %s (retryable=%s)', (status, kind, retryable) => {
    const error = fromHttpStatus('INSTAGRAM', status, 'lỗi');
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
    expect(error.httpStatus).toBe(status);
  });
});

describe('capabilityUnsupported', () => {
  it('luôn là lỗi fatal — nền tảng sẽ không đột nhiên hỗ trợ ở lần thử sau', () => {
    const error = capabilityUnsupported('PINTEREST', 'replyToComment');
    expect(error.kind).toBe('CAPABILITY_UNSUPPORTED');
    expect(error.retryable).toBe(false);
  });

  it('thông báo nêu rõ nền tảng và chức năng', () => {
    const error = capabilityUnsupported('PINTEREST', 'deleteComment');
    expect(error.message).toContain('PINTEREST');
    expect(error.message).toContain('deleteComment');
  });
});

describe('PlatformError', () => {
  it('toLogObject không kéo theo dữ liệu thô lớn', () => {
    const error = createPlatformError('PLATFORM_ERROR', 'FACEBOOK', 'lỗi server', {
      raw: { huge: 'x'.repeat(10_000) },
      platformCode: 'OAuthException',
      httpStatus: 500,
    });

    const logged = error.toLogObject();
    expect(logged).not.toHaveProperty('raw');
    expect(logged.platformCode).toBe('OAuthException');
    expect(JSON.stringify(logged).length).toBeLessThan(500);
  });

  it('giữ retryAfterMs để worker chờ đúng thời gian nền tảng yêu cầu', () => {
    const error = createPlatformError('RATE_LIMITED', 'TIKTOK', 'quota', {
      retryAfterMs: 60_000,
    });
    expect(error.retryAfterMs).toBe(60_000);
  });

  it('isPlatformError phân biệt được với Error thường', () => {
    expect(isPlatformError(createPlatformError('NETWORK', 'YOUTUBE', 'timeout'))).toBe(true);
    expect(isPlatformError(new Error('lỗi thường'))).toBe(false);
    expect(isPlatformError(null)).toBe(false);
    expect(isPlatformError('chuỗi')).toBe(false);
  });

  it('là instance của Error nên bắt được bằng catch thông thường', () => {
    expect(createPlatformError('NETWORK', 'YOUTUBE', 'timeout')).toBeInstanceOf(Error);
    expect(createPlatformError('NETWORK', 'YOUTUBE', 'timeout')).toBeInstanceOf(PlatformError);
  });
});

describe('normalizeFacebookError', () => {
  it('map Unsupported delete request thành NOT_FOUND để delete idempotent', () => {
    const error = normalizeFacebookError({
      status: 400,
      payload: {
        error: {
          message:
            'Unsupported delete request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation.',
          code: 100,
        },
      },
    });

    expect(error.kind).toBe('NOT_FOUND');
    expect(error.retryable).toBe(false);
  });

  it('không map mọi Facebook code 100 thành NOT_FOUND', () => {
    const error = normalizeFacebookError({
      status: 400,
      payload: {
        error: {
          message: 'Invalid parameter',
          code: 100,
        },
      },
    });

    expect(error.kind).toBe('VALIDATION');
  });
});
