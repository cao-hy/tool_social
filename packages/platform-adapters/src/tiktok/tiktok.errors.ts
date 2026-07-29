import { z } from 'zod';
import {
  createPlatformError,
  type PlatformError,
  type PlatformErrorKind,
} from '../core/platform-error';

const tiktokOAuthErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  log_id: z.string().optional(),
});

const tiktokWrappedErrorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      log_id: z.string().optional(),
    })
    .optional(),
});

export function normalizeTikTokError(input: {
  status: number;
  payload: unknown;
  retryAfterMs?: number;
  cause?: unknown;
}): PlatformError {
  const oauth = tiktokOAuthErrorSchema.safeParse(input.payload);
  const wrapped = tiktokWrappedErrorSchema.safeParse(input.payload);
  const code = oauth.success
    ? oauth.data.error
    : wrapped.success
      ? wrapped.data.error?.code
      : undefined;
  const message =
    (oauth.success ? oauth.data.error_description : undefined) ??
    (wrapped.success ? wrapped.data.error?.message : undefined) ??
    `TikTok API trả về lỗi HTTP ${input.status}.`;

  return createPlatformError(mapTikTokErrorKind(input.status, code), 'TIKTOK', message, {
    httpStatus: input.status,
    platformCode: code,
    retryAfterMs: input.retryAfterMs,
    raw: redactSecrets(input.payload),
    cause: input.cause,
  });
}

export function tiktokApiEnvelopeError(input: { code: string; message?: string; raw: unknown }) {
  return createPlatformError(
    mapTikTokErrorKind(400, input.code),
    'TIKTOK',
    input.message ?? input.code,
    {
      platformCode: input.code,
      raw: redactSecrets(input.raw),
    },
  );
}

export function tiktokNetworkError(cause: unknown): PlatformError {
  const summary = summarizeNetworkCause(cause);
  return createPlatformError(
    'NETWORK',
    'TIKTOK',
    summary ? `Không gọi được TikTok API (${summary}).` : 'Không gọi được TikTok API.',
    { cause },
  );
}

export function tiktokUnexpectedPayloadError(cause: unknown, payload: unknown): PlatformError {
  const details = summarizeUnexpectedCause(cause);
  return createPlatformError(
    'PLATFORM_ERROR',
    'TIKTOK',
    details
      ? `TikTok API trả về dữ liệu không đúng định dạng hệ thống mong đợi: ${details}`
      : 'TikTok API trả về dữ liệu không đúng định dạng hệ thống mong đợi.',
    { raw: redactSecrets(payload), cause },
  );
}

function mapTikTokErrorKind(status: number, code: string | undefined): PlatformErrorKind {
  const normalized = code?.toLowerCase();
  if (status === 401 || normalized?.includes('access_token_invalid')) return 'AUTH_INVALID';
  if (normalized?.includes('scope_not_authorized')) return 'PERMISSION_DENIED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429 || normalized?.includes('rate_limit')) return 'RATE_LIMITED';
  if (status >= 500 || normalized === 'internal_error') return 'PLATFORM_ERROR';
  if (status >= 400) return 'VALIDATION';
  return 'UNKNOWN';
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

function summarizeUnexpectedCause(cause: unknown): string | null {
  if (cause instanceof z.ZodError) {
    return cause.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
  return cause instanceof Error ? cause.message : null;
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
