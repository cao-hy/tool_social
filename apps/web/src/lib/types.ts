import type { WorkspaceRole } from '@socialhub/shared';
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
  links: { web: string };
}
