import { PLATFORMS, type Platform } from '@socialhub/shared';
import {
  createUnverifiedCapabilityTable,
  type PlatformCapabilityTable,
} from '../core/capability-table';

/**
 * CAPABILITY MATRIX — nguồn sự thật runtime.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ TOÀN BỘ các ô hiện đang ở trạng thái UNVERIFIED. ĐÂY LÀ CỐ Ý.            │
 * │                                                                          │
 * │ prompt.txt §7: "Không được điền dựa trên phỏng đoán."                    │
 * │ prompt.txt §21: "Mọi chức năng phụ thuộc xét duyệt ứng dụng phải được    │
 * │                  đánh dấu rõ."                                           │
 * │                                                                          │
 * │ Một ô chỉ được rời khỏi UNVERIFIED khi có ĐỦ BA THỨ:                     │
 * │   1. `source`     — URL tài liệu API chính thức                          │
 * │   2. `verifiedAt` — ngày kiểm chứng (ISO)                                │
 * │   3. `verifiedBy` — tên người kiểm chứng                                 │
 * │                                                                          │
 * │ KHÔNG chấp nhận: trí nhớ, blog post, StackOverflow, hay output của mô     │
 * │ hình ngôn ngữ. Quy trình cập nhật: docs/SOCIAL_API_CAPABILITIES.md §9.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Hệ quả thực tế trong khi mọi ô còn UNVERIFIED:
 *   • `isCapabilityUsable()` trả false → UI ẩn/disable mọi tính năng nền tảng.
 *   • Service từ chối gọi adapter với lỗi CAPABILITY_UNSUPPORTED.
 * Đây là hành vi ĐÚNG: hệ thống không hứa những gì chưa ai kiểm chứng.
 */
export const CAPABILITY_MATRIX: Record<Platform, PlatformCapabilityTable> = Object.fromEntries(
  PLATFORMS.map((platform) => [platform, createUnverifiedCapabilityTable(platform)]),
) as Record<Platform, PlatformCapabilityTable>;

CAPABILITY_MATRIX.FACEBOOK.capabilities.readComments = {
  state: 'CONDITIONAL',
  condition:
    'Chỉ đọc comment trên Page post có externalPostId đã lưu, bằng Page access token có pages_read_user_content hoặc app có Page Public Content Access.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/comment/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.replyToComment = {
  state: 'CONDITIONAL',
  condition:
    'Chỉ reply comment bằng Page access token có pages_manage_engagement, trên comment thuộc Page/app được phép quản lý.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/comment/comments/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Meta Graph API docs',
};

export function getCapabilityTable(platform: Platform): PlatformCapabilityTable {
  return CAPABILITY_MATRIX[platform];
}

/**
 * Hành động bị CHÍNH SÁCH DỰ ÁN loại trừ, không phải bị API giới hạn.
 *
 * prompt.txt §3 cấm giả lập hành vi người dùng. Danh sách này tồn tại để việc
 * loại trừ là tường minh và kiểm tra được bằng test, thay vì chỉ là một sự vắng
 * mặt im lặng mà người sau có thể vô tình "bổ sung".
 *
 * Like và share CHỈ tồn tại trong hệ thống dưới dạng METRIC ĐỌC.
 */
export const POLICY_EXCLUDED_ACTIONS = [
  'likePost',
  'unlikePost',
  'sharePost',
  'repost',
  'followAccount',
  'unfollowAccount',
  'autoComment',
  'bulkComment',
] as const;

export type PolicyExcludedAction = (typeof POLICY_EXCLUDED_ACTIONS)[number];

export const POLICY_EXCLUSION_REASON =
  'Hành động này bị loại trừ theo chính sách dự án (prompt §3: không giả lập hành vi người dùng), không phụ thuộc vào việc API có hỗ trợ hay không.';

/** Tổng quan tiến độ xác minh — dùng cho báo cáo và cho endpoint capabilities. */
export function getVerificationProgress(): Record<
  Platform,
  { verified: number; total: number; percent: number }
> {
  const entries = PLATFORMS.map((platform) => {
    const table = CAPABILITY_MATRIX[platform];
    const values = Object.values(table.capabilities);
    const verified = values.filter((c) => c.state !== 'UNVERIFIED').length;
    return [
      platform,
      {
        verified,
        total: values.length,
        percent: values.length === 0 ? 0 : Math.round((verified / values.length) * 100),
      },
    ] as const;
  });
  return Object.fromEntries(entries) as Record<
    Platform,
    { verified: number; total: number; percent: number }
  >;
}
