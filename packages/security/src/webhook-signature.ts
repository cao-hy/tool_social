import { createHmac } from 'node:crypto';
import { safeCompare } from './token-encryption';

/**
 * Xác thực chữ ký webhook — SECURITY.md §6.
 *
 * Hai lỗi kinh điển mà module này tồn tại để ngăn:
 *  1. Tính chữ ký trên JSON đã parse rồi stringify lại. Chữ ký được tính trên
 *     BYTE THÔ; parse rồi serialize lại sẽ đổi thứ tự key và khoảng trắng, làm
 *     chữ ký hợp lệ bị coi là sai.
 *  2. So sánh bằng `===`. Việc so sánh chuỗi thoát sớm ở byte đầu tiên khác
 *     nhau làm lộ thông tin qua thời gian thực thi.
 */

export type SignatureAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface VerifyWebhookOptions {
  /** Body THÔ, chưa qua JSON.parse. */
  rawBody: Buffer;
  /** Giá trị header chữ ký do nền tảng gửi. */
  signatureHeader: string;
  secret: string;
  algorithm?: SignatureAlgorithm;
  /** Tiền tố nền tảng gắn trước chữ ký, ví dụ "sha256=". */
  prefix?: string;
  /** Chuỗi trộn thêm vào trước body (một số nền tảng ký "timestamp.body"). */
  signedPayloadPrefix?: string;
}

export function computeSignature(
  rawBody: Buffer,
  secret: string,
  algorithm: SignatureAlgorithm = 'sha256',
  signedPayloadPrefix?: string,
): string {
  const hmac = createHmac(algorithm, secret);
  if (signedPayloadPrefix !== undefined) hmac.update(signedPayloadPrefix);
  hmac.update(rawBody);
  return hmac.digest('hex');
}

export function verifyWebhookSignature(options: VerifyWebhookOptions): boolean {
  const {
    rawBody,
    signatureHeader,
    secret,
    algorithm = 'sha256',
    prefix = '',
    signedPayloadPrefix,
  } = options;

  if (!signatureHeader || !secret) return false;

  const received =
    prefix && signatureHeader.startsWith(prefix)
      ? signatureHeader.slice(prefix.length)
      : signatureHeader;

  // Nền tảng gắn tiền tố nhưng header không có → coi như sai, không đoán mò.
  if (prefix && !signatureHeader.startsWith(prefix)) return false;

  const expected = computeSignature(rawBody, secret, algorithm, signedPayloadPrefix);
  return safeCompare(received.toLowerCase(), expected.toLowerCase());
}

/**
 * Chống replay: từ chối event có timestamp lệch quá xa hiện tại.
 *
 * Chỉ dùng được với nền tảng có gửi timestamp đã ký. Nếu không có, lớp phòng thủ
 * duy nhất là unique constraint trên (platform, externalEventId).
 */
export function isTimestampWithinTolerance(
  timestampSeconds: number,
  toleranceSeconds = 300,
  nowMs: number = Date.now(),
): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  const deltaSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  return deltaSeconds <= toleranceSeconds;
}
