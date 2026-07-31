import { z } from 'zod';
import { platformSchema, type Platform } from './platform';

/**
 * Capability của nền tảng là DỮ LIỆU RUNTIME, không phải tài liệu.
 * Xem ARCHITECTURE.md §1 (P4) và docs/SOCIAL_API_CAPABILITIES.md.
 *
 * Package này chỉ định nghĩa KIỂU. Dữ liệu thật nằm ở
 * packages/platform-adapters (nơi nó được test đối chiếu với code adapter)
 * và được API trả xuống frontend qua GET /api/v1/platforms/capabilities.
 */

export const CAPABILITY_STATES = ['SUPPORTED', 'UNSUPPORTED', 'CONDITIONAL', 'UNVERIFIED'] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];
export const capabilityStateSchema = z.enum(CAPABILITY_STATES);

export const capabilitySchema = z.object({
  state: capabilityStateSchema,
  /** Điều kiện áp dụng — bắt buộc khi state = CONDITIONAL. */
  condition: z.string().optional(),
  /** URL tài liệu chính thức đã dùng để kết luận. */
  source: z.string().url().optional(),
  /** Ngày kiểm chứng (ISO date). CI cảnh báo khi quá 90 ngày. */
  verifiedAt: z.string().optional(),
  /** Người kiểm chứng. */
  verifiedBy: z.string().optional(),
});

export type Capability = z.infer<typeof capabilitySchema>;

/**
 * Danh sách capability mà hệ thống quan tâm.
 *
 * Cố ý KHÔNG có `likePost` / `sharePost` / `followAccount`:
 * prompt §3 cấm giả lập hành vi người dùng. Like và share chỉ tồn tại trong hệ
 * thống dưới dạng METRIC ĐỌC. Không thêm chúng vào đây.
 */
export const CAPABILITY_KEYS = [
  // Publishing
  'publishText',
  'publishImage',
  'publishMultipleImages',
  'publishVideo',
  'publishShortVideo',
  'publishWithLink',
  'customThumbnail',
  'postTitle',
  'nativeScheduling',
  'editPublishedPost',
  'deletePublishedPost',
  // Comments
  'readComments',
  'readNestedComments',
  'replyToComment',
  'editComment',
  'hideComment',
  'deleteComment',
  'commentWebhook',
  'readCommentsOnExternallyCreatedPosts',
  // Metrics
  'postViews',
  'postLikes',
  'postCommentCount',
  'postShares',
  'postReach',
  'postImpressions',
  'postSaves',
  'accountFollowers',
  'accountFollowerGrowth',
  'accountReach',
  'audienceDemographics',
  'hourlyBreakdown',
  // Token lifecycle
  'refreshToken',
  'revokeToken',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const platformCapabilitiesSchema = z.object({
  platform: platformSchema,
  capabilities: z.record(z.enum(CAPABILITY_KEYS), capabilitySchema),
  /** Ràng buộc media dùng cho validator — null nghĩa là chưa xác minh. */
  limits: z
    .object({
      captionMaxLength: z.number().int().positive().nullable(),
      titleMaxLength: z.number().int().positive().nullable(),
      maxHashtags: z.number().int().positive().nullable(),
      maxImagesPerPost: z.number().int().positive().nullable(),
      imageMaxBytes: z.number().int().positive().nullable(),
      videoMaxBytes: z.number().int().positive().nullable(),
      videoMinDurationSec: z.number().int().nonnegative().nullable(),
      videoMaxDurationSec: z.number().int().positive().nullable(),
      allowedImageMimeTypes: z.array(z.string()),
      allowedVideoMimeTypes: z.array(z.string()),
    })
    .partial()
    .optional(),
});

export type PlatformCapabilities = z.infer<typeof platformCapabilitiesSchema>;

export type CapabilityMatrix = Record<Platform, PlatformCapabilities>;

/** Chỉ `SUPPORTED` mới được coi là dùng được. `UNVERIFIED` KHÔNG phải "có". */
export function isCapabilityUsable(capability: Capability | undefined): boolean {
  return capability?.state === 'SUPPORTED' || capability?.state === 'CONDITIONAL';
}

/**
 * Lý do hiển thị cho người dùng khi một tính năng bị chặn.
 * Trả `null` khi tính năng dùng được.
 */
export function capabilityBlockReason(capability: Capability | undefined): string | null {
  switch (capability?.state) {
    case 'SUPPORTED':
    case 'CONDITIONAL':
      return null;
    case 'UNSUPPORTED':
      return 'Nền tảng này không hỗ trợ chức năng đó qua API chính thức.';
    case 'UNVERIFIED':
    case undefined:
      return 'Chức năng này chưa được xác minh với tài liệu API chính thức của nền tảng.';
    default:
      return 'Chức năng này hiện không khả dụng.';
  }
}

/** Giá trị khởi tạo an toàn: chưa xác minh thì không được coi là hỗ trợ. */
export const UNVERIFIED_CAPABILITY: Capability = { state: 'UNVERIFIED' };

export function createUnverifiedCapabilities(): Record<CapabilityKey, Capability> {
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, { ...UNVERIFIED_CAPABILITY }]),
  ) as Record<CapabilityKey, Capability>;
}
