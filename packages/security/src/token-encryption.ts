import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  type CipherGCMTypes,
} from 'node:crypto';

/**
 * Mã hóa access/refresh token trước khi lưu database — SECURITY.md §2.
 *
 * AES-256-GCM: vừa bảo mật vừa xác thực. Nếu ciphertext trong DB bị sửa đổi,
 * bước giải mã sẽ THẤT BẠI thay vì trả về rác — đây là lý do chọn GCM thay vì
 * CBC. Với một hệ thống mà giá trị được bảo vệ là quyền đăng bài lên tài khoản
 * thật của khách hàng, phát hiện được can thiệp quan trọng ngang với việc giữ bí mật.
 */

const ALGORITHM: CipherGCMTypes = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bit — độ dài khuyến nghị cho GCM
const AUTH_TAG_BYTES = 16;
const FORMAT_SEPARATOR = ':';

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export interface EncryptionKey {
  version: string;
  key: Buffer;
}

/**
 * Vòng khóa hỗ trợ rotate: nhiều khóa cùng tồn tại, một khóa "active" để mã hóa,
 * các khóa cũ vẫn giải mã được dữ liệu cũ (SECURITY.md §2.4).
 */
export class Keyring {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly activeVersion: string;

  constructor(keys: readonly EncryptionKey[], activeVersion: string) {
    if (keys.length === 0) {
      throw new EncryptionError('Keyring phải có ít nhất một khóa');
    }

    const map = new Map<string, Buffer>();
    for (const { version, key } of keys) {
      if (key.length !== KEY_BYTES) {
        throw new EncryptionError(
          `Khóa "${version}" dài ${key.length} byte, AES-256 yêu cầu đúng ${KEY_BYTES} byte`,
        );
      }
      if (map.has(version)) {
        throw new EncryptionError(`Trùng version khóa: "${version}"`);
      }
      map.set(version, key);
    }

    if (!map.has(activeVersion)) {
      throw new EncryptionError(
        `ENCRYPTION_ACTIVE_KEY="${activeVersion}" không có trong ENCRYPTION_KEYS`,
      );
    }

    this.keys = map;
    this.activeVersion = activeVersion;
  }

  /**
   * Parse từ biến môi trường: "v1:<base64>,v2:<base64>".
   * Ném lỗi có ngữ cảnh rõ ràng — cấu hình sai ở đây làm hỏng toàn bộ integration.
   */
  static fromEnv(encryptionKeys: string, activeVersion: string): Keyring {
    const entries = encryptionKeys
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    const keys: EncryptionKey[] = entries.map((entry) => {
      const separatorIndex = entry.indexOf(FORMAT_SEPARATOR);
      if (separatorIndex <= 0) {
        throw new EncryptionError(`Mục khóa sai định dạng (cần "version:base64"): "${entry}"`);
      }
      const version = entry.slice(0, separatorIndex);
      const encoded = entry.slice(separatorIndex + 1);
      const key = Buffer.from(encoded, 'base64');
      return { version, key };
    });

    return new Keyring(keys, activeVersion);
  }

  getActiveVersion(): string {
    return this.activeVersion;
  }

  getVersions(): string[] {
    return [...this.keys.keys()];
  }

  getKey(version: string): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new EncryptionError(
        `Không tìm thấy khóa version "${version}". Khóa này có bị gỡ khỏi keyring trước khi re-encrypt hết dữ liệu cũ không? (SECURITY.md §2.4)`,
      );
    }
    return key;
  }

  /** Sinh khóa mới đúng độ dài — dùng khi rotate. */
  static generateKey(): string {
    return randomBytes(KEY_BYTES).toString('base64');
  }
}

export interface EncryptedValue {
  /** Chuỗi hoàn chỉnh để lưu DB: "v1:iv:authTag:ciphertext" (mỗi phần base64). */
  ciphertext: string;
  /** Lưu song song để truy vấn/kiểm kê tiến độ rotate mà không phải parse chuỗi. */
  keyVersion: string;
}

/**
 * Mã hóa bằng khóa đang active.
 *
 * IV được sinh mới cho MỖI lần gọi. Tái sử dụng IV trong GCM phá vỡ hoàn toàn
 * tính bảo mật của thuật toán — đây không phải chi tiết tùy chọn.
 */
export function encryptToken(plaintext: string, keyring: Keyring): EncryptedValue {
  if (plaintext.length === 0) {
    throw new EncryptionError('Không mã hóa chuỗi rỗng — nhiều khả năng là lỗi logic gọi nhầm');
  }

  const version = keyring.getActiveVersion();
  const key = keyring.getKey(version);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const parts = [
    version,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ];

  return { ciphertext: parts.join(FORMAT_SEPARATOR), keyVersion: version };
}

/** Giải mã, tự chọn khóa theo version nhúng trong chuỗi. */
export function decryptToken(ciphertext: string, keyring: Keyring): string {
  const parts = ciphertext.split(FORMAT_SEPARATOR);
  if (parts.length !== 4) {
    throw new EncryptionError('Ciphertext sai định dạng (cần "version:iv:authTag:data")');
  }

  const [version, ivB64, authTagB64, dataB64] = parts as [string, string, string, string];
  const key = keyring.getKey(version);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  if (iv.length !== IV_BYTES) {
    throw new EncryptionError(`IV phải dài ${IV_BYTES} byte, nhận được ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptionError(
      `Auth tag phải dài ${AUTH_TAG_BYTES} byte, nhận được ${authTag.length}`,
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Không đưa lỗi gốc ra ngoài: nó có thể gợi ý cho kẻ tấn công biết
    // dữ liệu hỏng ở đâu. Cũng không log ciphertext.
    throw new EncryptionError(
      'Giải mã thất bại: dữ liệu đã bị sửa đổi hoặc sai khóa. Không dùng giá trị này.',
    );
  }
}

/** Kiểm tra một chuỗi trong DB có cần re-encrypt sang khóa mới không. */
export function needsReEncryption(ciphertext: string, keyring: Keyring): boolean {
  const version = ciphertext.split(FORMAT_SEPARATOR)[0];
  return version !== keyring.getActiveVersion();
}

/**
 * So sánh chuỗi chống tấn công phân tích thời gian.
 * Dùng cho webhook signature, reset token, CSRF token — mọi nơi so sánh bí mật.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual ném lỗi khi độ dài khác nhau; độ dài vốn không phải bí mật,
  // nhưng vẫn phải trả về false thay vì để lộ qua exception.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
