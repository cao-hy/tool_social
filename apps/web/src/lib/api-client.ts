import type { ApiResponse } from '@socialhub/shared';
import type { WorkspaceRole } from '@socialhub/shared';
import type {
  AuditLogItem,
  AuthPayload,
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
