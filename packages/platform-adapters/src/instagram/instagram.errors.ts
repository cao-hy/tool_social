import { z } from 'zod';
import {
  createPlatformError,
  type PlatformError,
  type PlatformErrorKind,
} from '../core/platform-error';

const instagramErrorPayloadSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    error_user_title: z.string().optional(),
    error_user_msg: z.string().optional(),
    type: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    error_subcode: z.union([z.string(), z.number()]).optional(),
    error_data: z.unknown().optional(),
  }),
});

const RATE_LIMIT_CODES = new Set(['4', '17', '32', '613']);
const PERMISSION_CODES = new Set(['10', '200', '299']);
const AUTH_CODES = new Set(['102', '190']);

export function normalizeInstagramError(input: {
  status: number;
  payload: unknown;
  retryAfterMs?: number;
  cause?: unknown;
}): PlatformError {
  const parsed = instagramErrorPayloadSchema.safeParse(input.payload);
  const graphError = parsed.success ? parsed.data.error : undefined;
  const code = graphError?.code === undefined ? undefined : String(graphError.code);
  const subcode =
    graphError?.error_subcode === undefined ? undefined : String(graphError.error_subcode);
  const platformCode = [code, subcode].filter(Boolean).join(':') || undefined;
  const rawMessage =
    [graphError?.error_user_title, graphError?.error_user_msg].filter(Boolean).join(': ') ||
    graphError?.message ||
    `Instagram Graph API trả về lỗi HTTP ${input.status}.`;
  const message = instagramPermissionMessage(rawMessage) ?? rawMessage;

  const kind = mapInstagramErrorKind(input.status, code, rawMessage);

  return createPlatformError(kind, 'INSTAGRAM', message, {
    httpStatus: input.status,
    platformCode,
    retryAfterMs: input.retryAfterMs,
    raw: redactSecrets(input.payload),
    cause: input.cause,
  });
}

export function instagramNetworkError(cause: unknown): PlatformError {
  const summary = summarizeNetworkCause(cause);
  return createPlatformError(
    'NETWORK',
    'INSTAGRAM',
    summary
      ? `Không gọi được Instagram Graph API (${summary}).`
      : 'Không gọi được Instagram Graph API.',
    {
      cause,
    },
  );
}

export function instagramUnexpectedPayloadError(cause: unknown, payload: unknown): PlatformError {
  return createPlatformError(
    'PLATFORM_ERROR',
    'INSTAGRAM',
    'Instagram Graph API trả về dữ liệu không đúng định dạng hệ thống mong đợi.',
    {
      raw: redactSecrets(payload),
      cause,
    },
  );
}

function mapInstagramErrorKind(
  status: number,
  code: string | undefined,
  message?: string,
): PlatformErrorKind {
  if (status === 401 || (code && AUTH_CODES.has(code))) return 'AUTH_INVALID';
  if (
    status === 403 ||
    (code && PERMISSION_CODES.has(code)) ||
    message?.toLowerCase().includes('missing permission')
  ) {
    return 'PERMISSION_DENIED';
  }
  if (status === 429 || (code && RATE_LIMIT_CODES.has(code))) return 'RATE_LIMITED';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'PLATFORM_ERROR';
  if (status >= 400) return 'VALIDATION';
  return 'UNKNOWN';
}

function instagramPermissionMessage(message: string): string | null {
  if (!message.toLowerCase().includes('missing permission')) return null;

  return 'Instagram token thiếu quyền quản lý comment. Hãy bật instagram_manage_comments và pages_read_engagement trong Meta App Dashboard, rồi ngắt kết nối và kết nối lại Instagram.';
}

function summarizeNetworkCause(cause: unknown): string | null {
  if (!cause || typeof cause !== 'object') {
    return typeof cause === 'string' ? cause : null;
  }

  const error = cause as {
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };

  const code =
    typeof error.code === 'string'
      ? error.code
      : typeof error.cause?.code === 'string'
        ? error.cause.code
        : null;
  const message =
    typeof error.message === 'string'
      ? error.message
      : typeof error.cause?.message === 'string'
        ? error.cause.message
        : null;

  return [code, message].filter(Boolean).join(': ') || null;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes('token') ||
      normalizedKey.includes('secret') ||
      normalizedKey === 'code'
    ) {
      redacted[key] = '[redacted]';
    } else {
      redacted[key] = redactSecrets(entry);
    }
  }
  return redacted;
}
