import { isIP } from 'node:net';

/**
 * Chống SSRF — SECURITY.md §7.5.
 *
 * Điểm rủi ro: bất kỳ chỗ nào hệ thống fetch một URL do người dùng cung cấp
 * (import media từ URL, hoặc nếu adapter yêu cầu media nằm ở URL công khai).
 * Nếu không chặn, kẻ tấn công có thể khiến server tự gọi vào mạng nội bộ hoặc
 * vào metadata endpoint của cloud provider để lấy credential.
 */

export class SsrfBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly target: string,
  ) {
    super(`URL bị chặn (${reason}): ${target}`);
    this.name = 'SsrfBlockedError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
]);

/** Dải IPv4 riêng tư / đặc biệt, biểu diễn dạng [network, prefixLength]. */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — chứa metadata endpoint 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // không parse được thì chặn

  for (const [network, prefix] of BLOCKED_IPV4_CIDRS) {
    const networkValue = ipv4ToInt(network);
    if (networkValue === null) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (networkValue & mask) >>> 0) return true;
  }
  return false;
}

export function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique local (fc00::/7)

  // IPv4-mapped (::ffff:127.0.0.1) — kiểm tra phần IPv4 bên trong.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);

  return false;
}

export function isBlockedAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) return isBlockedIpv4(host);
  if (version === 6) return isBlockedIpv6(host);
  return BLOCKED_HOSTNAMES.has(host.toLowerCase());
}

export interface SsrfGuardOptions {
  /** Cho phép http:// — chỉ bật ở môi trường local dev với MinIO. */
  allowHttp?: boolean;
  /** Nếu có, chỉ những hostname trong danh sách này mới được phép. */
  allowedHosts?: readonly string[];
}

/**
 * Kiểm tra URL trước khi fetch.
 *
 * LƯU Ý QUAN TRỌNG: hàm này chỉ kiểm tra được phần *cú pháp* của URL. Nó KHÔNG
 * chống được DNS rebinding, vì hostname có thể phân giải sang IP nội bộ tại
 * thời điểm kết nối. Lớp phòng thủ đầy đủ đòi hỏi resolve DNS trước, kiểm tra
 * IP, rồi kết nối thẳng tới IP đó — sẽ triển khai ở tầng HTTP client khi
 * Phase 4 thực sự cần fetch URL từ người dùng.
 */
export function assertSafeUrl(rawUrl: string, options: SsrfGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('URL không hợp lệ', rawUrl);
  }

  const allowedProtocols = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new SsrfBlockedError(`protocol "${url.protocol}" không được phép`, rawUrl);
  }

  if (url.username || url.password) {
    throw new SsrfBlockedError('URL chứa thông tin đăng nhập', rawUrl);
  }

  if (options.allowedHosts && !options.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new SsrfBlockedError('hostname không nằm trong danh sách cho phép', rawUrl);
  }

  if (isBlockedAddress(url.hostname)) {
    throw new SsrfBlockedError('trỏ tới địa chỉ nội bộ hoặc loopback', rawUrl);
  }

  return url;
}
