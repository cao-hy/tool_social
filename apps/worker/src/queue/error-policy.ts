import { isPlatformError, type PlatformError } from '@socialhub/platform-adapters';

/**
 * Quyết định quan trọng nhất của worker: lỗi này có nên retry không?
 *
 * Sai lầm mặc định của hầu hết hệ thống queue là retry MỌI lỗi. Hệ quả:
 *  • Lỗi "nội dung vi phạm chính sách" bị thử lại 5 lần, tốn quota và làm chậm
 *    những job hợp lệ đang xếp hàng.
 *  • Người dùng phải đợi hết chu kỳ backoff mới thấy thông báo thất bại, trong
 *    khi kết quả đã biết chắc ngay từ lần đầu.
 *  • Alert bị nhiễu bởi những thất bại được mong đợi, đến mức đội vận hành
 *    ngừng đọc alert.
 *
 * BullMQ retry khi processor `throw`. Nên hợp đồng ở đây là:
 *   • Lỗi retry được → THROW để BullMQ xử lý backoff.
 *   • Lỗi fatal      → ghi nhận, cập nhật trạng thái, tạo notification, rồi
 *                      KẾT THÚC JOB BÌNH THƯỜNG. Job "thành công" ở đây nghĩa
 *                      là "đã xử lý xong việc ghi nhận thất bại", không phải
 *                      "thao tác nghiệp vụ đã thành công".
 */

export type JobFailureAction = 'RETRY' | 'FAIL_PERMANENTLY';

export interface ErrorPolicyDecision {
  action: JobFailureAction;
  reason: string;
  retryAfterMs?: number;
  /** Cần báo cho người dùng biết ngay, không đợi hết retry. */
  notifyUser: boolean;
  /** Tài khoản social cần được đánh dấu mất kết nối. */
  markAccountDisconnected: boolean;
}

export function decideOnError(
  error: unknown,
  attempt: number,
  maxAttempts: number,
): ErrorPolicyDecision {
  if (isPlatformError(error)) {
    return decideOnPlatformError(error, attempt, maxAttempts);
  }

  if (isProxyConfigurationError(error)) {
    return {
      action: 'FAIL_PERMANENTLY',
      reason: error.message,
      notifyUser: true,
      markAccountDisconnected: false,
    };
  }

  // Lỗi lập trình (TypeError, lỗi Prisma...) — retry thường không giúp gì,
  // nhưng cũng có thể là lỗi kết nối thoáng qua. Cho retry có giới hạn.
  return {
    action: attempt < maxAttempts ? 'RETRY' : 'FAIL_PERMANENTLY',
    reason: 'Lỗi không xác định trong quá trình xử lý job',
    notifyUser: attempt >= maxAttempts,
    markAccountDisconnected: false,
  };
}

function decideOnPlatformError(
  error: PlatformError,
  attempt: number,
  maxAttempts: number,
): ErrorPolicyDecision {
  if (!error.retryable) {
    return {
      action: 'FAIL_PERMANENTLY',
      reason: `Lỗi không thể khắc phục bằng cách thử lại: ${error.kind}`,
      notifyUser: true,
      // Token bị thu hồi: mọi job khác của tài khoản này cũng sẽ thất bại.
      // Đánh dấu mất kết nối để DỪNG chúng lại thay vì để cả hàng đợi cùng
      // đâm vào tường (SECURITY.md §12).
      markAccountDisconnected: error.kind === 'AUTH_INVALID',
    };
  }

  if (attempt >= maxAttempts) {
    return {
      action: 'FAIL_PERMANENTLY',
      reason: `Đã hết ${maxAttempts} lần thử`,
      notifyUser: true,
      markAccountDisconnected: false,
    };
  }

  return {
    action: 'RETRY',
    reason: `Lỗi tạm thời (${error.kind}), thử lại lần ${attempt + 1}/${maxAttempts}`,
    retryAfterMs: error.retryAfterMs,
    // Rate limit kéo dài đáng để báo cho admin ngay từ lần đầu — nó thường là
    // dấu hiệu cấu hình sai hoặc quá tải, không phải sự cố nhất thời.
    notifyUser: error.kind === 'RATE_LIMITED' && attempt >= 2,
    markAccountDisconnected: false,
  };
}

function isProxyConfigurationError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === 'PROXY_CONFIGURATION_MISSING';
}
