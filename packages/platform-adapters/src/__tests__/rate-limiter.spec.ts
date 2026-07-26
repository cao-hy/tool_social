import { describe, expect, it } from 'vitest';
import { computeRetryDelayMs, parseRetryAfterHeader, shouldSlowDown } from '../core/rate-limiter';
import { validateAgainstLimits } from '../core/validator';
import { UNVERIFIED_LIMITS } from '../core/capability-table';
import type { PublishPostInput } from '../core/types';

describe('shouldSlowDown', () => {
  it('còn nhiều quota → chạy bình thường', () => {
    expect(shouldSlowDown({ platform: 'FACEBOOK', remaining: 800, limit: 1000 })).toBe(false);
  });

  it('còn dưới 15% quota → giảm tốc', () => {
    expect(shouldSlowDown({ platform: 'FACEBOOK', remaining: 100, limit: 1000 })).toBe(true);
  });

  it('hỗ trợ nền tảng báo theo phần trăm đã dùng', () => {
    expect(shouldSlowDown({ platform: 'INSTAGRAM', usagePercent: 90 })).toBe(true);
    expect(shouldSlowDown({ platform: 'INSTAGRAM', usagePercent: 50 })).toBe(false);
  });

  it('không có thông tin quota → không đoán, chạy bình thường', () => {
    expect(shouldSlowDown({ platform: 'TIKTOK' })).toBe(false);
  });
});

describe('computeRetryDelayMs', () => {
  const noJitter = () => 0;

  it('ƯU TIÊN Retry-After của nền tảng — họ biết rõ hơn ta', () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 5000,
      retryAfterMs: 90_000,
      random: noJitter,
    });
    expect(delay).toBe(90_000);
  });

  it('dùng thời điểm reset quota khi không có Retry-After', () => {
    const now = 1_000_000;
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 5000,
      resetAt: new Date(now + 30_000),
      now,
      random: noJitter,
    });
    expect(delay).toBe(30_000);
  });

  it('exponential backoff khi nền tảng không cho biết gì', () => {
    const base = { baseDelayMs: 5000, random: noJitter };
    expect(computeRetryDelayMs({ ...base, attempt: 1 })).toBe(5_000);
    expect(computeRetryDelayMs({ ...base, attempt: 2 })).toBe(10_000);
    expect(computeRetryDelayMs({ ...base, attempt: 3 })).toBe(20_000);
    expect(computeRetryDelayMs({ ...base, attempt: 4 })).toBe(40_000);
  });

  it('có jitter để 50 job không cùng thức dậy một lúc', () => {
    const withJitter = computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 5000,
      random: () => 1,
    });
    const withoutJitter = computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 5000,
      random: () => 0,
    });
    expect(withJitter).toBeGreaterThan(withoutJitter);
  });

  it('chặn trên để không chờ vô hạn', () => {
    const delay = computeRetryDelayMs({
      attempt: 20,
      baseDelayMs: 5000,
      maxDelayMs: 60_000,
      random: noJitter,
    });
    expect(delay).toBe(60_000);
  });

  it('Retry-After quá lớn vẫn bị chặn bởi maxDelayMs', () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 5000,
      retryAfterMs: 86_400_000,
      maxDelayMs: 900_000,
      random: noJitter,
    });
    expect(delay).toBe(900_000);
  });

  it('resetAt đã qua → bỏ qua, dùng backoff', () => {
    const now = 1_000_000;
    const delay = computeRetryDelayMs({
      attempt: 1,
      baseDelayMs: 5000,
      resetAt: new Date(now - 10_000),
      now,
      random: noJitter,
    });
    expect(delay).toBe(5000);
  });
});

describe('parseRetryAfterHeader', () => {
  it('parse số giây', () => {
    expect(parseRetryAfterHeader('120')).toBe(120_000);
  });

  it('parse HTTP-date', () => {
    const now = Date.parse('2026-07-27T10:00:00Z');
    expect(parseRetryAfterHeader('Mon, 27 Jul 2026 10:01:00 GMT', now)).toBe(60_000);
  });

  it('HTTP-date trong quá khứ → 0', () => {
    const now = Date.parse('2026-07-27T10:00:00Z');
    expect(parseRetryAfterHeader('Mon, 27 Jul 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('không có header hoặc giá trị rác → undefined', () => {
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    expect(parseRetryAfterHeader('rac')).toBeUndefined();
  });
});

describe('validateAgainstLimits — giới hạn chưa xác minh thì BỎ QUA, không đoán', () => {
  const input: PublishPostInput = {
    caption: 'x'.repeat(100_000),
    title: 'y'.repeat(5000),
    hashtags: Array.from({ length: 500 }, (_, i) => `tag${i}`),
    media: [
      {
        type: 'IMAGE',
        url: 'https://example.com/a.jpg',
        mimeType: 'image/webp',
        sizeBytes: 500 * 1024 * 1024,
      },
    ],
  };

  it('với UNVERIFIED_LIMITS thì KHÔNG chặn gì — thà để nền tảng từ chối còn hơn đoán sai', () => {
    const result = validateAgainstLimits(input, UNVERIFIED_LIMITS);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('khi giới hạn ĐÃ xác minh thì kiểm tra thật sự', () => {
    const result = validateAgainstLimits(input, {
      ...UNVERIFIED_LIMITS,
      captionMaxLength: 2200,
      maxHashtags: 30,
      allowedImageMimeTypes: ['image/jpeg', 'image/png'],
    });

    expect(result.valid).toBe(false);
    const fields = result.issues.map((i) => i.field);
    expect(fields).toContain('caption');
    expect(fields).toContain('hashtags');
    expect(fields).toContain('media[0]');
  });

  it('thông báo lỗi nêu rõ giới hạn để người dùng biết phải sửa gì', () => {
    const result = validateAgainstLimits(
      { caption: 'x'.repeat(3000), media: [] },
      { ...UNVERIFIED_LIMITS, captionMaxLength: 2200 },
    );
    expect(result.issues[0]?.message).toContain('3000');
    expect(result.issues[0]?.message).toContain('2200');
    expect(result.issues[0]?.limit).toBe(2200);
  });

  it('nội dung hợp lệ đi qua', () => {
    const result = validateAgainstLimits(
      { caption: 'Xin chào', hashtags: ['a'], media: [] },
      { ...UNVERIFIED_LIMITS, captionMaxLength: 2200, maxHashtags: 30 },
    );
    expect(result.valid).toBe(true);
  });

  it('kiểm tra thời lượng video khi đã biết giới hạn', () => {
    const result = validateAgainstLimits(
      {
        media: [
          {
            type: 'VIDEO',
            url: 'https://example.com/v.mp4',
            mimeType: 'video/mp4',
            sizeBytes: 1024,
            durationSec: 300,
          },
        ],
      },
      { ...UNVERIFIED_LIMITS, videoMaxDurationSec: 60 },
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('300');
  });
});
