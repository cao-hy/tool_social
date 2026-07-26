import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isBlockedAddress, SsrfBlockedError } from '../ssrf-guard';

describe('isBlockedAddress (SECURITY.md §7.5)', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // metadata endpoint của cloud — mục tiêu SSRF kinh điển
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
  ])('chặn IPv4 nội bộ %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1'])(
    'cho phép IPv4 công cộng %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each(['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1'])(
    'chặn IPv6 nội bộ %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    },
  );

  it.each(['localhost', 'LOCALHOST', 'metadata.google.internal'])('chặn hostname %s', (host) => {
    expect(isBlockedAddress(host)).toBe(true);
  });

  it('cho phép hostname công cộng bình thường', () => {
    expect(isBlockedAddress('graph.facebook.com')).toBe(false);
    expect(isBlockedAddress('example.com')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('cho phép https tới host công cộng', () => {
    expect(() => assertSafeUrl('https://example.com/image.jpg')).not.toThrow();
  });

  it('chặn http mặc định', () => {
    expect(() => assertSafeUrl('http://example.com/image.jpg')).toThrow(SsrfBlockedError);
  });

  it('cho phép http khi bật allowHttp (chỉ dùng cho MinIO local)', () => {
    expect(() => assertSafeUrl('http://example.com/x', { allowHttp: true })).not.toThrow();
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/'])(
    'chặn protocol nguy hiểm %s',
    (url) => {
      expect(() => assertSafeUrl(url)).toThrow(SsrfBlockedError);
    },
  );

  it('chặn URL trỏ vào loopback và metadata endpoint', () => {
    expect(() => assertSafeUrl('https://127.0.0.1/admin')).toThrow(/nội bộ/);
    expect(() => assertSafeUrl('https://169.254.169.254/latest/meta-data/')).toThrow(/nội bộ/);
    expect(() => assertSafeUrl('https://localhost:8080/x')).toThrow(/nội bộ/);
  });

  it('chặn URL chứa credential', () => {
    expect(() => assertSafeUrl('https://user:pass@example.com/x')).toThrow(/đăng nhập/);
  });

  it('chặn URL không hợp lệ', () => {
    expect(() => assertSafeUrl('khong-phai-url')).toThrow(/không hợp lệ/);
  });

  it('tôn trọng danh sách host cho phép', () => {
    expect(() =>
      assertSafeUrl('https://evil.com/x', { allowedHosts: ['graph.facebook.com'] }),
    ).toThrow(/danh sách cho phép/);

    expect(() =>
      assertSafeUrl('https://graph.facebook.com/x', { allowedHosts: ['graph.facebook.com'] }),
    ).not.toThrow();
  });

  it('trả về URL đã parse khi hợp lệ', () => {
    const url = assertSafeUrl('https://example.com/path?a=1');
    expect(url.hostname).toBe('example.com');
    expect(url.pathname).toBe('/path');
  });
});
