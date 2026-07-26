import { describe, expect, it } from 'vitest';
import {
  generateOAuthState,
  generatePkcePair,
  generateSecureToken,
  hashToken,
  verifyPkce,
} from '../oauth-state';
import { maskSecret, scrubSecretsFromText } from '../log-redaction';

describe('generateOAuthState / generateSecureToken', () => {
  it('sinh giá trị đủ entropy (≥256 bit)', () => {
    const state = generateOAuthState();
    expect(Buffer.from(state, 'base64url').length).toBe(32);
  });

  it('không bao giờ lặp lại giữa các lần gọi', () => {
    const values = new Set(Array.from({ length: 500 }, () => generateOAuthState()));
    expect(values.size).toBe(500);
  });

  it('an toàn khi đặt trong URL (base64url, không cần escape)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSecureToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('hashToken — reset token lưu ở dạng hash (SECURITY.md §3)', () => {
  it('cùng token → cùng hash', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('token khác → hash khác', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('hash không chứa token gốc', () => {
    const token = generateSecureToken();
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('PKCE (SECURITY.md §5)', () => {
  it('verifier khớp challenge của chính nó', () => {
    const { verifier, challenge, method } = generatePkcePair();
    expect(method).toBe('S256');
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('verifier của cặp khác KHÔNG khớp', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(verifyPkce(a.verifier, b.challenge)).toBe(false);
  });

  it('challenge không để lộ verifier', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).not.toBe(verifier);
    expect(challenge).not.toContain(verifier);
  });
});

describe('log redaction (SECURITY.md §2.3 quy tắc 2)', () => {
  it('maskSecret che hoàn toàn chuỗi ngắn', () => {
    expect(maskSecret('short')).toBe('[REDACTED]');
  });

  it('maskSecret chỉ hé lộ đầu/cuối với chuỗi dài', () => {
    const secret = 'EAAGabcdefghijklmnopqrstuvwxyz0123456789';
    const masked = maskSecret(secret);
    expect(masked).not.toContain('ghijklmnop');
    expect(masked.startsWith('EAAG')).toBe(true);
  });

  it('scrubSecretsFromText che token trong message lỗi từ platform API', () => {
    const message = 'Request failed: access_token=EAAGxyz123456 is invalid';
    expect(scrubSecretsFromText(message)).not.toContain('EAAGxyz123456');
  });

  it('scrubSecretsFromText che Bearer token', () => {
    const message = 'Authorization: Bearer ya29.a0AfH6SMBabcdefghijklmnop';
    const scrubbed = scrubSecretsFromText(message);
    expect(scrubbed).not.toContain('ya29.a0AfH6SMBabcdefghijklmnop');
  });

  it('giữ nguyên message không chứa secret', () => {
    const message = 'Rate limit exceeded, retry after 60 seconds';
    expect(scrubSecretsFromText(message)).toBe(message);
  });
});
