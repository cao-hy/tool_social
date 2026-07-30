import type { CapabilityKey, DateRange, Paginated, Platform } from '@socialhub/shared';
import type {
  AccountMetrics,
  AdapterContext,
  AuthUrlInput,
  CommentReplyResult,
  NormalizedWebhookEvent,
  PlatformComment,
  PlatformPostData,
  PostMetrics,
  EditPostInput,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  SyncCommentsParams,
  SyncPostsParams,
  TokenSet,
  ValidationResult,
} from './types';
import type { PlatformCapabilityTable } from './capability-table';

/**
 * Interface chung cho mọi nền tảng.
 *
 * Mở rộng từ `prompt.txt` §6. Bốn khác biệt so với bản gốc, kèm lý do —
 * ARCHITECTURE.md §5.1 giải thích đầy đủ:
 *
 *  1. `connectAccount()` được tách thành `buildAuthorizationUrl` +
 *     `exchangeCodeForToken`, vì OAuth là luồng hai bước qua trình duyệt và
 *     không thể gói vào một `Promise<void>`.
 *  2. Mọi method nhận `AdapterContext` thay vì adapter tự giữ token. Adapter
 *     phải phi trạng thái để test được mà không cần DB.
 *  3. Thêm `validatePost` đồng bộ để UI kiểm tra trước khi submit, không tốn quota.
 *  4. `getPosts`/`getComments` trả `Paginated<T>` thay vì mảng phẳng — sync cần cursor.
 *
 * Các method có dấu `?` là OPTIONAL vì không nền tảng nào hỗ trợ đủ.
 * Việc chúng optional là hiện thực trực tiếp của prompt §7 (capability matrix)
 * chứ không phải sự lười biếng của thiết kế.
 */
export interface SocialPlatformAdapter {
  readonly platform: Platform;

  /**
   * Nguồn sự thật về những gì adapter này làm được.
   * Test đối chiếu bảng này với các method thực sự tồn tại — code và tài liệu
   * không thể trôi khỏi nhau.
   */
  readonly capabilities: PlatformCapabilityTable;

  /* ------------------------------------------------------------------ OAuth */

  buildAuthorizationUrl(input: AuthUrlInput): string;
  exchangeCodeForToken(code: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet>;
  refreshToken?(refreshToken: string): Promise<TokenSet>;
  revokeToken?(token: string): Promise<void>;

  /* ---------------------------------------------------------------- Account */

  getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile>;
  getAccountMetrics?(ctx: AdapterContext, range: DateRange): Promise<AccountMetrics>;

  /* ---------------------------------------------------------------- Publish */

  /** Đồng bộ, không gọi mạng — kiểm tra luật riêng của nền tảng. */
  validatePost(input: PublishPostInput): ValidationResult;
  publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult>;
  editPost?(ctx: AdapterContext, externalPostId: string, input: EditPostInput): Promise<void>;
  deletePost?(ctx: AdapterContext, externalPostId: string): Promise<void>;

  /* ------------------------------------------------------------------- Read */

  getPosts(ctx: AdapterContext, params: SyncPostsParams): Promise<Paginated<PlatformPostData>>;
  getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics>;

  /* --------------------------------------------------------------- Comments */

  getComments?(
    ctx: AdapterContext,
    params: SyncCommentsParams,
  ): Promise<Paginated<PlatformComment>>;
  replyToComment?(
    ctx: AdapterContext,
    externalCommentId: string,
    message: string,
  ): Promise<CommentReplyResult>;
  editComment?(ctx: AdapterContext, externalCommentId: string, message: string): Promise<void>;
  deleteComment?(ctx: AdapterContext, externalCommentId: string): Promise<void>;
  hideComment?(ctx: AdapterContext, externalCommentId: string, hidden: boolean): Promise<void>;

  /* ---------------------------------------------------------------- Webhook */

  verifyWebhookSignature?(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  parseWebhookEvents?(payload: unknown): NormalizedWebhookEvent[];
}

/**
 * Method optional nào tương ứng với capability nào.
 *
 * Bảng này làm cho quy tắc "code phải khớp capability matrix" thành thứ kiểm
 * tra được tự động, thay vì một dòng ghi chú trong tài liệu mà không ai đọc.
 */
export const OPTIONAL_METHOD_CAPABILITY_MAP = {
  editPost: 'editPublishedPost',
  replyToComment: 'replyToComment',
  editComment: 'editComment',
  deleteComment: 'deleteComment',
  hideComment: 'hideComment',
  deletePost: 'deletePublishedPost',
  refreshToken: 'refreshToken',
  revokeToken: 'revokeToken',
} as const satisfies Record<string, CapabilityKey>;

export type OptionalAdapterMethod = keyof typeof OPTIONAL_METHOD_CAPABILITY_MAP;
