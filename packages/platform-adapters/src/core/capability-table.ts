import {
  createUnverifiedCapabilities,
  type Capability,
  type CapabilityKey,
  type Platform,
} from '@socialhub/shared';

export interface PlatformLimits {
  captionMaxLength: number | null;
  titleMaxLength: number | null;
  maxHashtags: number | null;
  maxImagesPerPost: number | null;
  imageMaxBytes: number | null;
  videoMaxBytes: number | null;
  videoMinDurationSec: number | null;
  videoMaxDurationSec: number | null;
  allowedImageMimeTypes: string[];
  allowedVideoMimeTypes: string[];
}

export interface PlatformCapabilityTable {
  platform: Platform;
  capabilities: Record<CapabilityKey, Capability>;
  limits: PlatformLimits;
}

/**
 * Giới hạn media chưa xác minh.
 *
 * `null` ở đây có ý nghĩa cụ thể: "chưa biết con số thật". Validator sẽ BỎ QUA
 * (không kiểm tra) những giới hạn còn null thay vì đoán một con số. Đoán sẽ dẫn
 * tới một trong hai kết cục tệ: chặn nội dung hợp lệ, hoặc để lọt nội dung mà
 * nền tảng sẽ từ chối — và cái sau chỉ lộ ra khi bài đăng thất bại.
 *
 * Điền các con số này là công việc bắt buộc trước khi code adapter thật —
 * xem docs/SOCIAL_API_CAPABILITIES.md §7.
 */
export const UNVERIFIED_LIMITS: PlatformLimits = {
  captionMaxLength: null,
  titleMaxLength: null,
  maxHashtags: null,
  maxImagesPerPost: null,
  imageMaxBytes: null,
  videoMaxBytes: null,
  videoMinDurationSec: null,
  videoMaxDurationSec: null,
  allowedImageMimeTypes: [],
  allowedVideoMimeTypes: [],
};

export function createUnverifiedCapabilityTable(platform: Platform): PlatformCapabilityTable {
  return {
    platform,
    capabilities: createUnverifiedCapabilities(),
    limits: { ...UNVERIFIED_LIMITS },
  };
}

export function getCapability(table: PlatformCapabilityTable, key: CapabilityKey): Capability {
  return table.capabilities[key];
}

export function isSupported(table: PlatformCapabilityTable, key: CapabilityKey): boolean {
  const state = table.capabilities[key].state;
  return state === 'SUPPORTED' || state === 'CONDITIONAL';
}

/** Đếm số capability đã được xác minh — dùng cho báo cáo tiến độ Track B. */
export function countVerified(table: PlatformCapabilityTable): {
  verified: number;
  total: number;
} {
  const values = Object.values(table.capabilities);
  return {
    verified: values.filter((c) => c.state !== 'UNVERIFIED').length,
    total: values.length,
  };
}

/**
 * Cảnh báo khi một kết luận đã quá cũ — SOCIAL_API_CAPABILITIES.md §9.
 * API của các nền tảng thay đổi liên tục; một ô xác minh 6 tháng trước không
 * còn là bằng chứng.
 */
export const CAPABILITY_STALE_AFTER_DAYS = 90;

export function findStaleCapabilities(
  table: PlatformCapabilityTable,
  now: Date = new Date(),
): CapabilityKey[] {
  const stale: CapabilityKey[] = [];
  for (const [key, capability] of Object.entries(table.capabilities) as Array<
    [CapabilityKey, Capability]
  >) {
    if (!capability.verifiedAt) continue;
    const verifiedAt = new Date(capability.verifiedAt);
    if (Number.isNaN(verifiedAt.getTime())) continue;
    const ageDays = (now.getTime() - verifiedAt.getTime()) / 86_400_000;
    if (ageDays > CAPABILITY_STALE_AFTER_DAYS) stale.push(key);
  }
  return stale;
}
