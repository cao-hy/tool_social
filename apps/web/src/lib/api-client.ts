import type { ApiResponse, NetworkProxyPolicyItem, WorkspaceRole } from '@socialhub/shared';
import type {
  AuditLogItem,
  AnalyticsDashboardView,
  AuthPayload,
  JobActivityView,
  OAuthStartResult,
  CommentTagView,
  CommentNoteView,
  CommentView,
  ContentPostView,
  DeletePostResult,
  MediaLibraryItem,
  MediaAssetView,
  NotificationView,
  PlatformCapabilitiesView,
  PlatformPostState,
  ReplyTemplateView,
  SocialAccountView,
  StorageUsageView,
  TikTokCreatorInfoView,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceSummary,
} from './types';

/**
 * Client gọi API.
 *
 * `credentials: 'include'` là bắt buộc: session nằm trong HTTP-only cookie, và
 * frontend KHÔNG BAO GIỜ giữ token (SECURITY.md §2.3 quy tắc 1). Cách này đồng
 * nghĩa trình duyệt tự gửi cookie, còn JavaScript thì không đọc được nó — kể cả
 * khi có lỗ hổng XSS.
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function getApiBaseUrl(): string {
  // Next.js thay biến NEXT_PUBLIC_* lúc build; đọc trực tiếp là cách duy nhất
  // để việc thay thế đó hoạt động (không dùng được @socialhub/config ở client).
  // eslint-disable-next-line no-restricted-properties
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) {
    throw new Error(
      'Thiếu NEXT_PUBLIC_API_BASE_URL. Sao chép .env.example thành .env trước khi chạy.',
    );
  }
  return url.replace(/\/$/, '');
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${getApiBaseUrl()}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  const body = (await response.json()) as ApiResponse<T>;

  if (!body.success) {
    throw new ApiClientError(
      body.error.code,
      body.error.message,
      response.status,
      body.error.details,
      body.meta.requestId,
    );
  }

  return body.data;
}

export const authApi = {
  me: () => apiFetch<AuthPayload>('/auth/me'),
  login: (input: { email: string; password: string }) =>
    apiFetch<AuthPayload>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  register: (input: { email: string; password: string; name?: string; workspaceName?: string }) =>
    apiFetch<AuthPayload>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => apiFetch<{ loggedOut: true }>('/auth/logout', { method: 'POST' }),
  forgotPassword: (input: { email: string }) =>
    apiFetch<{ accepted: true; devResetToken?: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  resetPassword: (input: { token: string; password: string }) =>
    apiFetch<{ changed: true }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export const systemApi = {
  getNetworkStatus: (workspaceId: string) =>
    apiFetch<{
      ip: string;
      countryCode: string | null;
      country: string;
      city: string;
      isp: string;
      provider: string | null;
      checkOk: boolean;
      checkError: string | null;
      checkErrors: string[];
      proxyConfig: {
        enabled: boolean;
        countryLock: string | null;
        proxyUrlMasked?: string | null;
        source?: 'WORKSPACE' | 'ENV' | 'DIRECT';
      };
      proxyAvailable: boolean;
      proxyActive: boolean;
      countryLockSatisfied: boolean;
    }>(`/workspaces/${workspaceId}/system/network`),
  getProxyPolicy: (workspaceId: string) =>
    apiFetch<{
      generatedAt: string;
      proxyConfig: {
        enabled: boolean;
        countryLock: string | null;
        proxyUrlMasked?: string | null;
        source?: 'WORKSPACE' | 'ENV' | 'DIRECT';
      };
      proxyAvailable: boolean;
      summary: { total: number; proxied: number; direct: number };
      items: NetworkProxyPolicyItem[];
    }>(`/workspaces/${workspaceId}/system/proxy-policy`),
  toggleProxy: (
    workspaceId: string,
    input: { enabled?: boolean; countryLock?: string | null; proxyUrl?: string | null },
  ) =>
    apiFetch<{
      enabled: boolean;
      countryLock: string | null;
      proxyUrlMasked?: string | null;
      source?: 'WORKSPACE' | 'ENV' | 'DIRECT';
    }>(`/workspaces/${workspaceId}/system/proxy`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export const workspaceApi = {
  list: () => apiFetch<{ items: WorkspaceSummary[] }>('/workspaces'),
  create: (input: { name: string; timezone: string }) =>
    apiFetch<WorkspaceSummary>('/workspaces', { method: 'POST', body: JSON.stringify(input) }),
  get: (workspaceId: string) => apiFetch<WorkspaceSummary>(`/workspaces/${workspaceId}`),
  update: (workspaceId: string, input: { name?: string; timezone?: string }) =>
    apiFetch<WorkspaceSummary>(`/workspaces/${workspaceId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  members: (workspaceId: string) =>
    apiFetch<{ items: WorkspaceMember[] }>(`/workspaces/${workspaceId}/members`),
  invite: (workspaceId: string, input: { email: string; role: WorkspaceRole }) =>
    apiFetch<WorkspaceInvitation>(`/workspaces/${workspaceId}/invitations`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  changeRole: (workspaceId: string, memberId: string, role: WorkspaceRole) =>
    apiFetch<WorkspaceMember>(`/workspaces/${workspaceId}/members/${memberId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeMember: (workspaceId: string, memberId: string) =>
    apiFetch<{ removed: true }>(`/workspaces/${workspaceId}/members/${memberId}`, {
      method: 'DELETE',
    }),
  acceptInvitation: (token: string) =>
    apiFetch<WorkspaceSummary>('/workspaces/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  auditLogs: (workspaceId: string) =>
    apiFetch<{ items: AuditLogItem[] }>(`/workspaces/${workspaceId}/audit-logs`),
};

export const socialAccountsApi = {
  list: (workspaceId: string) =>
    apiFetch<{ items: SocialAccountView[] }>(`/workspaces/${workspaceId}/social-accounts`),
  startOAuth: (workspaceId: string, platform: string) =>
    apiFetch<OAuthStartResult>(
      `/workspaces/${workspaceId}/social-accounts/oauth/${platform}/authorize`,
      { method: 'POST' },
    ),
  disconnect: (workspaceId: string, socialAccountId: string) =>
    apiFetch<{ disconnected: true }>(
      `/workspaces/${workspaceId}/social-accounts/${socialAccountId}`,
      { method: 'DELETE' },
    ),
  testConnection: (workspaceId: string, socialAccountId: string) =>
    apiFetch<{ ok: true; checkedAt: string; profile: { name: string; username?: string } }>(
      `/workspaces/${workspaceId}/social-accounts/${socialAccountId}/test`,
      { method: 'POST' },
    ),
  tiktokCreatorInfo: (workspaceId: string, socialAccountId: string) =>
    apiFetch<TikTokCreatorInfoView>(
      `/workspaces/${workspaceId}/social-accounts/${socialAccountId}/tiktok/creator-info`,
      { method: 'POST' },
    ),
};

export const platformsApi = {
  capabilities: () =>
    apiFetch<{
      platforms: PlatformCapabilitiesView[];
      verificationProgress: unknown;
      policyExcludedActions: { actions: readonly string[]; reason: string };
    }>('/platforms/capabilities'),
};

export const notificationsApi = {
  list: (workspaceId: string, query?: { unreadOnly?: boolean; limit?: number }) => {
    const params = new URLSearchParams();
    if (query?.unreadOnly !== undefined) params.set('unreadOnly', String(query.unreadOnly));
    if (query?.limit) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<{ items: NotificationView[] }>(
      `/workspaces/${workspaceId}/notifications${suffix}`,
    );
  },
  markRead: (workspaceId: string, notificationId: string) =>
    apiFetch<{ updated: number }>(
      `/workspaces/${workspaceId}/notifications/${notificationId}/read`,
      { method: 'PATCH' },
    ),
  markAllRead: (workspaceId: string) =>
    apiFetch<{ updated: number }>(`/workspaces/${workspaceId}/notifications/read-all`, {
      method: 'PATCH',
    }),
};

export const jobsApi = {
  activity: (workspaceId: string, query?: { limit?: number; includeCompleted?: boolean }) => {
    const params = new URLSearchParams();
    if (query?.limit) params.set('limit', String(query.limit));
    if (query?.includeCompleted !== undefined) {
      params.set('includeCompleted', String(query.includeCompleted));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<JobActivityView>(`/workspaces/${workspaceId}/jobs/activity${suffix}`);
  },
  clearFailed: (workspaceId: string) =>
    apiFetch<{ cleared: true }>(`/workspaces/${workspaceId}/jobs/failed`, { method: 'DELETE' }),
};

export const analyticsApi = {
  dashboard: (
    workspaceId: string,
    query?: { from?: string; to?: string; platform?: string; socialAccountId?: string },
  ) => {
    const params = new URLSearchParams();
    if (query?.from) params.set('from', query.from);
    if (query?.to) params.set('to', query.to);
    if (query?.platform) params.set('platform', query.platform);
    if (query?.socialAccountId) params.set('socialAccountId', query.socialAccountId);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<AnalyticsDashboardView>(`/workspaces/${workspaceId}/analytics${suffix}`);
  },
  sync: (
    workspaceId: string,
    input?: { platformPostIds?: string[]; platform?: string; socialAccountId?: string },
  ) =>
    apiFetch<{ queued: number; postMetricsQueued: number; accountMetricsQueued: number }>(
      `/workspaces/${workspaceId}/analytics/sync`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    ),
};

export const mediaApi = {
  usage: (workspaceId: string) =>
    apiFetch<StorageUsageView>(`/workspaces/${workspaceId}/media/usage`),
  list: (
    workspaceId: string,
    query?: {
      q?: string;
      type?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (query?.q) params.set('q', query.q);
    if (query?.type) params.set('type', query.type);
    if (query?.status) params.set('status', query.status);
    if (query?.cursor) params.set('cursor', query.cursor);
    if (query?.limit) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<{ items: MediaLibraryItem[]; nextCursor: string | null }>(
      `/workspaces/${workspaceId}/media${suffix}`,
    );
  },
  createUpload: (
    workspaceId: string,
    input: { fileName: string; sizeBytes: number; declaredMimeType: string },
  ) =>
    apiFetch<{ mediaAsset: MediaAssetView; uploadUrl: string; expiresInSeconds: number }>(
      `/workspaces/${workspaceId}/media/uploads`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  createMultipartUpload: (
    workspaceId: string,
    input: { fileName: string; sizeBytes: number; declaredMimeType: string },
  ) =>
    apiFetch<{
      mediaAsset: MediaAssetView;
      uploadId: string;
      partSizeBytes: number;
      parts: Array<{ partNumber: number; uploadUrl: string }>;
      expiresInSeconds: number;
    }>(`/workspaces/${workspaceId}/media/uploads/multipart`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  confirmUpload: (workspaceId: string, mediaAssetId: string) =>
    apiFetch<MediaAssetView>(`/workspaces/${workspaceId}/media/${mediaAssetId}/confirm`, {
      method: 'POST',
    }),
  completeMultipartUpload: (
    workspaceId: string,
    mediaAssetId: string,
    input: { uploadId: string; parts: Array<{ partNumber: number; etag: string }> },
  ) =>
    apiFetch<MediaAssetView>(
      `/workspaces/${workspaceId}/media/${mediaAssetId}/multipart/complete`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  abortMultipartUpload: (workspaceId: string, mediaAssetId: string, input: { uploadId: string }) =>
    apiFetch<{ aborted: boolean }>(
      `/workspaces/${workspaceId}/media/${mediaAssetId}/multipart/abort`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  regenerateThumbnail: (workspaceId: string, mediaAssetId: string) =>
    apiFetch<MediaAssetView>(
      `/workspaces/${workspaceId}/media/${mediaAssetId}/thumbnail/regenerate`,
      {
        method: 'POST',
      },
    ),
  get: (workspaceId: string, mediaAssetId: string) =>
    apiFetch<MediaAssetView>(`/workspaces/${workspaceId}/media/${mediaAssetId}`),
  uploadObject: (workspaceId: string, mediaAssetId: string, file: File) =>
    apiFetch<{ uploaded: true }>(`/workspaces/${workspaceId}/media/${mediaAssetId}/object`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  delete: (workspaceId: string, mediaAssetId: string) =>
    apiFetch<{ deleted: true }>(`/workspaces/${workspaceId}/media/${mediaAssetId}`, {
      method: 'DELETE',
    }),
  archive: (workspaceId: string, mediaAssetId: string) =>
    apiFetch<{ archived: true }>(`/workspaces/${workspaceId}/media/${mediaAssetId}/archive`, {
      method: 'POST',
    }),
};

export const postsApi = {
  list: (
    workspaceId: string,
    query?: {
      status?: string;
      platform?: string;
      socialAccountId?: string;
      q?: string;
      dateFrom?: string;
      dateTo?: string;
      sortBy?: 'createdAt' | 'updatedAt';
      direction?: 'asc' | 'desc';
      cursor?: string;
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (query?.status) params.set('status', query.status);
    if (query?.platform) params.set('platform', query.platform);
    if (query?.socialAccountId) params.set('socialAccountId', query.socialAccountId);
    if (query?.q) params.set('q', query.q);
    if (query?.dateFrom) params.set('dateFrom', query.dateFrom);
    if (query?.dateTo) params.set('dateTo', query.dateTo);
    if (query?.sortBy) params.set('sortBy', query.sortBy);
    if (query?.direction) params.set('direction', query.direction);
    if (query?.cursor) params.set('cursor', query.cursor);
    if (query?.limit) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<{
      items: ContentPostView[];
      nextCursor: string | null;
      statusCounts: Record<string, number>;
    }>(`/workspaces/${workspaceId}/posts${suffix}`);
  },
  get: (workspaceId: string, postId: string) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts/${postId}`),
  create: (
    workspaceId: string,
    input: {
      title?: string;
      body?: string;
      linkUrl?: string;
      hashtags: string[];
      socialAccountIds: string[];
      mediaAssetIds?: string[];
      platformOverrides?: PlatformOverrideInput[];
      scheduledAt?: string;
    },
  ) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  publish: (workspaceId: string, postId: string, socialAccountIds?: string[]) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts/${postId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ socialAccountIds }),
    }),
  schedule: (
    workspaceId: string,
    postId: string,
    input: { scheduledAt: string; socialAccountIds?: string[] },
  ) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts/${postId}/schedule`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  retry: (workspaceId: string, postId: string) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts/${postId}/retry`, {
      method: 'POST',
    }),
  duplicate: (workspaceId: string, postId: string) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts/${postId}/duplicate`, {
      method: 'POST',
    }),
  update: (
    workspaceId: string,
    postId: string,
    input: {
      title?: string;
      body?: string;
      linkUrl?: string;
      hashtags?: string[];
      socialAccountIds?: string[];
      mediaAssetIds?: string[];
      platformOverrides?: PlatformOverrideInput[];
    },
  ) =>
    apiFetch<ContentPostView>(`/workspaces/${workspaceId}/posts/${postId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  delete: (
    workspaceId: string,
    postId: string,
    options?: { deleteFromPlatforms?: boolean; platformPostIds?: string[] },
  ) => {
    const params = new URLSearchParams();
    if (options?.deleteFromPlatforms !== undefined) {
      params.set('deleteFromPlatforms', String(options.deleteFromPlatforms));
    }
    if (options?.platformPostIds) {
      params.set('platformPostIds', options.platformPostIds.join(','));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<DeletePostResult>(`/workspaces/${workspaceId}/posts/${postId}${suffix}`, {
      method: 'DELETE',
    });
  },
  bulkDelete: (workspaceId: string, input: { postIds: string[]; deleteFromPlatforms?: boolean }) =>
    apiFetch<{
      requested: number;
      deleted: number;
      failed: number;
      results: Array<{
        postId: string;
        deleted: boolean;
        errorCode?: string;
        errorMessage?: string;
      }>;
    }>(`/workspaces/${workspaceId}/posts/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  refreshPlatformState: (workspaceId: string, postId: string, platformPostId: string) =>
    apiFetch<{ post: ContentPostView; platformState: PlatformPostState }>(
      `/workspaces/${workspaceId}/posts/${postId}/platform-posts/${platformPostId}/refresh-state`,
      { method: 'POST' },
    ),
  makeYouTubePublic: (workspaceId: string, postId: string, platformPostId: string) =>
    apiFetch<{ post: ContentPostView; platformState: PlatformPostState }>(
      `/workspaces/${workspaceId}/posts/${postId}/platform-posts/${platformPostId}/youtube/make-public`,
      { method: 'POST' },
    ),
  cancelTikTokPublish: (workspaceId: string, postId: string, platformPostId: string) =>
    apiFetch<{ post: ContentPostView; platformState: PlatformPostState }>(
      `/workspaces/${workspaceId}/posts/${postId}/platform-posts/${platformPostId}/tiktok/cancel`,
      { method: 'POST' },
    ),
};

export interface PlatformOverrideInput {
  socialAccountId: string;
  caption?: string;
  title?: string;
  description?: string;
  linkUrl?: string;
  mediaAssetIds?: string[];
  options?: Record<string, unknown>;
}

export const commentsApi = {
  list: (
    workspaceId: string,
    query?: {
      status?: string;
      platform?: string;
      socialAccountId?: string;
      assignedToId?: string;
      tagId?: string;
      q?: string;
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (query?.status) params.set('status', query.status);
    if (query?.platform) params.set('platform', query.platform);
    if (query?.socialAccountId) params.set('socialAccountId', query.socialAccountId);
    if (query?.assignedToId) params.set('assignedToId', query.assignedToId);
    if (query?.tagId) params.set('tagId', query.tagId);
    if (query?.q) params.set('q', query.q);
    if (query?.limit) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return apiFetch<{ items: CommentView[] }>(`/workspaces/${workspaceId}/comments${suffix}`);
  },
  get: (workspaceId: string, commentId: string) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}`),
  updateStatus: (workspaceId: string, commentId: string, status: CommentView['status']) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  assign: (workspaceId: string, commentId: string, memberId: string | null) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}/assignment`, {
      method: 'PATCH',
      body: JSON.stringify({ memberId }),
    }),
  updateTags: (workspaceId: string, commentId: string, tagIds: string[]) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}/tags`, {
      method: 'PATCH',
      body: JSON.stringify({ tagIds }),
    }),
  updateMessage: (
    workspaceId: string,
    commentId: string,
    input: { message: string; updatePlatform?: boolean },
  ) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}/message`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  updateVisibility: (workspaceId: string, commentId: string, hidden: boolean) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
  delete: (workspaceId: string, commentId: string, deleteFromPlatform = true) =>
    apiFetch<{ deleted: true }>(
      `/workspaces/${workspaceId}/comments/${commentId}?deleteFromPlatform=${String(
        deleteFromPlatform,
      )}`,
      { method: 'DELETE' },
    ),
  addNote: (workspaceId: string, commentId: string, body: string) =>
    apiFetch<CommentNoteView>(`/workspaces/${workspaceId}/comments/${commentId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  reply: (workspaceId: string, commentId: string, message: string) =>
    apiFetch<CommentView>(`/workspaces/${workspaceId}/comments/${commentId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  sync: (
    workspaceId: string,
    input: { socialAccountId: string; platformPostId?: string; since?: string },
  ) =>
    apiFetch<{ queued: true; jobId: string }>(`/workspaces/${workspaceId}/comments/sync`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listTags: (workspaceId: string) =>
    apiFetch<{ items: CommentTagView[] }>(`/workspaces/${workspaceId}/comments/tags`),
  createTag: (workspaceId: string, input: { name: string; color: string }) =>
    apiFetch<CommentTagView>(`/workspaces/${workspaceId}/comments/tags`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listTemplates: (workspaceId: string) =>
    apiFetch<{ items: ReplyTemplateView[] }>(`/workspaces/${workspaceId}/comments/templates`),
  createTemplate: (workspaceId: string, input: { name: string; body: string }) =>
    apiFetch<ReplyTemplateView>(`/workspaces/${workspaceId}/comments/templates`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateTemplate: (
    workspaceId: string,
    templateId: string,
    input: { name?: string; body?: string },
  ) =>
    apiFetch<ReplyTemplateView>(`/workspaces/${workspaceId}/comments/templates/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteTemplate: (workspaceId: string, templateId: string) =>
    apiFetch<{ deleted: true }>(`/workspaces/${workspaceId}/comments/templates/${templateId}`, {
      method: 'DELETE',
    }),
};
