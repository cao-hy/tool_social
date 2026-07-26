import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  EncryptionError,
  Keyring,
  needsReEncryption,
  safeCompare,
} from '../token-encryption';

const key = (seed: string): Buffer => Buffer.alloc(32, seed);

describe('Keyring', () => {
  it('từ chối khóa sai độ dài — AES-256 cần đúng 32 byte', () => {
    expect(() => new Keyring([{ version: 'v1', key: Buffer.alloc(16) }], 'v1')).toThrow(
      EncryptionError,
    );
  });

  it('từ chối keyring rỗng', () => {
    expect(() => new Keyring([], 'v1')).toThrow(EncryptionError);
  });

  it('từ chối khi active key không có trong keyring — lỗi cấu hình hay gặp', () => {
    expect(() => new Keyring([{ version: 'v1', key: key('a') }], 'v2')).toThrow(
      /ENCRYPTION_ACTIVE_KEY/,
    );
  });

  it('từ chối version trùng lặp', () => {
    expect(
      () =>
        new Keyring(
          [
            { version: 'v1', key: key('a') },
            { version: 'v1', key: key('b') },
          ],
          'v1',
        ),
    ).toThrow(/Trùng version/);
  });

  it('parse được định dạng biến môi trường nhiều khóa', () => {
    const env = `v1:${key('a').toString('base64')},v2:${key('b').toString('base64')}`;
    const keyring = Keyring.fromEnv(env, 'v2');
    expect(keyring.getVersions()).toEqual(['v1', 'v2']);
    expect(keyring.getActiveVersion()).toBe('v2');
  });

  it('generateKey sinh khóa đúng 32 byte', () => {
    const generated = Keyring.generateKey();
    expect(Buffer.from(generated, 'base64')).toHaveLength(32);
  });
});

describe('encryptToken / decryptToken', () => {
  let keyring: Keyring;

  beforeEach(() => {
    keyring = new Keyring([{ version: 'v1', key: key('a') }], 'v1');
  });

  it('mã hóa rồi giải mã trả về đúng giá trị ban đầu', () => {
    const plaintext = 'EAAG...token-gia-lap-cho-test';
    const { ciphertext } = encryptToken(plaintext, keyring);
    expect(decryptToken(ciphertext, keyring)).toBe(plaintext);
  });

  it('ciphertext KHÔNG chứa plaintext', () => {
    const plaintext = 'super-secret-access-token';
    const { ciphertext } = encryptToken(plaintext, keyring);
    expect(ciphertext).not.toContain(plaintext);
    expect(Buffer.from(ciphertext).toString()).not.toContain('super-secret');
  });

  it('cùng plaintext mã hóa hai lần cho ciphertext KHÁC NHAU (IV ngẫu nhiên)', () => {
    const a = encryptToken('same-value', keyring);
    const b = encryptToken('same-value', keyring);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptToken(a.ciphertext, keyring)).toBe(decryptToken(b.ciphertext, keyring));
  });

  it('ciphertext mang version khóa ở đầu', () => {
    const { ciphertext, keyVersion } = encryptToken('x', keyring);
    expect(keyVersion).toBe('v1');
    expect(ciphertext.startsWith('v1:')).toBe(true);
  });

  it('sửa ciphertext → giải mã THẤT BẠI, không trả về rác (đặc tính của GCM)', () => {
    const { ciphertext } = encryptToken('original-token', keyring);
    const parts = ciphertext.split(':');
    const tampered = Buffer.from(parts[3]!, 'base64');
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    parts[3] = tampered.toString('base64');

    expect(() => decryptToken(parts.join(':'), keyring)).toThrow(EncryptionError);
  });

  it('sửa auth tag → giải mã thất bại', () => {
    const { ciphertext } = encryptToken('original-token', keyring);
    const parts = ciphertext.split(':');
    const tag = Buffer.from(parts[2]!, 'base64');
    tag[0] = (tag[0]! ^ 0xff) & 0xff;
    parts[2] = tag.toString('base64');

    expect(() => decryptToken(parts.join(':'), keyring)).toThrow(EncryptionError);
  });

  it('giải mã bằng khóa khác → thất bại', () => {
    const { ciphertext } = encryptToken('token', keyring);
    const otherKeyring = new Keyring([{ version: 'v1', key: key('z') }], 'v1');
    expect(() => decryptToken(ciphertext, otherKeyring)).toThrow(EncryptionError);
  });

  it('thông báo lỗi giải mã KHÔNG lộ chi tiết kỹ thuật cho kẻ tấn công', () => {
    const { ciphertext } = encryptToken('token', keyring);
    const otherKeyring = new Keyring([{ version: 'v1', key: key('z') }], 'v1');
    try {
      decryptToken(ciphertext, otherKeyring);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toMatch(/auth tag|unable to authenticate/i);
    }
  });

  it('ciphertext sai định dạng bị từ chối', () => {
    expect(() => decryptToken('rac', keyring)).toThrow(/sai định dạng/);
    expect(() => decryptToken('v1:a:b', keyring)).toThrow(/sai định dạng/);
  });

  it('từ chối mã hóa chuỗi rỗng — gần như luôn là lỗi gọi nhầm', () => {
    expect(() => encryptToken('', keyring)).toThrow(EncryptionError);
  });

  it('xử lý được token dài và ký tự unicode', () => {
    const long = randomBytes(2048).toString('base64');
    expect(decryptToken(encryptToken(long, keyring).ciphertext, keyring)).toBe(long);

    const unicode = 'Tài khoản 🇻🇳 — Trang chính thức';
    expect(decryptToken(encryptToken(unicode, keyring).ciphertext, keyring)).toBe(unicode);
  });
});

