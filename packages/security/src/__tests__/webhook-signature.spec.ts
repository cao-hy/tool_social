import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  isTimestampWithinTolerance,
  verifyWebhookSignature,
} from '../webhook-signature';

const SECRET = 'webhook-secret-for-test';
const BODY = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '1' }] }));

describe('verifyWebhookSignature (SECURITY.md §6)', () => {
  it('chữ ký đúng → hợp lệ', () => {
    const signature = computeSignature(BODY, SECRET);
    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: signature, secret: SECRET }),
    ).toBe(true);
  });

  it('chữ ký sai → từ chối', () => {
    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: 'deadbeef', secret: SECRET }),
    ).toBe(false);
  });

  it('sai secret → từ chối', () => {
    const signature = computeSignature(BODY, 'secret-khac');
    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: signature, secret: SECRET }),
    ).toBe(false);
  });

  it('body bị sửa dù chỉ 1 byte → từ chối', () => {
    const signature = computeSignature(BODY, SECRET);
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 1] = 0x20;
    expect(
      verifyWebhookSignature({ rawBody: tampered, signatureHeader: signature, secret: SECRET }),
    ).toBe(false);
  });

  it('thiếu header chữ ký → từ chối', () => {
    expect(verifyWebhookSignature({ rawBody: BODY, signatureHeader: '', secret: SECRET })).toBe(
      false,
    );
  });

  it('thiếu secret → từ chối (không mặc định cho qua)', () => {
    const signature = computeSignature(BODY, SECRET);
    expect(verifyWebhookSignature({ rawBody: BODY, signatureHeader: signature, secret: '' })).toBe(
      false,
    );
  });

  it('hỗ trợ tiền tố kiểu "sha256="', () => {
    const signature = computeSignature(BODY, SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: `sha256=${signature}`,
        secret: SECRET,
        prefix: 'sha256=',
      }),
    ).toBe(true);
  });

  it('nền tảng dùng tiền tố nhưng header thiếu tiền tố → từ chối, không đoán mò', () => {
    const signature = computeSignature(BODY, SECRET);
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signature,
        secret: SECRET,
        prefix: 'sha256=',
      }),
    ).toBe(false);
  });

  it('chấp nhận chữ ký viết hoa (một số nền tảng gửi hex uppercase)', () => {
    const signature = computeSignature(BODY, SECRET).toUpperCase();
    expect(
      verifyWebhookSignature({ rawBody: BODY, signatureHeader: signature, secret: SECRET }),
    ).toBe(true);
  });

  it('hỗ trợ ký "timestamp.body"', () => {
    const prefix = '1700000000.';
    const signature = computeSignature(BODY, SECRET, 'sha256', prefix);
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signature,
        secret: SECRET,
        signedPayloadPrefix: prefix,
      }),
    ).toBe(true);

    // Sai timestamp → chữ ký không khớp.
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signature,
        secret: SECRET,
        signedPayloadPrefix: '1700000001.',
      }),
    ).toBe(false);
  });

  it('chữ ký tính trên BYTE THÔ, không phải JSON đã parse rồi stringify lại', () => {
    // Cùng dữ liệu, khác thứ tự key và khoảng trắng → phải cho chữ ký khác nhau.
    const bodyA = Buffer.from('{"a":1,"b":2}');
    const bodyB = Buffer.from('{"b":2,"a":1}');
    expect(computeSignature(bodyA, SECRET)).not.toBe(computeSignature(bodyB, SECRET));
  });

  it('hỗ trợ sha1 cho nền tảng còn dùng thuật toán cũ', () => {
    const signature = computeSignature(BODY, SECRET, 'sha1');
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: signature,
        secret: SECRET,
        algorithm: 'sha1',
      }),
    ).toBe(true);
  });
});

describe('isTimestampWithinTolerance — chống replay', () => {
  const now = 1_700_000_000_000;

  it('timestamp hiện tại → chấp nhận', () => {
    expect(isTimestampWithinTolerance(now / 1000, 300, now)).toBe(true);
  });

  it('lệch 4 phút → chấp nhận (trong dung sai 5 phút)', () => {
    expect(isTimestampWithinTolerance(now / 1000 - 240, 300, now)).toBe(true);
  });

  it('lệch 10 phút → từ chối', () => {
    expect(isTimestampWithinTolerance(now / 1000 - 600, 300, now)).toBe(false);
  });

  it('timestamp ở tương lai xa → từ chối (chống lệch đồng hồ bị lợi dụng)', () => {
    expect(isTimestampWithinTolerance(now / 1000 + 3600, 300, now)).toBe(false);
  });

  it('giá trị không phải số hữu hạn → từ chối', () => {
    expect(isTimestampWithinTolerance(Number.NaN, 300, now)).toBe(false);
    expect(isTimestampWithinTolerance(Number.POSITIVE_INFINITY, 300, now)).toBe(false);
  });
});
