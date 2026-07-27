import type { Capability, CapabilityKey, WorkspaceRole } from '@socialhub/shared';
import type { Platform, SocialAccountStatus } from '@socialhub/shared';
import type { MediaType, PlatformPostStatus, PostStatus } from '@socialhub/shared';

export interface UserView {
  id: string;
  email: string;
  name: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: WorkspaceRole;
}

export interface AuthPayload {
  user: UserView;
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  expiresAt: string;
  devInvitationToken?: string;
  resent?: boolean;
}

export interface AuditLogItem {
  id: string;
  action: string;
  actorUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface SocialAccountView {
  id: string;
  platform: Platform;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  status: SocialAccountStatus;
  scopes: string[];
  lastSyncedAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  data: unknown;
  readAt: string | null;
  createdAt: string;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  expiresInSeconds: number;
  developmentFixture: boolean;
}

export interface PlatformCapabilitiesView {
  platform: Platform;
  label: string;
  capabilities: Record<CapabilityKey, Capability>;
  limits?: {
    captionMaxLength?: number | null;
    titleMaxLength?: number | null;
    maxHashtags?: number | null;
    maxImagesPerPost?: number | null;
    imageMaxBytes?: number | null;
    videoMaxBytes?: number | null;
    videoMinDurationSec?: number | null;
    videoMaxDurationSec?: number | null;
    allowedImageMimeTypes?: string[];
    allowedVideoMimeTypes?: string[];
  };
}

export interface MediaAssetView {
  id: string;
  type: MediaType;
  status: string;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt?: string;
  position?: number;
  readUrl?: string | null;
}

export interface PlatformPostView {
  id: string;
  platform: Platform;
  status: PlatformPostStatus;
  socialAccountId: string;
  socialAccountName: string;
  externalPostId: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ContentPostView {
  id: string;
  status: PostStatus;
  title: string | null;
  body: string | null;
  linkUrl: string | null;
  hashtags: string[];
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  derivedStatus: PostStatus;
  platformPosts: PlatformPostView[];
  media: MediaAssetView[];
  jobs: BackgroundJobView[];
  links: { web: string };
}

export interface BackgroundJobView {
  id: string;
  queueName: string;
  jobId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  isDead: boolean;
  correlationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentTagView {
  id: string;
  name: string;
  color: string;
  createdAt?: string;
}

export interface CommentAssignmentView {
  id: string;
  memberId: string;
  assignedToId: string;
  assignedToName: string | null;
  assignedToEmail: string;
  assignedById: string;
  assignedAt: string;
  resolvedAt: string | null;
}

export interface CommentNoteView {
  id: string;
  body: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentReplyView {
  id: string;
  message: string;
  status: string;
  sentById: string;
  sentByName: string | null;
  sentByEmail: string;
  externalReplyId: string | null;
  sentAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentView {
  id: string;
  platform: Platform;
  platformPostId: string;
  contentPostId: string;
  contentPostTitle: string | null;
  socialAccountId: string;
  socialAccountName: string;
  externalCommentId: string;
  parentId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  message: string | null;
  likeCount: number | null;
  postedAt: string;
  status: 'OPEN' | 'PENDING' | 'RESOLVED';
  isHidden: boolean;
  isFromPage: boolean;
  createdAt: string;
  updatedAt: string;
  assignment: CommentAssignmentView | null;
  tags: CommentTagView[];
  notes: CommentNoteView[];
  replies: CommentReplyView[];
}

export interface ReplyTemplateView {
  id: string;
  workspaceId: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
