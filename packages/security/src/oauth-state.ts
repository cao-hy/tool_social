import { createHash, randomBytes } from 'node:crypto';

/**
 * Sinh giá trị ngẫu nhiên và PKCE cho luồng OAuth — SECURITY.md §5.
 */

/** State chống CSRF trong luồng OAuth: 256 bit ngẫu nhiên, dùng một lần. */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** Token dùng cho reset password / invitation — 256 bit. */
export function generateSecureToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash token trước khi lưu DB.
 *
 * Reset token và invitation token được lưu ở dạng hash để một lần rò rỉ database
 * không cho phép kẻ tấn công dùng lại chúng. Dùng SHA-256 (không phải Argon2)
 * là hợp lý ở đây vì đầu vào đã có 256 bit entropy — không có gì để brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** PKCE (RFC 7636) — chống đánh cắp authorization code. */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}
