import type {
  MediaType,
  Paginated,
  Platform,
  PostMetrics,
  AccountMetrics,
} from '@socialhub/shared';

/**
 * Kiểu dữ liệu thống nhất mà mọi adapter phải nói.
 *
 * Đây là "hợp đồng" giữa phần lõi hệ thống và thế giới bên ngoài. Lưu ý rằng
 * unified schema luôn là một PHÉP CHIẾU CÓ MẤT MÁT (lossy projection) — nền
 * tảng nào cũng có khái niệm riêng không ánh xạ được. Chỗ nào mất mát thì phải
 * thể hiện tường minh (bằng `null` + MetricSource, hoặc bằng capability
 * UNSUPPORTED), tuyệt đối không lấp bằng giá trị bịa ra.
 */

/**
 * Ngữ cảnh truyền cho mỗi lời gọi adapter.
 *
 * Adapter KHÔNG giữ state và KHÔNG chạm vào database (ARCHITECTURE.md §1 P2).
 * Nó nhận token đã giải mã sẵn và trả về dữ liệu; việc lưu trữ là của service.
 */
export interface AdapterContext {
  /** Access token đã giải mã. Chỉ tồn tại trong phạm vi lời gọi này. */
  readonly accessToken: string;
  readonly externalAccountId: string;
  readonly externalPageId?: string;
  /** Để truy vết một hành động xuyên api → queue → worker → adapter. */
  readonly correlationId: string;
  readonly logger?: AdapterLogger;
}

export interface AdapterLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Thời điểm hết hạn tuyệt đối. Adapter tự quy đổi từ `expires_in` tương đối. */
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
  scopes: string[];
  tokenType?: string;
  /**
   * Một số nền tảng trả đủ profile account ngay trong bước đổi token.
   * Service dùng field này để tránh gọi thêm mạng trong OAuth callback.
   */
  accountProfile?: SocialAccountProfile;
}

export interface AuthUrlInput {
  redirectUri: string;
  /** State chống CSRF, do service sinh và lưu Redis. */
  state: string;
  scopes: string[];
  /** PKCE challenge, nếu nền tảng hỗ trợ. */
  codeChallenge?: string;
}

export interface SocialAccountProfile {
  externalAccountId: string;
  externalPageId?: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  profileUrl?: string;
  followersCount?: number;
}

export interface MediaInput {
  type: MediaType;
  /** URL tải được của media. Xem lưu ý về bucket private trong docs §7. */
  url: string;
  /**
   * Bytes của media khi adapter cần upload binary trực tiếp lên nền tảng.
   * Bắt buộc với storage private/local vì nền tảng không thể fetch URL nội bộ.
   */
  bytes?: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  altText?: string;
}

export interface PublishPostInput {
  caption?: string;
  title?: string;
  description?: string;
  linkUrl?: string;
  hashtags?: string[];
  media: MediaInput[];
  thumbnail?: MediaInput;
  /** Tuỳ chọn riêng của từng nền tảng, do PlatformPost.options lưu lại. */
  options?: Record<string, unknown>;
  /** Chỉ dùng khi nền tảng có native scheduling VÀ capability đã xác minh. */
  scheduledAt?: Date;
}

export interface PublishResult {
  externalPostId: string;
  externalUrl?: string;
  publishedAt: Date;
  /** true khi nền tảng nhận bài nhưng chưa đăng xong (đang xử lý video...). */
  pending?: boolean;
}

export interface EditPostInput {
  caption?: string;
  title?: string;
  description?: string;
  linkUrl?: string;
  hashtags?: string[];
  mediaTypes?: MediaType[];
  options?: Record<string, unknown>;
}

export interface ValidationIssue {
  field: string;
  message: string;
  /** Giới hạn thực tế của nền tảng — hiển thị cho người dùng biết phải sửa gì. */
  limit?: string | number;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface SyncPostsParams {
  cursor?: string;
  limit?: number;
  since?: Date;
}

export interface SyncCommentsParams {
  externalPostId?: string;
  cursor?: string;
  limit?: number;
  since?: Date;
}

export interface PlatformPostData {
  externalPostId: string;
  externalUrl?: string;
  caption?: string;
  title?: string;
  mediaType?: MediaType;
  thumbnailUrl?: string;
  publishedAt: Date;
}

export interface PlatformComment {
  externalCommentId: string;
  externalPostId: string;
  parentExternalCommentId?: string;
  authorExternalId?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  message?: string;
  likeCount?: number;
  postedAt: Date;
  isHidden?: boolean;
  /** Comment do chính page/channel đăng — không cần hiện trong hàng chờ trả lời. */
  isFromOwner?: boolean;
}

export interface CommentReplyResult {
  externalReplyId: string;
  sentAt: Date;
}

export interface NormalizedWebhookEvent {
  externalEventId: string;
  eventType: string;
  externalAccountId?: string;
  externalPostId?: string;
  externalCommentId?: string;
  occurredAt: Date;
  raw: unknown;
}

export type { AccountMetrics, Paginated, Platform, PostMetrics };
