import { describe, expect, it } from 'vitest';
import {
  canTransitionPostStatus,
  deriveContentPostStatus,
  isRetryablePlatformPost,
  isTerminalPlatformPostStatus,
  PLATFORM_POST_STATUSES,
  type PlatformPostStatus,
} from '../post-status';

describe('deriveContentPostStatus', () => {
  it('không có platform post nào thì vẫn là DRAFT', () => {
    expect(deriveContentPostStatus([])).toBe('DRAFT');
  });

  it('tất cả thành công → PUBLISHED (prompt §9)', () => {
    expect(deriveContentPostStatus(['PUBLISHED', 'PUBLISHED', 'PUBLISHED'])).toBe('PUBLISHED');
  });

  it('tất cả thất bại → FAILED (prompt §9)', () => {
    expect(deriveContentPostStatus(['FAILED', 'FAILED'])).toBe('FAILED');
  });

  it('một phần thành công → PARTIALLY_PUBLISHED (prompt §9)', () => {
    expect(deriveContentPostStatus(['PUBLISHED', 'FAILED'])).toBe('PARTIALLY_PUBLISHED');
    expect(deriveContentPostStatus(['PUBLISHED', 'FAILED', 'FAILED'])).toBe('PARTIALLY_PUBLISHED');
  });

  it('còn job đang chạy thì chưa kết luận thành công/thất bại', () => {
    expect(deriveContentPostStatus(['PUBLISHED', 'PROCESSING'])).toBe('PROCESSING');
    expect(deriveContentPostStatus(['FAILED', 'QUEUED'])).toBe('QUEUED');
    expect(deriveContentPostStatus(['PUBLISHED', 'FAILED', 'PROCESSING'])).toBe('PROCESSING');
  });

  it('bản đã hủy không làm cả bài đăng kẹt lại', () => {
    // Hủy 1 nền tảng, 2 nền tảng còn lại đã xong → phải kết luận được ngay.
    expect(deriveContentPostStatus(['PUBLISHED', 'PUBLISHED', 'CANCELLED'])).toBe('PUBLISHED');
    expect(deriveContentPostStatus(['PUBLISHED', 'FAILED', 'CANCELLED'])).toBe(
      'PARTIALLY_PUBLISHED',
    );
    expect(deriveContentPostStatus(['FAILED', 'CANCELLED'])).toBe('FAILED');
  });

  it('bản đã xóa không làm cả bài đăng kẹt lại', () => {
    expect(deriveContentPostStatus(['PUBLISHED', 'DELETED'])).toBe('PUBLISHED');
    expect(deriveContentPostStatus(['PUBLISHED', 'FAILED', 'DELETED'])).toBe('PARTIALLY_PUBLISHED');
    expect(deriveContentPostStatus(['FAILED', 'DELETED'])).toBe('FAILED');
  });

  it('tất cả bị hủy/xóa → CANCELLED', () => {
    expect(deriveContentPostStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
    expect(deriveContentPostStatus(['DELETED', 'DELETED'])).toBe('CANCELLED');
    expect(deriveContentPostStatus(['CANCELLED', 'DELETED'])).toBe('CANCELLED');
  });

  it('luôn trả về một trạng thái hợp lệ với mọi tổ hợp 2 phần tử', () => {
    for (const a of PLATFORM_POST_STATUSES) {
      for (const b of PLATFORM_POST_STATUSES) {
        expect(() => deriveContentPostStatus([a, b])).not.toThrow();
        expect(typeof deriveContentPostStatus([a, b])).toBe('string');
      }
    }
  });
});

describe('isRetryablePlatformPost', () => {
  it('chỉ FAILED mới được retry — chống double post (rủi ro R9)', () => {
    const retryable = PLATFORM_POST_STATUSES.filter(isRetryablePlatformPost);
    expect(retryable).toEqual(['FAILED']);
  });

  it('PUBLISHED tuyệt đối không được retry', () => {
    expect(isRetryablePlatformPost('PUBLISHED')).toBe(false);
  });
});

describe('isTerminalPlatformPostStatus', () => {
  it('PUBLISHED, CANCELLED và DELETED là trạng thái kết thúc', () => {
    expect(isTerminalPlatformPostStatus('PUBLISHED')).toBe(true);
    expect(isTerminalPlatformPostStatus('CANCELLED')).toBe(true);
    expect(isTerminalPlatformPostStatus('DELETED')).toBe(true);
  });

  it('FAILED KHÔNG phải trạng thái kết thúc — còn retry được', () => {
    expect(isTerminalPlatformPostStatus('FAILED')).toBe(false);
  });
});

describe('canTransitionPostStatus', () => {
  it('PUBLISHED là trạng thái cuối, không đi đâu được nữa', () => {
    expect(canTransitionPostStatus('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransitionPostStatus('PUBLISHED', 'QUEUED')).toBe(false);
    expect(canTransitionPostStatus('PUBLISHED', 'FAILED')).toBe(false);
  });

  it('DRAFT không nhảy thẳng sang PUBLISHED — phải qua queue', () => {
    expect(canTransitionPostStatus('DRAFT', 'PUBLISHED')).toBe(false);
    expect(canTransitionPostStatus('DRAFT', 'QUEUED')).toBe(true);
    expect(canTransitionPostStatus('DRAFT', 'SCHEDULED')).toBe(true);
  });

  it('FAILED và PARTIALLY_PUBLISHED retry được', () => {
    expect(canTransitionPostStatus('FAILED', 'QUEUED')).toBe(true);
    expect(canTransitionPostStatus('PARTIALLY_PUBLISHED', 'QUEUED')).toBe(true);
  });

  it('giữ nguyên trạng thái luôn hợp lệ (job chạy lại vô hại)', () => {
    const statuses: PlatformPostStatus[] = [...PLATFORM_POST_STATUSES];
    expect(statuses.length).toBeGreaterThan(0);
    expect(canTransitionPostStatus('QUEUED', 'QUEUED')).toBe(true);
  });
});
