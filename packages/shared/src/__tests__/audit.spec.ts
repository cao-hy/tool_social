import { describe, expect, it } from 'vitest';
import { isSensitiveFieldName, redactSensitive } from '../audit';

describe('redactSensitive — audit log không được chứa secret (SECURITY.md §11)', () => {
  it('che token ở cấp một', () => {
    const out = redactSensitive({ id: 'x', accessToken: 'ya29.secret' });
    expect(out).toEqual({ id: 'x', accessToken: '[REDACTED]' });
  });

  it('che token nằm sâu trong object lồng nhau', () => {
    const out = redactSensitive({
      account: { name: 'Page', token: { refreshToken: 'r-secret' } },
    });
    expect(JSON.stringify(out)).not.toContain('r-secret');
  });

  it('che token nằm trong mảng', () => {
    const out = redactSensitive({ accounts: [{ passwordHash: 'argon2$abc' }] });
    expect(JSON.stringify(out)).not.toContain('argon2$abc');
  });

  it('không phân biệt hoa thường', () => {
    const out = redactSensitive({ AccessToken: 'v', CLIENT_SECRET: 'v' }) as Record<
      string,
      unknown
    >;
    expect(out.AccessToken).toBe('[REDACTED]');
  });

  it('giữ nguyên dữ liệu không nhạy cảm', () => {
    const input = { title: 'Bài đăng', views: 100, tags: ['a', 'b'], publishedAt: null };
    expect(redactSensitive(input)).toEqual(input);
  });

  it('không vỡ với vòng lặp sâu bất thường (chặn ở MAX_DEPTH)', () => {
    let deep: Record<string, unknown> = { password: 'x' };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => redactSensitive(deep)).not.toThrow();
  });

  it('xử lý được giá trị nguyên thủy và null', () => {
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(42)).toBe(42);
  });
});

describe('isSensitiveFieldName', () => {
  it.each(['password', 'accessToken', 'refreshToken', 'clientSecret', 'cookie', 'authorization'])(
    '%s là trường nhạy cảm',
    (name) => {
      expect(isSensitiveFieldName(name)).toBe(true);
    },
  );

  it.each(['title', 'views', 'email', 'createdAt'])('%s KHÔNG phải trường nhạy cảm', (name) => {
    expect(isSensitiveFieldName(name)).toBe(false);
  });
});
