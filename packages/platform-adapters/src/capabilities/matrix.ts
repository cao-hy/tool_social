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

CAPABILITY_MATRIX.PINTEREST.capabilities.publishImage = {
  state: 'CONDITIONAL',
  condition:
    'Tạo Pin ảnh bằng POST /v5/pins với board_id và media_source image_base64/image_url; token cần boards:read, boards:write, pins:read, pins:write.',
  source: 'https://developers.pinterest.com/docs/api/v5/pins-create/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.publishWithLink = {
  state: 'CONDITIONAL',
  condition: 'Pinterest Create Pin hỗ trợ trường link khi tạo Pin ảnh; link phải là URL hợp lệ.',
  source: 'https://developers.pinterest.com/docs/api/v5/pins-create/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.publishVideo = {
  state: 'CONDITIONAL',
  condition:
    'Video Pin dùng flow media upload: POST /media, upload multipart lên upload_url, poll media status, rồi POST /pins với media_source video_id. Cần cover_image_url public.',
  source:
    'https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.refreshToken = {
  state: 'SUPPORTED',
  source:
    'https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.readComments = {
  state: 'UNSUPPORTED',
  condition:
    'Pinterest API v5 docs expose Pin/board/media/metrics APIs but no official organic Pin comment read endpoint for this adapter.',
  source: 'https://developers.pinterest.com/docs/api/v5/pins-get/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.replyToComment = {
  state: 'UNSUPPORTED',
  condition: 'Pinterest API v5 docs do not expose an official organic Pin comment reply endpoint.',
  source: 'https://developers.pinterest.com/docs/api/v5/pins-get/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.publishVideo = {
  state: 'CONDITIONAL',
  condition:
    'Upload video bằng YouTube Data API videos.insert với OAuth scope youtube.upload. Scope youtube.readonly dùng để lấy channel profile; youtube.force-ssl dùng cho videos.update để đổi privacy. Dự án Google chưa audit có thể bị YouTube ép video ở chế độ private.',
  source: 'https://developers.google.com/youtube/v3/docs/videos/insert',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.postTitle = {
  state: 'SUPPORTED',
  source: 'https://developers.google.com/youtube/v3/docs/videos/insert',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.refreshToken = {
  state: 'SUPPORTED',
  source: 'https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + YouTube OAuth docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.revokeToken = {
  state: 'SUPPORTED',
  source: 'https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Google OAuth docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.readComments = {
  state: 'CONDITIONAL',
  condition:
    'Đọc comment của video đã có externalPostId bằng commentThreads.list; adapter sync theo từng video của social account đã kết nối.',
  source: 'https://developers.google.com/youtube/v3/guides/implementation/comments',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.replyToComment = {
  state: 'SUPPORTED',
  source: 'https://developers.google.com/youtube/v3/docs/comments/insert',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.publishVideo = {
  state: 'CONDITIONAL',
  condition:
    'TikTok Direct Post dùng Content Posting API /v2/post/publish/video/init/ với scope video.publish. Client chưa audit có thể bị giới hạn private viewing mode.',
  source: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + TikTok Content Posting API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.refreshToken = {
  state: 'SUPPORTED',
  source: 'https://developers.tiktok.com/doc/oauth-user-access-token-management',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + TikTok OAuth v2 docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.revokeToken = {
  state: 'SUPPORTED',
  source: 'https://developers.tiktok.com/doc/oauth-user-access-token-management',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + TikTok OAuth v2 docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.readComments = {
  state: 'UNSUPPORTED',
  condition:
    'TikTok public Content Posting/Display APIs do not expose organic comment inbox endpoints. TikTok Business API has separate owned-account comment endpoints and auth model, not implemented in this adapter.',
  source: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + TikTok Developer docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.replyToComment = {
  state: 'UNSUPPORTED',
  condition:
    'Organic comment reply is not available in TikTok public Content Posting API; Business API comment management is a separate integration.',
  source: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + TikTok Developer docs',
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
