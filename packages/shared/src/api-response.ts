import { z } from 'zod';

/** Mã lỗi thống nhất — ARCHITECTURE.md §7.2. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'CAPABILITY_UNSUPPORTED',
  'PLATFORM_ERROR',
  'TOKEN_EXPIRED',
  'ACCOUNT_DISCONNECTED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorCodeSchema = z.enum(ERROR_CODES);

export const ERROR_CODE_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CAPABILITY_UNSUPPORTED: 403,
  PLATFORM_ERROR: 502,
  TOKEN_EXPIRED: 401,
  ACCOUNT_DISCONNECTED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  page?: number;
  pageSize?: number;
  total?: number;
  nextCursor?: string | null;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  meta: ResponseMeta;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export function isApiError<T>(response: ApiResponse<T>): response is ApiErrorResponse {
  return response.success === false;
}

export function buildMeta(requestId: string, extra: Partial<ResponseMeta> = {}): ResponseMeta {
  return { requestId, timestamp: new Date().toISOString(), ...extra };
}

export function successResponse<T>(data: T, meta: ResponseMeta): ApiSuccessResponse<T> {
  return { success: true, data, meta };
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  meta: ResponseMeta,
  details?: unknown,
): ApiErrorResponse {
  return {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details },
    meta,
  };
}
