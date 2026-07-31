import { z } from 'zod';

/** Hành động được ghi audit log — SECURITY.md §11. */
export const AUDIT_ACTIONS = [
  'USER_LOGIN',
  'USER_LOGIN_FAILED',
  'USER_LOGOUT',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_REQUESTED',
  'SOCIAL_ACCOUNT_CONNECTED',
  'SOCIAL_ACCOUNT_DISCONNECTED',
  'SOCIAL_TOKEN_REFRESHED',
  'SOCIAL_TOKEN_ACCESSED',
  'POST_CREATED',
  'POST_UPDATED',
  'POST_DELETED',
  'POST_PUBLISHED',
  'POST_SCHEDULED',
  'COMMENT_REPLIED',
  'COMMENT_DELETED',
  'COMMENT_HIDDEN',
  'MEMBER_INVITED',
  'MEMBER_REMOVED',
  'ROLE_CHANGED',
  'OWNERSHIP_TRANSFERRED',
  'WORKSPACE_SETTINGS_CHANGED',
  'PROXY_CONFIG_UPDATED',
  'PERMISSION_DENIED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const auditActionSchema = z.enum(AUDIT_ACTIONS);

/**
 * Trường bị loại khỏi `before`/`after` của audit log.
 * SECURITY.md §11: audit log không bao giờ được chứa secret.
 */
export const SENSITIVE_FIELD_NAMES = [
  'password',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'token',
  'secret',
  'clientSecret',
  'apiKey',
  'authorization',
  'cookie',
  'sessionToken',
  'encryptionKey',
] as const;

const SENSITIVE_SET = new Set<string>(SENSITIVE_FIELD_NAMES.map((f) => f.toLowerCase()));

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_SET.has(name.toLowerCase());
}

/**
 * Loại bỏ trường nhạy cảm khỏi một object trước khi ghi log/audit.
 * Đệ quy vào object và mảng lồng nhau; giữ nguyên cấu trúc để bản ghi vẫn
 * đọc được, chỉ thay giá trị bằng `[REDACTED]`.
 */
export function redactSensitive<T>(value: T, depth = 0): T {
  const MAX_DEPTH = 8;
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveFieldName(key) ? '[REDACTED]' : redactSensitive(val, depth + 1);
  }
  return out as T;
}
