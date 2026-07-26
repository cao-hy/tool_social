import { z } from 'zod';

/** Trạng thái của ContentPost — theo prompt §9. */
export const POST_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'PROCESSING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'CANCELLED',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];
export const postStatusSchema = z.enum(POST_STATUSES);

/**
 * Trạng thái của một PlatformPost (bản đăng lên MỘT nền tảng cụ thể).
 *
 * Cố ý KHÔNG có `PARTIALLY_PUBLISHED`: khái niệm "một phần" chỉ tồn tại khi
 * tổng hợp nhiều nền tảng. Một bản đăng đơn lẻ thì hoặc thành công hoặc không.
 */
export const PLATFORM_POST_STATUSES = [
  'PENDING',
  'QUEUED',
  'PROCESSING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
] as const;

export type PlatformPostStatus = (typeof PLATFORM_POST_STATUSES)[number];
export const platformPostStatusSchema = z.enum(PLATFORM_POST_STATUSES);

/**
 * Suy ra trạng thái của ContentPost từ trạng thái các PlatformPost con.
 *
 * Đây là hiện thực trực tiếp của luật trong prompt §9:
 *   tất cả thành công → PUBLISHED
 *   một phần         → PARTIALLY_PUBLISHED
 *   tất cả thất bại  → FAILED
 *
 * Hàm thuần, không phụ thuộc DB, để test được toàn bộ tổ hợp trạng thái.
 * Thứ tự các nhánh dưới đây là có chủ đích — xem test đi kèm.
 */
export function deriveContentPostStatus(children: readonly PlatformPostStatus[]): PostStatus {
  if (children.length === 0) return 'DRAFT';

  const has = (s: PlatformPostStatus): boolean => children.includes(s);
  const every = (s: PlatformPostStatus): boolean => children.every((c) => c === s);

  if (every('CANCELLED')) return 'CANCELLED';
  if (every('PUBLISHED')) return 'PUBLISHED';
  if (every('FAILED')) return 'FAILED';

  // Bỏ qua các bản đã hủy khi xét "tất cả xong chưa" — hủy một nền tảng
  // không được làm cả bài đăng kẹt ở trạng thái đang xử lý.
  const active = children.filter((c) => c !== 'CANCELLED');
  if (active.length === 0) return 'CANCELLED';

  const settled = active.every((c) => c === 'PUBLISHED' || c === 'FAILED');
  if (settled) {
    if (active.every((c) => c === 'PUBLISHED')) return 'PUBLISHED';
    if (active.every((c) => c === 'FAILED')) return 'FAILED';
    return 'PARTIALLY_PUBLISHED';
  }

  // Vẫn còn việc đang chạy.
  if (has('PROCESSING')) return 'PROCESSING';
  if (has('QUEUED')) return 'QUEUED';
  return 'QUEUED';
}

/** Trạng thái kết thúc — không job nào được phép thay đổi nữa. */
export const TERMINAL_PLATFORM_POST_STATUSES: readonly PlatformPostStatus[] = [
  'PUBLISHED',
  'CANCELLED',
];

export function isTerminalPlatformPostStatus(status: PlatformPostStatus): boolean {
  return TERMINAL_PLATFORM_POST_STATUSES.includes(status);
}

/**
 * Chỉ những bản đăng THẤT BẠI mới được retry.
 *
 * Đây là hàng rào chống lỗi nghiêm trọng nhất của luồng publish: retry một
 * ContentPost đã PARTIALLY_PUBLISHED không được phép đăng lại các nền tảng đã
 * thành công (rủi ro R9 — double post).
 */
export function isRetryablePlatformPost(status: PlatformPostStatus): boolean {
  return status === 'FAILED';
}

/** Chuyển trạng thái hợp lệ của ContentPost — chặn các bước nhảy vô nghĩa. */
const ALLOWED_POST_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  DRAFT: ['SCHEDULED', 'QUEUED', 'CANCELLED'],
  SCHEDULED: ['QUEUED', 'DRAFT', 'CANCELLED'],
  QUEUED: ['PROCESSING', 'CANCELLED', 'FAILED'],
  PROCESSING: ['PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED'],
  PUBLISHED: [],
  PARTIALLY_PUBLISHED: ['QUEUED', 'PROCESSING', 'PUBLISHED', 'FAILED'],
  FAILED: ['QUEUED', 'PROCESSING', 'CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function canTransitionPostStatus(from: PostStatus, to: PostStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_POST_TRANSITIONS[from] ?? []).includes(to);
}
