import type { Platform } from '@socialhub/shared';

/**
 * Mô hình lỗi thống nhất cho mọi nền tảng — ARCHITECTURE.md §5.3.
 *
 * Lý do tồn tại: mỗi nền tảng báo lỗi theo một kiểu khác nhau (mã số, chuỗi,
 * subcode lồng nhau, HTTP status không nhất quán). Nếu để nguyên, mọi nơi trong
 * hệ thống sẽ phải biết chi tiết của cả 5 nền tảng. Adapter dịch tất cả về đây,
 * và phần còn lại của hệ thống chỉ cần biết một câu hỏi: RETRY ĐƯỢC KHÔNG?
 */

export type PlatformErrorKind =
  /** Token hỏng hoặc bị người dùng thu hồi → cần kết nối lại. */
  | 'AUTH_INVALID'
  /** Token hết hạn → refresh rồi thử lại. */
  | 'AUTH_EXPIRED'
  /** Thiếu scope / chưa được app review → không retry được bằng cách thử lại. */
  | 'PERMISSION_DENIED'
  /** Vượt quota. */
  | 'RATE_LIMITED'
  /** Nội dung không hợp lệ với nền tảng. */
  | 'VALIDATION'
  /** Bài/comment đã bị xóa ở phía nền tảng. */
  | 'NOT_FOUND'
  /** Nền tảng không hỗ trợ thao tác này qua API chính thức. */
  | 'CAPABILITY_UNSUPPORTED'
  /** Lỗi 5xx phía nền tảng. */
  | 'PLATFORM_ERROR'
  /** Timeout, DNS, đứt kết nối. */
  | 'NETWORK'
  | 'UNKNOWN';

export interface PlatformErrorOptions {
  retryable: boolean;
  /** Chờ bao lâu trước khi thử lại — lấy từ header Retry-After nếu nền tảng có gửi. */
  retryAfterMs?: number;
  httpStatus?: number;
  /** Mã lỗi gốc của nền tảng — giữ lại để điều tra, không dùng cho logic. */
  platformCode?: string;
  /** Payload gốc ĐÃ REDACT. Không bao giờ chứa token. */
  raw?: unknown;
  cause?: unknown;
}

export class PlatformError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly httpStatus: number | undefined;
  readonly platformCode: string | undefined;
  readonly raw: unknown;

  constructor(
    readonly kind: PlatformErrorKind,
    readonly platform: Platform,
    message: string,
    options: PlatformErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PlatformError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.httpStatus = options.httpStatus;
    this.platformCode = options.platformCode;
    this.raw = options.raw;
  }

  /** Serialize an toàn để ghi log — không kéo theo stack hay dữ liệu thô lớn. */
  toLogObject(): Record<string, unknown> {
    return {
      kind: this.kind,
      platform: this.platform,
      message: this.message,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      httpStatus: this.httpStatus,
      platformCode: this.platformCode,
    };
  }
}

/**
 * Loại lỗi nào KHÔNG BAO GIỜ được retry.
 *
 * Đây là bảng quan trọng nhất của module. Retry một lỗi "nội dung vi phạm chính
 * sách" 5 lần chỉ tốn quota, làm nhiễu alert và trì hoãn thông báo cho người
 * dùng. Worker chỉ được `throw` khi `retryable === true` (ARCHITECTURE.md §5.3).
 */
const NON_RETRYABLE_KINDS: ReadonlySet<PlatformErrorKind> = new Set([
  'AUTH_INVALID',
  'PERMISSION_DENIED',
  'VALIDATION',
  'NOT_FOUND',
  'CAPABILITY_UNSUPPORTED',
]);

export function isRetryableKind(kind: PlatformErrorKind): boolean {
  return !NON_RETRYABLE_KINDS.has(kind);
}

/** Tạo lỗi với `retryable` suy ra từ `kind` — tránh khai báo mâu thuẫn. */
export function createPlatformError(
  kind: PlatformErrorKind,
  platform: Platform,
  message: string,
  options: Omit<PlatformErrorOptions, 'retryable'> & { retryable?: boolean } = {},
): PlatformError {
  const { retryable, ...rest } = options;
  return new PlatformError(kind, platform, message, {
    ...rest,
    retryable: retryable ?? isRetryableKind(kind),
  });
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}

/**
 * Lỗi khi gọi một capability mà nền tảng không hỗ trợ.
 *
 * Trường hợp này lẽ ra KHÔNG BAO GIỜ xảy ra nếu UI và service đã tra capability
 * matrix đúng cách. Nó tồn tại như lưới an toàn cuối cùng, và việc nó xuất hiện
 * trong log là dấu hiệu có bug ở tầng trên chứ không phải sự cố của nền tảng.
 */
export function capabilityUnsupported(platform: Platform, capability: string): PlatformError {
  return createPlatformError(
    'CAPABILITY_UNSUPPORTED',
    platform,
    `Nền tảng ${platform} không hỗ trợ "${capability}" qua API chính thức.`,
    { platformCode: capability },
  );
}

/** Chuyển lỗi HTTP chung chung thành PlatformError khi adapter chưa map cụ thể. */
export function fromHttpStatus(
  platform: Platform,
  status: number,
  message: string,
  raw?: unknown,
): PlatformError {
  const kind: PlatformErrorKind =
    status === 401
      ? 'AUTH_EXPIRED'
      : status === 403
        ? 'PERMISSION_DENIED'
        : status === 404
          ? 'NOT_FOUND'
          : status === 429
            ? 'RATE_LIMITED'
            : status >= 500
              ? 'PLATFORM_ERROR'
              : status >= 400
                ? 'VALIDATION'
                : 'UNKNOWN';

  return createPlatformError(kind, platform, message, { httpStatus: status, raw });
}