describe('rotate khóa (SECURITY.md §2.4)', () => {
  it('dữ liệu mã hóa bằng v1 vẫn giải mã được sau khi thêm v2 làm active', () => {
    const oldKeyring = new Keyring([{ version: 'v1', key: key('a') }], 'v1');
    const { ciphertext } = encryptToken('token-cu', oldKeyring);

    const rotated = new Keyring(
      [
        { version: 'v1', key: key('a') },
        { version: 'v2', key: key('b') },
      ],
      'v2',
    );

    expect(decryptToken(ciphertext, rotated)).toBe('token-cu');
    expect(encryptToken('token-moi', rotated).keyVersion).toBe('v2');
  });

  it('needsReEncryption phát hiện đúng dữ liệu còn ở khóa cũ', () => {
    const oldKeyring = new Keyring([{ version: 'v1', key: key('a') }], 'v1');
    const { ciphertext } = encryptToken('x', oldKeyring);

    const rotated = new Keyring(
      [
        { version: 'v1', key: key('a') },
        { version: 'v2', key: key('b') },
      ],
      'v2',
    );

    expect(needsReEncryption(ciphertext, rotated)).toBe(true);
    expect(needsReEncryption(encryptToken('y', rotated).ciphertext, rotated)).toBe(false);
  });

  it('gỡ khóa cũ khi chưa re-encrypt hết → lỗi CHỈ RÕ nguyên nhân', () => {
    const oldKeyring = new Keyring([{ version: 'v1', key: key('a') }], 'v1');
    const { ciphertext } = encryptToken('x', oldKeyring);
    const onlyNew = new Keyring([{ version: 'v2', key: key('b') }], 'v2');

    expect(() => decryptToken(ciphertext, onlyNew)).toThrow(/re-encrypt/);
  });
});

describe('safeCompare', () => {
  it('chuỗi giống nhau → true', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
  });

  it('chuỗi khác nhau → false', () => {
    expect(safeCompare('abc123', 'abc124')).toBe(false);
  });

  it('độ dài khác nhau → false, không ném lỗi', () => {
    expect(() => safeCompare('abc', 'abcdef')).not.toThrow();
    expect(safeCompare('abc', 'abcdef')).toBe(false);
  });

  it('chuỗi rỗng', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'a')).toBe(false);
  });
});
