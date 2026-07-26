/**
 * Cấu hình che dữ liệu nhạy cảm trong log — SECURITY.md §2.3 quy tắc 2.
 *
 * Pino nhận danh sách đường dẫn để redact. Danh sách này được tập trung ở một
 * chỗ để `api` và `worker` không thể cấu hình lệch nhau — và để việc bổ sung
 * một trường nhạy cảm mới chỉ cần sửa một nơi.
 */

export const PINO_REDACT_PATHS: readonly string[] = [
  // HTTP request/response
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',

  // Body cấp một
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'idToken',
  'token',
  'sessionToken',
  'clientSecret',
  'apiKey',
  'secret',
  'encryptionKey',
  'code',
  'codeVerifier',

  // Lồng một cấp — các vị trí hay xuất hiện nhất
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.token',
  'body.password',
  'body.accessToken',
  'body.refreshToken',
  'tokenSet.accessToken',
  'tokenSet.refreshToken',
  'socialToken.accessToken',
  'socialToken.refreshToken',
];

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Che bớt một chuỗi bí mật để tiện debug mà không lộ giá trị.
 * Chuỗi ngắn bị che hoàn toàn — hé lộ 4 ký tự của một bí mật 8 ký tự là quá nhiều.
 */
export function maskSecret(value: string, visibleChars = 4): string {
  if (value.length <= visibleChars * 3) return REDACTION_PLACEHOLDER;
  return `${value.slice(0, visibleChars)}…${value.slice(-visibleChars)}`;
}

/**
 * Quét một chuỗi tự do (thường là error message từ platform API) và che các
 * mẫu trông giống token trước khi ghi log.
 *
 * Đây là lưới an toàn cuối cùng, KHÔNG phải biện pháp chính: lớp phòng thủ chính
 * vẫn là không đưa token vào chuỗi ngay từ đầu.
 */
const TOKEN_LIKE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:access_token|refresh_token|client_secret|api_key)=[\w.-]+/gi,
  /\bBearer\s+[\w.-]{16,}/gi,
  /\bEA[A-Za-z0-9]{40,}/g, // token dài dạng Meta
  /\bya29\.[\w.-]{20,}/g, // token dạng Google
];

export function scrubSecretsFromText(text: string): string {
  let output = text;
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    output = output.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return output;
}
