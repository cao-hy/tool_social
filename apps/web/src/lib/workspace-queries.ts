import type { QueryClient } from '@tanstack/react-query';
import {
  analyticsApi,
  mediaApi,
  platformsApi,
  postsApi,
  socialAccountsApi,
  storesApi,
  workspaceApi,
} from './api-client';

export interface PostsListCacheParams {
  status?: string;
  storeId?: string;
  platform?: string;
  socialAccountId?: string;
  mediaType?: 'IMAGE' | 'VIDEO' | 'NONE';
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: 'createdAt' | 'updatedAt';
  direction?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

export interface AnalyticsCacheParams {
  from?: string;
  to?: string;
  storeId?: string;
  platform?: string;
  socialAccountId?: string;
}

export interface MediaListCacheParams {
  limit?: number;
  cursor?: string;
  storeId?: string;
  q?: string;
  type?: string;
  status?: string;
}

export const workspaceQueryKeys = {
  all: (workspaceId: string) => ['workspace', workspaceId] as const,
  stores: (workspaceId: string) => ['workspace', workspaceId, 'stores'] as const,
  socialAccounts: (workspaceId: string) => ['workspace', workspaceId, 'social-accounts'] as const,
  capabilities: () => ['platforms', 'capabilities'] as const,
  postsRoot: (workspaceId: string) => ['workspace', workspaceId, 'posts'] as const,
  postsList: (workspaceId: string, params: PostsListCacheParams) =>
    ['workspace', workspaceId, 'posts', 'list', params] as const,
  calendarPosts: (workspaceId: string, storeId?: string) =>
    ['workspace', workspaceId, 'posts', 'calendar', storeId ?? 'all'] as const,
  analyticsRoot: (workspaceId: string) => ['workspace', workspaceId, 'analytics'] as const,
  analyticsDashboard: (workspaceId: string, params: AnalyticsCacheParams) =>
    ['workspace', workspaceId, 'analytics', 'dashboard', params] as const,
  members: (workspaceId: string) => ['workspace', workspaceId, 'members'] as const,
  auditLogs: (workspaceId: string) => ['workspace', workspaceId, 'audit-logs'] as const,
  mediaRoot: (workspaceId: string) => ['workspace', workspaceId, 'media'] as const,
  mediaUsage: (workspaceId: string) => ['workspace', workspaceId, 'media', 'usage'] as const,
  mediaList: (workspaceId: string, params: MediaListCacheParams) =>
    ['workspace', workspaceId, 'media', 'list', params] as const,
};

export const SHARED_META_STALE_TIME = 2 * 60_000;
export const CAPABILITIES_STALE_TIME = 15 * 60_000;

export function prefetchWorkspaceSharedMeta(queryClient: QueryClient, workspaceId: string) {
  void queryClient.prefetchQuery({
    queryKey: workspaceQueryKeys.stores(workspaceId),
    queryFn: () => storesApi.list(workspaceId),
    staleTime: SHARED_META_STALE_TIME,
  });
  void queryClient.prefetchQuery({
    queryKey: workspaceQueryKeys.socialAccounts(workspaceId),
    queryFn: () => socialAccountsApi.list(workspaceId),
    staleTime: SHARED_META_STALE_TIME,
  });
}

export function prefetchWorkspaceTabData(
  queryClient: QueryClient,
  workspaceId: string | null,
  href: string,
  activeStoreId?: string | null,
) {
  if (!workspaceId) return;

  if (href === '/posts') {
    prefetchWorkspaceSharedMeta(queryClient, workspaceId);
    void queryClient.prefetchQuery({
      queryKey: workspaceQueryKeys.capabilities(),
      queryFn: () => platformsApi.capabilities(),
      staleTime: CAPABILITIES_STALE_TIME,
    });
    if (activeStoreId) {
      const defaultParams: PostsListCacheParams = {
        storeId: activeStoreId,
        sortBy: 'createdAt',
        direction: 'desc',
        limit: 20,
        cursor: undefined,
      };
      void queryClient.prefetchQuery({
        queryKey: workspaceQueryKeys.postsList(workspaceId, defaultParams),
        queryFn: () => postsApi.list(workspaceId, defaultParams),
      });
    }
    return;
  }

  if (href === '/calendar') {
    if (activeStoreId) {
      void queryClient.prefetchQuery({
        queryKey: workspaceQueryKeys.calendarPosts(workspaceId, activeStoreId),
        queryFn: () => postsApi.list(workspaceId, { storeId: activeStoreId, limit: 100 }),
      });
    }
    return;
  }

  if (href === '/posts/new' || href === '/accounts') {
    prefetchWorkspaceSharedMeta(queryClient, workspaceId);
    return;
  }

  if (href === '/analytics') {
    prefetchWorkspaceSharedMeta(queryClient, workspaceId);
    const defaultAnalyticsParams: AnalyticsCacheParams = {};
    void queryClient.prefetchQuery({
      queryKey: workspaceQueryKeys.analyticsDashboard(workspaceId, defaultAnalyticsParams),
      queryFn: () => analyticsApi.dashboard(workspaceId, defaultAnalyticsParams),
    });
    return;
  }

  if (href === '/team') {
    void queryClient.prefetchQuery({
      queryKey: workspaceQueryKeys.members(workspaceId),
      queryFn: () => workspaceApi.members(workspaceId),
    });
    return;
  }

  if (href === '/settings') {
    void queryClient.prefetchQuery({
      queryKey: workspaceQueryKeys.mediaUsage(workspaceId),
      queryFn: () => mediaApi.usage(workspaceId),
    });
    const defaultMediaParams: MediaListCacheParams = { limit: 20 };
    void queryClient.prefetchQuery({
      queryKey: workspaceQueryKeys.mediaList(workspaceId, defaultMediaParams),
      queryFn: () => mediaApi.list(workspaceId, defaultMediaParams),
    });
  }
}
