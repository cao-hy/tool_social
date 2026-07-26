import { ERROR_CODE_HTTP_STATUS, type ErrorCode } from '@socialhub/shared';

/**
 * Lỗi nghiệp vụ của ứng dụng.
 *
 * Tách khỏi HttpException của Nest có chủ đích: service không nên biết gì về
 * HTTP. Nó ném AppError với mã lỗi nghiệp vụ; exception filter là nơi duy nhất
 * dịch sang HTTP status. Nhờ vậy cùng một service dùng được ở cả `api` (HTTP)
 * lẫn `worker` (không có HTTP).
 */
export class AppError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = ERROR_CODE_HTTP_STATUS[code];
  }

  static notFound(resource: string, details?: unknown): AppError {
    return new AppError('NOT_FOUND', `Không tìm thấy ${resource}.`, details);
  }

  static forbidden(message = 'Bạn không có quyền thực hiện thao tác này.'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static unauthenticated(message = 'Bạn cần đăng nhập.'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError('CONFLICT', message, details);
  }

  /**
   * Nền tảng không hỗ trợ chức năng này.
   *
   * Lỗi này lẽ ra hiếm khi tới được người dùng: UI phải ẩn tính năng dựa trên
   * capability matrix từ trước. Nó xuất hiện trong log là dấu hiệu UI và
   * backend đang bất đồng về capability.
   */
  static capabilityUnsupported(platform: string, capability: string): AppError {
    return new AppError(
      'CAPABILITY_UNSUPPORTED',
      `Nền tảng ${platform} không hỗ trợ chức năng này qua API chính thức.`,
      { platform, capability },
    );
  }

  static internal(message = 'Đã xảy ra lỗi không mong muốn.'): AppError {
    return new AppError('INTERNAL_ERROR', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
