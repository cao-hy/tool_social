import { z } from 'zod';

/**
 * Năm nền tảng trong phạm vi dự án.
 *
 * Đây là nguồn sự thật duy nhất. Thêm nền tảng mới = thêm một giá trị ở đây,
 * sau đó TypeScript sẽ chỉ ra mọi chỗ cần bổ sung (capability matrix, adapter
 * registry, label...) thay vì để lọt.
 */
export const PLATFORMS = ['FACEBOOK', 'INSTAGRAM', 'PINTEREST', 'YOUTUBE', 'TIKTOK'] as const;

export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

export const PLATFORM_LABELS: Record<Platform, string> = {
  FACEBOOK: 'Facebook Page',
  INSTAGRAM: 'Instagram Business',
  PINTEREST: 'Pinterest Business',
  YOUTUBE: 'YouTube',
  TIKTOK: 'TikTok',
};

/** Trạng thái kết nối của một social account trong hệ thống. */
export const SOCIAL_ACCOUNT_STATUSES = [
  'CONNECTED',
  'NEEDS_RECONNECT',
  'DISCONNECTED',
  'ERROR',
] as const;

export type SocialAccountStatus = (typeof SOCIAL_ACCOUNT_STATUSES)[number];

export const socialAccountStatusSchema = z.enum(SOCIAL_ACCOUNT_STATUSES);

/** Loại media hệ thống hỗ trợ. */
export const MEDIA_TYPES = ['IMAGE', 'VIDEO'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
