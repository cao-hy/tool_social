import { z } from 'zod';
import {
  createPlatformError,
  type PlatformError,
  type PlatformErrorKind,
} from '../core/platform-error';

const googleErrorItemSchema = z.object({
  reason: z.string().optional(),
  message: z.string().optional(),
});

const googleErrorPayloadSchema = z.object({
  error: z
    .object({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().optional(),
      errors: z.array(googleErrorItemSchema).optional(),
      status: z.string().optional(),
    })
    .optional(),
});

export function normalizeYouTubeError(input: {
  status: number;
  payload: unknown;
  retryAfterMs?: number;
  cause?: unknown;
}): PlatformError {
  const parsed = googleErrorPayloadSchema.safeParse(input.payload);
  const error = parsed.success ? parsed.data.error : undefined;
  const reason = error?.errors?.[0]?.reason ?? error?.status;
  const message =
    error?.errors?.[0]?.message ?? error?.message ?? `YouTube API trả về lỗi HTTP ${input.status}.`;

  return createPlatformError(mapYouTubeErrorKind(input.status, reason), 'YOUTUBE', message, {
    httpStatus: input.status,
    platformCode: reason ?? (error?.code === undefined ? undefined : String(error.code)),
    retryAfterMs: input.retryAfterMs,
    raw: redactSecrets(input.payload),
    cause: input.cause,
  });
}

export function youtubeNetworkError(cause: unknown): PlatformError {
  const summary = summarizeNetworkCause(cause);
  return createPlatformError(
    'NETWORK',
    'YOUTUBE',
    summary ? `Không gọi được YouTube API (${summary}).` : 'Không gọi được YouTube API.',
    { cause },
  );
}

export function youtubeUnexpectedPayloadError(cause: unknown, payload: unknown): PlatformError {
  const details = summarizeUnexpectedCause(cause);
  return createPlatformError(
    'PLATFORM_ERROR',
    'YOUTUBE',
    details
      ? `YouTube API trả về dữ liệu không đúng định dạng hệ thống mong đợi: ${details}`
      : 'YouTube API trả về dữ liệu không đúng định dạng hệ thống mong đợi.',
    { raw: redactSecrets(payload), cause },
  );
}

function mapYouTubeErrorKind(status: number, reason: string | undefined): PlatformErrorKind {
  const normalizedReason = reason?.toLowerCase();
  if (status === 401) return 'AUTH_INVALID';
  if (
    status === 403 &&
    normalizedReason &&
    ['quotaexceeded', 'ratelimitexceeded', 'userratelimitexceeded'].includes(normalizedReason)
  ) {
    return 'RATE_LIMITED';
  }
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PLATFORM_ERROR';
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
