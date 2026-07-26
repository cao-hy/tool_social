import type { Platform } from '@socialhub/shared';

/**
 * Thông tin quota do nền tảng trả về.
 *
 * Mục đích: chủ động giảm tốc TRƯỚC khi bị chặn, thay vì đợi lỗi 429 rồi mới
 * phản ứng. Nền tảng nào có gửi thông tin này thì adapter parse ra đây; nền tảng
 * nào không có thì để undefined và hệ thống chỉ còn cách phản ứng sau khi lỗi.
 */
export interface RateLimitInfo {
  platform: Platform;
  /** Số lượt gọi còn lại trong cửa sổ hiện tại. */
  remaining?: number;
  limit?: number;
  resetAt?: Date;
  /** Phần trăm quota đã dùng (0–100) — một số nền tảng báo dạng này. */
  usagePercent?: number;
}

export const RATE_LIMIT_SLOWDOWN_THRESHOLD = 0.15;

/**
 * Còn dưới 15% quota thì nên giãn nhịp gọi API.
 *
 * Con số 15% là điểm khởi đầu hợp lý chứ không phải kết quả đo đạc — cần điều
 * chỉnh khi có dữ liệu thật từ `ApiRequestLog` (rủi ro R4).
 */
export function shouldSlowDown(info: RateLimitInfo): boolean {
  if (info.usagePercent !== undefined) {
    return info.usagePercent >= (1 - RATE_LIMIT_SLOWDOWN_THRESHOLD) * 100;
  }
  if (info.remaining !== undefined && info.limit !== undefined && info.limit > 0) {
    return info.remaining / info.limit <= RATE_LIMIT_SLOWDOWN_THRESHOLD;
  }
  return false;
}

/**
 * Tính thời gian chờ trước lần thử tiếp theo.
 *
 * Thứ tự ưu tiên có chủ đích:
 *  1. `Retry-After` của nền tảng — họ biết rõ hơn ta.
 *  2. Thời điểm reset quota.
 *  3. Exponential backoff có jitter.
 *
 * Jitter là bắt buộc, không phải tùy chọn: nếu 50 job cùng bị rate limit và
 * cùng chờ đúng 5 giây, chúng sẽ cùng thức dậy và cùng bị chặn lại lần nữa.
 */
export function computeRetryDelayMs(input: {
  attempt: number;
  baseDelayMs: number;
  retryAfterMs?: number;
  resetAt?: Date;
  maxDelayMs?: number;
  now?: number;
  /** Chỉ để test — production dùng Math.random. */
  random?: () => number;
}): number {
  const {
    attempt,
    baseDelayMs,
    retryAfterMs,
    resetAt,
    maxDelayMs = 15 * 60 * 1000,
    now = Date.now(),
    random = Math.random,
  } = input;

  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  if (resetAt) {
    const waitMs = resetAt.getTime() - now;
    if (waitMs > 0) return Math.min(waitMs, maxDelayMs);
  }

  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = exponential * 0.2 * random();
  return Math.min(Math.round(exponential + jitter), maxDelayMs);
}

/** Parse header `Retry-After` (giây, hoặc HTTP-date). */
export function parseRetryAfterHeader(
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - now;
    return delta > 0 ? delta : 0;
  }

  return undefined;
}
