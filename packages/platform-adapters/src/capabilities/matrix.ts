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

CAPABILITY_MATRIX.FACEBOOK.capabilities.hideComment = {
  state: 'CONDITIONAL',
  condition:
    'Ẩn/hiện comment trên Page post bằng Page access token có pages_manage_engagement và comment thuộc Page quản lý.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/comment/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.deleteComment = {
  state: 'CONDITIONAL',
  condition:
    'Xóa comment trên Page post bằng DELETE /{comment-id} với Page access token có pages_manage_engagement; một số loại comment có thể bị Meta từ chối.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/comment/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.editPublishedPost = {
  state: 'CONDITIONAL',
  condition:
    'Chỉ cập nhật message/link của Page post do Page quản lý, bằng Page access token có pages_manage_posts.',
  source: 'https://developers.facebook.com/documentation/pages-api/posts',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Pages API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.deletePublishedPost = {
  state: 'CONDITIONAL',
  condition:
    'Chỉ xóa Page post do Page quản lý, bằng DELETE /{page_post_id} với Page access token có pages_manage_posts.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/page-post/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta PagePost docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.postLikes = {
  state: 'CONDITIONAL',
  condition:
    'Đọc reaction count của Page post bằng reactions.limit(0).summary(true) với Page access token có pages_read_engagement.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/object/reactions/',
  verifiedAt: '2026-08-01',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.postCommentCount = {
  state: 'CONDITIONAL',
  condition:
    'Đọc comment count của Page post bằng comments.limit(0).summary(true) với Page access token có pages_read_engagement.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/object/comments/',
  verifiedAt: '2026-08-01',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.postShares = {
  state: 'CONDITIONAL',
  condition:
    'Đọc share count của Page post qua field shares khi Graph API trả dữ liệu cho object đó.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/page-post/',
  verifiedAt: '2026-08-01',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.postReach = {
  state: 'CONDITIONAL',
  condition:
    'Đọc reach bằng Page post insight post_impressions_unique; token cần quyền read_insights/pages_read_engagement và Meta có thể trả rỗng nếu dữ liệu chưa sẵn sàng.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/insights/',
  verifiedAt: '2026-08-01',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.FACEBOOK.capabilities.postImpressions = {
  state: 'CONDITIONAL',
  condition:
    'Đọc impressions bằng Page post insight post_impressions; token cần quyền read_insights/pages_read_engagement và Meta có thể trả rỗng nếu dữ liệu chưa sẵn sàng.',
  source: 'https://developers.facebook.com/docs/graph-api/reference/insights/',
  verifiedAt: '2026-08-01',
  verifiedBy: 'Codex + Meta Graph API docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.publishImage = {
  state: 'CONDITIONAL',
  condition:
    'Đăng ảnh lên Instagram professional account bằng Content Publishing API qua media container + media_publish; token cần instagram_content_publish.',
  source: 'https://developers.facebook.com/documentation/instagram-platform/content-publishing',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Content Publishing docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.publishMultipleImages = {
  state: 'CONDITIONAL',
  condition:
    'Đăng carousel tối đa 10 media bằng child containers và container media_type=CAROUSEL; media URL phải public HTTPS.',
  source: 'https://developers.facebook.com/documentation/instagram-platform/content-publishing',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Content Publishing docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.publishVideo = {
  state: 'CONDITIONAL',
  condition:
    'Đăng video/Reels qua Content Publishing API; media URL phải public HTTPS và tài khoản là Business/Creator được kết nối.',
  source: 'https://developers.facebook.com/documentation/instagram-platform/content-publishing',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Content Publishing docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.editPublishedPost = {
  state: 'UNSUPPORTED',
  condition:
    'Instagram Media API không hỗ trợ sửa caption/media bài đã publish; POST /{ig_media_id} chỉ dùng cho bật/tắt comments.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Media docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.deletePublishedPost = {
  state: 'UNSUPPORTED',
  condition:
    'Meta Instagram Media reference ghi rõ deleting IG Media không được hỗ trợ qua API chính thức.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media',
  verifiedAt: '2026-08-02',
  verifiedBy: 'Codex + Meta Instagram Media docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.readComments = {
  state: 'CONDITIONAL',
  condition:
    'Đọc comments của media thuộc tài khoản đã kết nối bằng /{ig_media_id}/comments; token cần instagram_manage_comments.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/comments',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Comments docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.replyToComment = {
  state: 'CONDITIONAL',
  condition:
    'Trả lời comment Instagram bằng /{ig_comment_id}/replies; token cần instagram_manage_comments.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-comment/replies',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Comment docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.hideComment = {
  state: 'CONDITIONAL',
  condition:
    'Ẩn/hiện comment trên Instagram media thuộc tài khoản Business/Creator bằng Instagram Comment Moderation API.',
  source: 'https://developers.facebook.com/documentation/instagram-platform/comment-moderation',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Comment Moderation docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.deleteComment = {
  state: 'CONDITIONAL',
  condition:
    'Xóa comment trên Instagram media thuộc tài khoản Business/Creator bằng Instagram Comment Moderation API.',
  source: 'https://developers.facebook.com/documentation/instagram-platform/comment-moderation',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Comment Moderation docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postViews = {
  state: 'CONDITIONAL',
  condition:
    'Đọc plays/video_views qua media insights khi metric khả dụng với loại media và token có instagram_manage_insights.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Insights docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postLikes = {
  state: 'CONDITIONAL',
  condition: 'Đọc like_count từ IG Media fields cho media thuộc tài khoản đã kết nối.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Media docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postCommentCount = {
  state: 'CONDITIONAL',
  condition: 'Đọc comments_count từ IG Media fields cho media thuộc tài khoản đã kết nối.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Media docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postShares = {
  state: 'CONDITIONAL',
  condition:
    'Đọc shares qua media insights khi metric khả dụng với loại media và token có instagram_manage_insights.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Insights docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postReach = {
  state: 'CONDITIONAL',
  condition:
    'Đọc reach qua media insights khi metric khả dụng với loại media và token có instagram_manage_insights.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Insights docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postImpressions = {
  state: 'CONDITIONAL',
  condition:
    'Đọc impressions qua media insights khi metric khả dụng với loại media và token có instagram_manage_insights.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Insights docs',
};

CAPABILITY_MATRIX.INSTAGRAM.capabilities.postSaves = {
  state: 'CONDITIONAL',
  condition:
    'Đọc saved qua media insights khi metric khả dụng với loại media và token có instagram_manage_insights.',
  source:
    'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + Meta Instagram Insights docs',
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

CAPABILITY_MATRIX.PINTEREST.capabilities.editPublishedPost = {
  state: 'CONDITIONAL',
  condition:
    'Cập nhật metadata Pin bằng PATCH /v5/pins/{pin_id}; endpoint đang beta và không khả dụng cho mọi app, chỉ cập nhật các trường như title, description, link, board/section, alt text.',
  source: 'https://developer.pinterest.com/docs/api/v5/pins-update/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.deletePublishedPost = {
  state: 'CONDITIONAL',
  condition:
    'Xóa Pin thuộc operation user_account hoặc group board được chia sẻ bằng DELETE /v5/pins/{pin_id}; token cần pins:write và quyền phù hợp trên board.',
  source: 'https://developer.pinterest.com/docs/api/v5/pins-delete/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.refreshToken = {
  state: 'SUPPORTED',
  source:
    'https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/',
  verifiedAt: '2026-07-28',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.postViews = {
  state: 'CONDITIONAL',
  condition:
    'Video views đọc qua organic Pin analytics metric VIDEO_MRC_VIEW/VIDEO_10S_VIEW; image Pin không có view metric riêng nên adapter giữ null thay vì dùng impression làm view.',
  source: 'https://developers.pinterest.com/docs/analytics-and-reports/metrics-glossary/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.postLikes = {
  state: 'CONDITIONAL',
  condition:
    'Pinterest không dùng like chuẩn; adapter map total reactions/lifetime reaction của Pin sang metric likes/reactions.',
  source: 'https://developer.pinterest.com/docs/api/v5/pins-get/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.postCommentCount = {
  state: 'CONDITIONAL',
  condition:
    'Get/List Pin với pin_metrics=true có lifetime comment count, nhưng Pinterest không expose endpoint đọc nội dung comment cho adapter này.',
  source: 'https://developer.pinterest.com/docs/api/v5/pins-list/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.postShares = {
  state: 'UNSUPPORTED',
  condition:
    'Pinterest organic Pin analytics cung cấp saves, Pin clicks và outbound clicks; không có metric share tương đương trong API v5 cho adapter này.',
  source: 'https://developers.pinterest.com/docs/analytics-and-reports/metrics-glossary/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.postImpressions = {
  state: 'CONDITIONAL',
  condition:
    'Đọc impression bằng Get Pin analytics hoặc pin_metrics=true trên Get/List Pin; organic reporting hỗ trợ lookback 90 ngày và lifetime cho phần lớn Pin.',
  source: 'https://developers.pinterest.com/docs/analytics-and-reports/organic-reporting/',
  verifiedAt: '2026-07-31',
  verifiedBy: 'Codex + Pinterest API v5 docs',
};

CAPABILITY_MATRIX.PINTEREST.capabilities.postSaves = {
  state: 'CONDITIONAL',
  condition:
    'Đọc saves qua organic Pin analytics metric SAVE cho Pin thuộc operation user_account hoặc group board được chia sẻ.',
  source: 'https://developers.pinterest.com/docs/analytics-and-reports/organic-reporting/',
  verifiedAt: '2026-07-31',
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

CAPABILITY_MATRIX.YOUTUBE.capabilities.editComment = {
  state: 'CONDITIONAL',
  condition:
    'Sửa nội dung comment/reply bằng comments.update; token cần youtube.force-ssl và request chỉ thành công nếu tài khoản có quyền sửa comment đó.',
  source: 'https://developers.google.com/youtube/v3/docs/comments/update',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.hideComment = {
  state: 'CONDITIONAL',
  condition:
    'Ẩn comment bằng comments.setModerationStatus với moderationStatus=rejected; hiện lại bằng published. Token cần youtube.force-ssl và quyền moderation trên channel/video.',
  source: 'https://developers.google.com/youtube/v3/docs/comments/setModerationStatus',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.deleteComment = {
  state: 'CONDITIONAL',
  condition:
    'Xóa comment/reply do chính channel gửi bằng comments.delete; comment của người xem được xử lý bằng moderation reject.',
  source: 'https://developers.google.com/youtube/v3/docs/comments/delete',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.editPublishedPost = {
  state: 'CONDITIONAL',
  condition:
    'Cập nhật metadata video bằng videos.update; token cần scope youtube.force-ssl và video phải thuộc channel đã kết nối.',
  source: 'https://developers.google.com/youtube/v3/docs/videos/update',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.YOUTUBE.capabilities.deletePublishedPost = {
  state: 'CONDITIONAL',
  condition:
    'Xóa video bằng videos.delete; token cần scope youtube.force-ssl/youtube và video phải thuộc channel đã kết nối.',
  source: 'https://developers.google.com/youtube/v3/docs/videos/delete',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + YouTube Data API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.publishVideo = {
  state: 'CONDITIONAL',
  condition:
    'TikTok video hỗ trợ Direct Post qua /v2/post/publish/video/init/ với scope video.publish, hoặc Upload to Inbox qua /v2/post/publish/inbox/video/init/ với scope video.upload. Client chưa audit có thể bị giới hạn private viewing mode.',
  source: 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + TikTok Content Posting API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.publishImage = {
  state: 'CONDITIONAL',
  condition:
    'TikTok photo post dùng /v2/post/publish/content/init/ với media_type PHOTO. Ảnh chỉ hỗ trợ PULL_FROM_URL: URL phải public HTTPS và domain/prefix phải được verify trong TikTok Developer Portal.',
  source: 'https://developers.tiktok.com/doc/content-posting-api-reference-photo-post/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + TikTok Content Posting API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.postViews = {
  state: 'CONDITIONAL',
  condition: 'Đọc view_count qua Display API /v2/video/query/ khi token có scope video.list.',
  source: 'https://developers.tiktok.com/doc/tiktok-api-v2-video-query/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + TikTok Display API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.postLikes = {
  state: 'CONDITIONAL',
  condition: 'Đọc like_count qua Display API /v2/video/query/ khi token có scope video.list.',
  source: 'https://developers.tiktok.com/doc/tiktok-api-v2-video-query/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + TikTok Display API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.postCommentCount = {
  state: 'CONDITIONAL',
  condition: 'Đọc comment_count qua Display API /v2/video/query/ khi token có scope video.list.',
  source: 'https://developers.tiktok.com/doc/tiktok-api-v2-video-query/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + TikTok Display API docs',
};

CAPABILITY_MATRIX.TIKTOK.capabilities.postShares = {
  state: 'CONDITIONAL',
  condition: 'Đọc share_count qua Display API /v2/video/query/ khi token có scope video.list.',
  source: 'https://developers.tiktok.com/doc/tiktok-api-v2-video-query/',
  verifiedAt: '2026-07-30',
  verifiedBy: 'Codex + TikTok Display API docs',
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
