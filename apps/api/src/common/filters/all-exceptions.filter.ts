import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { buildMeta, errorResponse, type ErrorCode } from '@socialhub/shared';
import { isPlatformError, type PlatformError } from '@socialhub/platform-adapters';
import { scrubSecretsFromText } from '@socialhub/security';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { isAppError } from '../errors/app-error';
import { getRequestId } from '../request-context';
import { logger } from '../logger';

/**
 * Xử lý lỗi tập trung — ARCHITECTURE.md §7.
 *
 * Bốn nguyên tắc:
 *  1. Client LUÔN nhận envelope thống nhất, kể cả khi hệ thống hỏng.
 *  2. Lỗi 5xx KHÔNG lộ chi tiết nội bộ ra ngoài (stack trace, tên bảng, tên
 *     biến môi trường). Chi tiết chỉ vào log, kèm requestId để đối chiếu.
 *  3. Mọi thông điệp lỗi đi qua scrubSecretsFromText trước khi ra ngoài —
 *     error message của platform API đôi khi có nhúng token.
 *  4. PlatformError được dịch sang mã lỗi nghiệp vụ, không rò rỉ mã lỗi thô
 *     của nền tảng ra client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = getRequestId(ctx.getRequest<unknown>());
    const meta = buildMeta(requestId);

    const { status, code, message, details, logLevel } = this.normalize(exception);

    logger[logLevel](
      {
        requestId,
        errorCode: code,
        httpStatus: status,
        err:
          exception instanceof Error
            ? { name: exception.name, message: exception.message }
            : exception,
        stack: status >= 500 && exception instanceof Error ? exception.stack : undefined,
      },
      `Request thất bại: ${code}`,
    );

    void reply
      .status(status)
      .send(errorResponse(code, scrubSecretsFromText(message), meta, details));
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    logLevel: 'warn' | 'error';
  } {
    if (isAppError(exception)) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        logLevel: exception.httpStatus >= 500 ? 'error' : 'warn',
      };
    }

    if (
      exception instanceof Error &&
      'code' in exception &&
      exception.code === 'PROXY_CONFIGURATION_MISSING'
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'INTERNAL_ERROR',
        message: exception.message || 'Proxy đang bật nhưng chưa có Proxy URL.',
        logLevel: 'error',
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'Dữ liệu gửi lên không hợp lệ.',
        details: exception.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
        logLevel: 'warn',
      };
    }

    if (isPlatformError(exception)) {
      return this.fromPlatformError(exception);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: this.httpStatusToCode(status),
        message: exception.message,
        logLevel: status >= 500 ? 'error' : 'warn',
      };
    }

    const statusCode = getHttpStyleStatusCode(exception);
    if (statusCode) {
      return {
        status: statusCode,
        code: this.httpStatusToCode(statusCode),
        message:
          exception instanceof Error
            ? exception.message
            : statusCode === 429
              ? 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.'
              : 'Request không hợp lệ.',
        logLevel: statusCode >= 500 ? 'error' : 'warn',
      };
    }

    // Lỗi không lường trước: người dùng chỉ nhận requestId, chi tiết nằm ở log.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Đã xảy ra lỗi không mong muốn. Vui lòng thử lại hoặc liên hệ hỗ trợ.',
      logLevel: 'error',
    };
  }

  private fromPlatformError(error: PlatformError): {
    status: number;
    code: ErrorCode;
    message: string;
    details: unknown;
    logLevel: 'warn' | 'error';
  } {
    const code: ErrorCode =
      error.kind === 'CAPABILITY_UNSUPPORTED'
        ? 'CAPABILITY_UNSUPPORTED'
        : error.kind === 'AUTH_EXPIRED'
          ? 'TOKEN_EXPIRED'
          : error.kind === 'AUTH_INVALID'
            ? 'ACCOUNT_DISCONNECTED'
            : error.kind === 'RATE_LIMITED'
              ? 'RATE_LIMITED'
              : error.kind === 'VALIDATION'
                ? 'VALIDATION_ERROR'
                : error.kind === 'NOT_FOUND'
                  ? 'NOT_FOUND'
                  : error.kind === 'PERMISSION_DENIED'
                    ? 'FORBIDDEN'
                    : 'PLATFORM_ERROR';

    return {
      status: this.codeToStatus(code),
      code,
      message: error.message,
      // Chỉ trả những gì client thật sự cần để hiển thị — không trả raw payload.
      details: { platform: error.platform, retryable: error.retryable },
      logLevel: error.retryable ? 'warn' : 'error',
    };
  }

  private codeToStatus(code: ErrorCode): number {
    const map: Partial<Record<ErrorCode, number>> = {
      CAPABILITY_UNSUPPORTED: 403,
      TOKEN_EXPIRED: 401,
      ACCOUNT_DISCONNECTED: 409,
      RATE_LIMITED: 429,
      VALIDATION_ERROR: 400,
      NOT_FOUND: 404,
      FORBIDDEN: 403,
      PLATFORM_ERROR: 502,
    };
    return map[code] ?? 500;
  }

  private httpStatusToCode(status: number): ErrorCode {
    switch (status) {
      case 400:
        return 'VALIDATION_ERROR';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 413:
        return 'PAYLOAD_TOO_LARGE';
      case 415:
        return 'UNSUPPORTED_MEDIA_TYPE';
      case 429:
        return 'RATE_LIMITED';
      case 503:
        return 'SERVICE_UNAVAILABLE';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR';
    }
  }
}

function getHttpStyleStatusCode(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null || !('statusCode' in exception)) {
    return null;
  }
  const statusCode = (exception as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600
    ? statusCode
    : null;
}
