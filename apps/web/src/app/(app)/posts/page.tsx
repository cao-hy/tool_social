'use client';

import { useQueryClient } from '@tanstack/react-query';
import { hasPermission, PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Copy,
  Download,
  Eye,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/form-controls';
import {
  BulkPostCommentModal,
  isCreateCommentSupportedPlatform,
} from '@/components/bulk-post-comment-modal';
import { DeletePostDialog } from '@/components/delete-post-dialog';
import { PostCommentsDrawer } from '@/components/post-comments-drawer';
import {
  extractYouTubeEmbedUrl,
  FallbackImage,
  mediaPreviewSources,
  mediaThumbnailSources,
} from '@/components/media-preview';
import { useToast } from '@/components/toast-provider';
import { useWorkspaceEventSubscription } from '@/components/workspace-events-provider';
import { platformsApi, postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { rowsToCsv } from '@/lib/csv';
import { getErrorMessage } from '@/lib/errors';
import {
  aggregatePlatformMetrics,
  formatMetricNumber,
  hasVisibleMetrics,
} from '@/lib/post-metrics';
import { useActiveStore } from '@/lib/store-context';
import type { ContentPostView, DeletePostResult, PlatformCapabilitiesView } from '@/lib/types';
import {
  CAPABILITIES_STALE_TIME,
  workspaceQueryKeys,
  type PostsListCacheParams,
} from '@/lib/workspace-queries';

const POST_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'PROCESSING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
] as const;

const DEFAULT_PAGE_SIZE = 20;
const DELETABLE_POST_STATUSES = [
  'DRAFT',
  'FAILED',
  'SCHEDULED',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'QUEUED',
  'PROCESSING',
  'CANCELLED',
] as const;

type BulkDeleteProgressStatus = 'PENDING' | 'RUNNING' | 'QUEUED' | 'DONE' | 'ERROR';
type PostMediaFilter = '' | 'VIDEO' | 'IMAGE' | 'NONE';

const MEDIA_FILTER_LABELS: Record<Exclude<PostMediaFilter, ''>, string> = {
  VIDEO: 'Video',
  IMAGE: 'Hình ảnh',
  NONE: 'Không có media',
};

interface BulkDeleteProgressItem {
  postId: string;
  title: string;
  status: BulkDeleteProgressStatus;
  errorMessage?: string;
}

interface PostsListCachedData {
  items: ContentPostView[];
  statusCounts: Record<string, number>;
  nextCursor: string | null;
}

const INITIAL_POSTS_CACHE_PARAMS: PostsListCacheParams = {
  sortBy: 'createdAt',
  direction: 'desc',
  limit: DEFAULT_PAGE_SIZE,
  cursor: undefined,
};

export default function PostsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const storeCtx = useActiveStore();
  const { activeStore, activeStoreId, stores, accounts } = storeCtx;
  const storeId = activeStoreId ?? '';
  const initialPostsCache =
    workspace && storeId
      ? queryClient.getQueryData<PostsListCachedData>(
          workspaceQueryKeys.postsList(workspace.id, {
            ...INITIAL_POSTS_CACHE_PARAMS,
            storeId,
          }),
        )
      : undefined;
  const [posts, setPosts] = useState<ContentPostView[]>(() => initialPostsCache?.items ?? []);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>(
    () => initialPostsCache?.statusCounts ?? {},
  );
  const [capabilityByPlatform, setCapabilityByPlatform] = useState<
    Partial<Record<Platform, PlatformCapabilitiesView>>
  >(() => {
    const cached = queryClient.getQueryData<{ platforms: PlatformCapabilitiesView[] }>(
      workspaceQueryKeys.capabilities(),
    );
    if (!cached) return {};
    return Object.fromEntries(cached.platforms.map((item) => [item.platform, item])) as Partial<
      Record<Platform, PlatformCapabilitiesView>
    >;
  });
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [mediaType, setMediaType] = useState<PostMediaFilter>('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt'>('createdAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(
    () => initialPostsCache?.nextCursor ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContentPostView | null>(null);
  const [selectedPostIds, setSelectedPostIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<BulkDeleteProgressItem[]>([]);
  const [previewPost, setPreviewPost] = useState<ContentPostView | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncFilterStoreId, setSyncFilterStoreId] = useState('');
  const [syncFilterPlatform, setSyncFilterPlatform] = useState('');
  const [syncCutoffDays, setSyncCutoffDays] = useState<number>(30);
  const [syncSelectedAccountIds, setSyncSelectedAccountIds] = useState<string[]>([]);
  const [syncingExternalPosts, setSyncingExternalPosts] = useState(false);

  const [commentModalPosts, setCommentModalPosts] = useState<ContentPostView[]>([]);
  const [commentModalExplicitSelection, setCommentModalExplicitSelection] = useState(false);
  const [loadingCommentModal, setLoadingCommentModal] = useState(false);
  const [activeCommentsPost, setActiveCommentsPost] = useState<ContentPostView | null>(null);

  const activeFilters = useMemo(
    () => ({
      status: status || undefined,
      storeId: storeId || undefined,
      platform: platform || undefined,
      mediaType: mediaType || undefined,
      q: debouncedQuery.trim() || undefined,
      dateFrom: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
      dateTo: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
      sortBy,
      direction,
      limit: pageSize,
    }),
    [
      dateFrom,
      dateTo,
      debouncedQuery,
      direction,
      mediaType,
      pageSize,
      platform,
      sortBy,
      status,
      storeId,
    ],
  );
  const selectedPosts = useMemo(
    () => posts.filter((post) => selectedPostIds.includes(post.id)),
    [posts, selectedPostIds],
  );
  const deletablePosts = useMemo(
    () => posts.filter((post) => canDeletePostStatus(post.status)),
    [posts],
  );
  const selectedDeletablePosts = useMemo(
    () => selectedPosts.filter((post) => canDeletePostStatus(post.status)),
    [selectedPosts],
  );

  const realtimeReloadTimerRef = useRef<number | null>(null);

  async function loadPosts(cursor?: string, options?: { silent?: boolean; useCache?: boolean }) {
    if (!workspace) return;
    if (storeCtx.loading && !storeId) return;
    if (!storeId && stores.length > 0) {
      setPosts([]);
      setStatusCounts({});
      setNextCursor(null);
      return;
    }
    const listParams: PostsListCacheParams = { ...activeFilters, cursor };
    const queryKey = workspaceQueryKeys.postsList(workspace.id, listParams);
    const cached = queryClient.getQueryData<PostsListCachedData>(queryKey);

    if (cached) {
      setPosts(cached.items);
      setStatusCounts(cached.statusCounts);
      setNextCursor(cached.nextCursor);
    }

    const shouldBlockUi = !options?.silent && !cached;
    if (shouldBlockUi) setLoading(true);
    setError(null);
    try {
      const result = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => postsApi.list(workspace.id, listParams),
        staleTime: options?.useCache ? 60_000 : 0,
      });
      setPosts(result.items);
      setStatusCounts(result.statusCounts);
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      if (!options?.silent) setError(getErrorMessage(loadError));
    } finally {
      if (shouldBlockUi) setLoading(false);
    }
  }

  function scheduleSilentReload(delayMs = 500) {
    if (realtimeReloadTimerRef.current !== null) {
      window.clearTimeout(realtimeReloadTimerRef.current);
    }
    realtimeReloadTimerRef.current = window.setTimeout(() => {
      realtimeReloadTimerRef.current = null;
      void loadPosts(cursorStack.at(-1), { silent: true });
    }, delayMs);
  }

  useWorkspaceEventSubscription((event) => {
    if (event.type === 'comment.created' && event.platformPostId) {
      const targetId = event.platformPostId;
      setPosts((prev) =>
        prev.map((post) =>
          post.platformPosts.some((pp) => pp.id === targetId)
            ? {
                ...post,
                platformPosts: post.platformPosts.map((pp) =>
                  pp.id === targetId ? { ...pp, commentCount: (pp.commentCount ?? 0) + 1 } : pp,
                ),
              }
            : post,
        ),
      );
      setActiveCommentsPost((prev) =>
        prev && prev.platformPosts.some((pp) => pp.id === targetId)
          ? {
              ...prev,
              platformPosts: prev.platformPosts.map((pp) =>
                pp.id === targetId ? { ...pp, commentCount: (pp.commentCount ?? 0) + 1 } : pp,
              ),
            }
          : prev,
      );
      scheduleSilentReload(900);
      return;
    }

    if (
      event.type === 'comment.replied' ||
      event.type === 'comments.synced' ||
      event.type === 'posts.changed' ||
      event.type === 'metrics.synced' ||
      event.type === 'stream.reconnected'
    ) {
      scheduleSilentReload(500);
    }
  });

  useEffect(() => {
    return () => {
      if (realtimeReloadTimerRef.current !== null) {
        window.clearTimeout(realtimeReloadTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;
    queryClient
      .fetchQuery({
        queryKey: workspaceQueryKeys.capabilities(),
        queryFn: () => platformsApi.capabilities(),
        staleTime: CAPABILITIES_STALE_TIME,
      })
      .then((capabilityResult) => {
        setCapabilityByPlatform(
          Object.fromEntries(
            capabilityResult.platforms.map((item) => [item.platform, item]),
          ) as Partial<Record<Platform, PlatformCapabilitiesView>>,
        );
      })
      .catch((loadError) => setError(getErrorMessage(loadError)));
  }, [queryClient, workspace]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query), 350);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    setCursorStack([]);
    setSelectedPostIds([]);
    void loadPosts(undefined, { useCache: true });
  }, [workspace, activeFilters, storeCtx.loading, stores.length]);

  useEffect(() => {
    if (!workspace) return;
    const currentParams: PostsListCacheParams = {
      ...activeFilters,
      cursor: cursorStack.at(-1),
    };
    const key = workspaceQueryKeys.postsList(workspace.id, currentParams);
    if (queryClient.getQueryData(key) !== undefined) {
      queryClient.setQueryData<PostsListCachedData>(key, {
        items: posts,
        statusCounts,
        nextCursor,
      });
    }
  }, [activeFilters, cursorStack, nextCursor, posts, queryClient, statusCounts, workspace]);

  useEffect(() => {
    const visiblePostIds = new Set(posts.map((post) => post.id));
    setSelectedPostIds((current) => current.filter((postId) => visiblePostIds.has(postId)));
  }, [posts]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('created')) {
      toast.success('Đã lưu draft.');
    }
    if (params.has('queued')) {
      toast.info('Đã đưa bài vào queue publish.');
    }
    if (params.has('created') || params.has('queued')) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }
  }, [toast]);

  async function retry(postId: string) {
    if (!workspace) return;
    setRetrying(postId);
    setError(null);
    try {
      await postsApi.retry(workspace.id, postId);
      await loadPosts(cursorStack.at(-1));
      toast.info('Đã đưa bài vào queue retry.');
    } catch (retryError) {
      toast.error(getErrorMessage(retryError));
    } finally {
      setRetrying(null);
    }
  }

  function openDeleteDialog(post: ContentPostView) {
    if (!workspace || !hasPermission(workspace.role, 'post:delete')) {
      toast.warning('Bạn không có quyền xóa bài viết.');
      return;
    }
    if (!canDeletePostStatus(post.status)) {
      toast.warning('Bài này không ở trạng thái có thể xóa.');
      return;
    }
    setDeleteTarget(post);
  }

  async function deletePost(input: { platformPostIds: string[] }) {
    if (!workspace) return;
    if (!deleteTarget || !canDeletePostStatus(deleteTarget.status)) {
      toast.warning('Bài này không ở trạng thái có thể xóa.');
      return;
    }

    setDeleting(deleteTarget.id);
    setError(null);
    try {
      const result = await postsApi.delete(workspace.id, deleteTarget.id, {
        deleteFromPlatforms: input.platformPostIds.length > 0,
        platformPostIds: input.platformPostIds,
      });
      setDeleteTarget(null);
      await loadPosts(cursorStack.at(-1));
      const message = deleteResultMessage(result);
      if (result.deleted) {
        toast.success(message);
      } else if (result.queued) {
        toast.info(message);
      } else if (deleteResultFailures(result).length > 0) {
        toast.warning(message);
      } else {
        toast.success(message);
      }
    } catch (deleteError) {
      toast.error(getErrorMessage(deleteError));
    } finally {
      setDeleting(null);
    }
  }

  function togglePostSelection(post: ContentPostView) {
    if (!canDeletePostStatus(post.status)) return;
    setSelectedPostIds((current) =>
      current.includes(post.id)
        ? current.filter((postId) => postId !== post.id)
        : [...current, post.id],
    );
  }

  function toggleAllVisiblePosts() {
    const deletableIds = deletablePosts.map((post) => post.id);
    const allSelected = deletableIds.every((postId) => selectedPostIds.includes(postId));
    setSelectedPostIds((current) =>
      allSelected
        ? current.filter((postId) => !deletableIds.includes(postId))
        : [...new Set([...current, ...deletableIds])],
    );
  }

  async function bulkDeletePosts(input: {
    deleteFromServer: boolean;
    deleteFromPlatforms: boolean;
  }) {
    if (!workspace) return;
    if (!hasPermission(workspace.role, 'post:delete')) {
      toast.warning('Bạn không có quyền xóa bài viết.');
      return;
    }
    if (!input.deleteFromServer) {
      toast.warning('Hiện tại cần chọn xóa khỏi server/workspace để hoàn tất bulk delete.');
      return;
    }
    const targets = [...selectedDeletablePosts];
    if (targets.length === 0) {
      toast.warning('Chọn ít nhất một bài có thể xóa.');
      return;
    }

    setBulkDeleting(true);
    setError(null);
    setBulkDeleteProgress(
      targets.map((post) => ({
        postId: post.id,
        title: post.title ?? post.body ?? post.id,
        status: 'PENDING',
      })),
    );

    let deleted = 0;
    let queued = 0;
    let failed = 0;
    const failedPostIds = new Set<string>();
    try {
      for (const post of targets) {
        setBulkDeleteProgress((current) =>
          current.map((item) =>
            item.postId === post.id
              ? { ...item, status: 'RUNNING', errorMessage: undefined }
              : item,
          ),
        );

        try {
          const platformPostIds = input.deleteFromPlatforms
            ? post.platformPosts
                .filter((item) => item.status === 'PUBLISHED' && item.externalPostId)
                .map((item) => item.id)
            : [];
          const result = await postsApi.delete(workspace.id, post.id, {
            deleteFromPlatforms: input.deleteFromPlatforms,
            platformPostIds,
          });
          if (result.deleted) {
            deleted += 1;
            setBulkDeleteProgress((current) =>
              current.map((item) => (item.postId === post.id ? { ...item, status: 'DONE' } : item)),
            );
          } else if (result.queued) {
            queued += 1;
            setBulkDeleteProgress((current) =>
              current.map((item) =>
                item.postId === post.id ? { ...item, status: 'QUEUED' } : item,
              ),
            );
          } else {
            failed += 1;
            failedPostIds.add(post.id);
            setBulkDeleteProgress((current) =>
              current.map((item) =>
                item.postId === post.id
                  ? {
                      ...item,
                      status: 'ERROR',
                      errorMessage: deleteResultMessage(result),
                    }
                  : item,
              ),
            );
          }
        } catch (deleteError) {
          failed += 1;
          failedPostIds.add(post.id);
          setBulkDeleteProgress((current) =>
            current.map((item) =>
              item.postId === post.id
                ? {
                    ...item,
                    status: 'ERROR',
                    errorMessage: getErrorMessage(deleteError),
                  }
                : item,
            ),
          );
        }
      }

      setSelectedPostIds((current) => current.filter((postId) => failedPostIds.has(postId)));
      await loadPosts(cursorStack.at(-1));
      if (failed > 0) {
        toast.warning(
          `Đã xử lý ${deleted + queued}/${targets.length} bài (${deleted} đã xóa, ${queued} đang xóa ngầm). ${failed} bài lỗi.`,
        );
      } else if (queued > 0 && deleted > 0) {
        setSelectedPostIds([]);
        toast.info(
          `Đã xóa ${deleted} bài, đưa ${queued} bài vào hàng đợi xóa ngầm trên mạng xã hội.`,
        );
      } else if (queued > 0) {
        setSelectedPostIds([]);
        toast.info(`Đã đưa ${queued} bài vào hàng đợi xóa ngầm trên mạng xã hội.`);
      } else {
        setSelectedPostIds([]);
        toast.success(`Đã xóa ${deleted} bài viết.`);
      }
    } catch (bulkDeleteError) {
      toast.error(getErrorMessage(bulkDeleteError));
    } finally {
      setBulkDeleting(false);
    }
  }

  async function duplicatePost(postId: string) {
    if (!workspace) return;
    setDuplicating(postId);
    setError(null);
    try {
      await postsApi.duplicate(workspace.id, postId);
      await loadPosts(cursorStack.at(-1));
      toast.success('Đã nhân bản bài viết.');
    } catch (duplicateError) {
      toast.error(getErrorMessage(duplicateError));
    } finally {
      setDuplicating(null);
    }
  }

  async function exportCsv() {
    if (!workspace) return;
    setExporting(true);
    setError(null);
    try {
      const result = await postsApi.list(workspace.id, { ...activeFilters, limit: 100 });
      const csv = rowsToCsv(
        result.items.map((post) => ({
          id: post.id,
          title: post.title ?? '',
          status: post.status,
          derivedStatus: post.derivedStatus,
          mediaTypes: [...new Set(post.media.map((item) => item.type))].join('; ') || 'NONE',
          platforms: post.platformPosts.map((item) => item.platform).join('; '),
          accounts: post.platformPosts.map((item) => item.socialAccountName).join('; '),
          scheduledAt: post.scheduledAt ?? '',
          publishedAt: post.publishedAt ?? '',
          createdAt: post.createdAt,
          body: post.body ?? '',
          linkUrl: post.linkUrl ?? '',
        })),
        [
          'id',
          'title',
          'status',
          'derivedStatus',
          'mediaTypes',
          'platforms',
          'accounts',
          'scheduledAt',
          'publishedAt',
          'createdAt',
          'body',
          'linkUrl',
        ],
      );
      downloadCsv(csv, `socialhub-posts-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('Đã xuất CSV.');
    } catch (exportError) {
      toast.error(getErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  }

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canRetry = hasPermission(workspace.role, 'post:publish');
  const canDelete = hasPermission(workspace.role, 'post:delete');
  const canCreate = hasPermission(workspace.role, 'post:create');
  const canSync = hasPermission(workspace.role, 'social_account:sync');
  const canComment = hasPermission(workspace.role, 'comment:reply');

  const syncCandidateAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      if (acc.status !== 'CONNECTED') return false;
      if (syncFilterStoreId === 'UNASSIGNED') {
        if (acc.storeId) return false;
      } else if (syncFilterStoreId && acc.storeId !== syncFilterStoreId) {
        return false;
      }
      if (syncFilterPlatform && acc.platform !== syncFilterPlatform) {
        return false;
      }
      return true;
    });
  }, [accounts, syncFilterPlatform, syncFilterStoreId]);

  const visibleCommentablePosts = useMemo(() => {
    return posts.filter((post) =>
      post.platformPosts.some(
        (pp) =>
          pp.status === 'PUBLISHED' &&
          Boolean(pp.externalPostId) &&
          isCreateCommentSupportedPlatform(pp.platform, capabilityByPlatform),
      ),
    );
  }, [capabilityByPlatform, posts]);

  const selectedCommentableTargets = useMemo(() => {
    return selectedPosts.flatMap((post) =>
      post.platformPosts.filter(
        (pp) =>
          pp.status === 'PUBLISHED' &&
          Boolean(pp.externalPostId) &&
          isCreateCommentSupportedPlatform(pp.platform, capabilityByPlatform),
      ),
    );
  }, [capabilityByPlatform, selectedPosts]);

  const canOpenBulkCommentFromFilter =
    visibleCommentablePosts.length > 0 ||
    (statusCounts.PUBLISHED ?? 0) + (statusCounts.PARTIALLY_PUBLISHED ?? 0) > 0;

  function openSyncPostsModal() {
    const initStoreId = storeId || 'UNASSIGNED';
    const initPlatform = platform || '';
    setSyncFilterStoreId(initStoreId);
    setSyncFilterPlatform(initPlatform);
    const matching = accounts.filter((acc) => {
      if (acc.status !== 'CONNECTED') return false;
      if (initStoreId === 'UNASSIGNED') {
        if (acc.storeId) return false;
      } else if (initStoreId && acc.storeId !== initStoreId) {
        return false;
      }
      if (initPlatform && acc.platform !== initPlatform) {
        return false;
      }
      return true;
    });
    setSyncSelectedAccountIds(matching.map((item) => item.id));
    setSyncModalOpen(true);
  }

  function updateSyncFilters(nextStoreId: string, nextPlatform: string) {
    setSyncFilterStoreId(nextStoreId);
    setSyncFilterPlatform(nextPlatform);
    const matching = accounts.filter((acc) => {
      if (acc.status !== 'CONNECTED') return false;
      if (nextStoreId === 'UNASSIGNED') {
        if (acc.storeId) return false;
      } else if (nextStoreId && acc.storeId !== nextStoreId) {
        return false;
      }
      if (nextPlatform && acc.platform !== nextPlatform) {
        return false;
      }
      return true;
    });
    setSyncSelectedAccountIds(matching.map((item) => item.id));
  }

  async function submitSyncExternalPosts() {
    if (!workspace) return;
    if (syncSelectedAccountIds.length === 0) {
      toast.warning('Vui lòng chọn ít nhất 1 kênh để đồng bộ bài viết.');
      return;
    }
    setSyncingExternalPosts(true);
    setError(null);
    try {
      const res = await socialAccountsApi.syncPostsByFilter(workspace.id, {
        socialAccountIds: syncSelectedAccountIds,
        cutoffDays: syncCutoffDays,
        sinceDate: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
        force: true,
      });
      setSyncModalOpen(false);
      if (res.queuedCount > 0) {
        toast.success(
          `Đã đưa ${res.queuedCount}/${res.matchedCount} kênh vào hàng đợi kéo bài viết! Danh sách sẽ tự động cập nhật sau vài giây.`,
        );
        window.setTimeout(() => void loadPosts(cursorStack.at(-1)), 3500);
        window.setTimeout(() => void loadPosts(cursorStack.at(-1)), 8500);
      } else {
        const reason = res.results[0]?.message ?? 'Không có kênh nào được đưa vào hàng đợi.';
        toast.warning(reason);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSyncingExternalPosts(false);
    }
  }

  async function openCommentModal(explicitPosts?: ContentPostView[]) {
    if (!workspace) return;

    if (explicitPosts && explicitPosts.length > 0) {
      const supportedTargets = explicitPosts.flatMap((post) =>
        post.platformPosts.filter(
          (pp) =>
            pp.status === 'PUBLISHED' &&
            Boolean(pp.externalPostId) &&
            isCreateCommentSupportedPlatform(pp.platform, capabilityByPlatform),
        ),
      );
      if (supportedTargets.length === 0) {
        toast.warning(
          'Các bài đang chọn chưa có kênh nào hỗ trợ API comment tự động (Facebook, Instagram, YouTube).',
        );
        return;
      }
      setCommentModalExplicitSelection(true);
      setCommentModalPosts(explicitPosts);
      return;
    }

    setLoadingCommentModal(true);
    try {
      const collectedById = new Map<string, ContentPostView>();
      let cursor: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const res = await postsApi.list(workspace.id, {
          storeId: storeId || undefined,
          platform: platform || undefined,
          mediaType: mediaType || undefined,
          q: activeFilters.q,
          dateFrom: activeFilters.dateFrom,
          dateTo: activeFilters.dateTo,
          sortBy: activeFilters.sortBy,
          direction: activeFilters.direction,
          limit: 100,
          cursor,
        });
        for (const item of res.items) {
          collectedById.set(item.id, item);
        }
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }

      const collected = Array.from(collectedById.values());

      const supportedTargets = collected.flatMap((post) =>
        post.platformPosts.filter(
          (pp) =>
            pp.status === 'PUBLISHED' &&
            Boolean(pp.externalPostId) &&
            isCreateCommentSupportedPlatform(pp.platform, capabilityByPlatform),
        ),
      );

      if (supportedTargets.length === 0) {
        toast.warning(
          'Không tìm thấy bài viết Đã đăng nào hỗ trợ API comment (Facebook, Instagram, YouTube) trong bộ lọc hiện tại.',
        );
        return;
      }

      setCommentModalExplicitSelection(false);
      setCommentModalPosts(collected);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoadingCommentModal(false);
    }
  }
  const activeAdvancedFilterCount = [
    dateFrom,
    dateTo,
    sortBy !== 'createdAt' ? sortBy : '',
    direction !== 'desc' ? direction : '',
  ].filter(Boolean).length;
  const hasAnyFilter = Boolean(
    status ||
    platform ||
    mediaType ||
    debouncedQuery.trim() ||
    dateFrom ||
    dateTo ||
    sortBy !== 'createdAt' ||
    direction !== 'desc',
  );
  const totalStatusCount = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  const emptyState = hasAnyFilter
    ? {
        title: 'Không có bài nào khớp bộ lọc',
        body: 'Thử xóa bớt filter, đổi khoảng ngày, hoặc tìm bằng từ khóa khác.',
      }
    : {
        title: activeStore
          ? `Store "${activeStore.name}" chưa có bài viết nào`
          : 'Chưa có bài viết nào',
        body: 'Tạo draft đầu tiên cho Store này, hoặc bấm "Đồng bộ bài viết" để kéo bài đã đăng về.',
      };

  const activeFilterChips: Array<{ key: string; label: string; onRemove: () => void }> = [];
  if (debouncedQuery.trim()) {
    activeFilterChips.push({
      key: 'q',
      label: `Từ khóa: "${debouncedQuery.trim()}"`,
      onRemove: () => {
        setQuery('');
        setDebouncedQuery('');
      },
    });
  }
  if (platform) {
    activeFilterChips.push({
      key: 'platform',
      label: `Nền tảng: ${PLATFORM_LABELS[platform as Platform] ?? platform}`,
      onRemove: () => setPlatform(''),
    });
  }
  if (mediaType) {
    activeFilterChips.push({
      key: 'mediaType',
      label: `Media: ${MEDIA_FILTER_LABELS[mediaType]}`,
      onRemove: () => setMediaType(''),
    });
  }
  if (dateFrom) {
    activeFilterChips.push({
      key: 'dateFrom',
      label: `Từ ngày: ${formatDateInputLabel(dateFrom)}`,
      onRemove: () => setDateFrom(''),
    });
  }
  if (dateTo) {
    activeFilterChips.push({
      key: 'dateTo',
      label: `Đến ngày: ${formatDateInputLabel(dateTo)}`,
      onRemove: () => setDateTo(''),
    });
  }
  if (sortBy !== 'createdAt') {
    activeFilterChips.push({
      key: 'sortBy',
      label: 'Sắp xếp: Ngày cập nhật',
      onRemove: () => setSortBy('createdAt'),
    });
  }
  if (direction !== 'desc') {
    activeFilterChips.push({
      key: 'direction',
      label: 'Thứ tự: Cũ nhất trước',
      onRemove: () => setDirection('desc'),
    });
  }

  function applyQuickDatePreset(preset: 'today' | 'last7d' | 'last30d' | 'thisMonth') {
    const now = new Date();
    const todayStr = toLocalDateInputValue(now);
    if (preset === 'today') {
      setDateFrom(todayStr);
      setDateTo(todayStr);
      return;
    }
    if (preset === 'thisMonth') {
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      setDateFrom(toLocalDateInputValue(firstOfMonth));
      setDateTo(todayStr);
      return;
    }
    const daysBack = preset === 'last7d' ? 6 : 29;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
    setDateFrom(toLocalDateInputValue(start));
    setDateTo(todayStr);
  }

  function resetFilters() {
    setStatus('');
    setPlatform('');
    setMediaType('');
    setQuery('');
    setDebouncedQuery('');
    setDateFrom('');
    setDateTo('');
    setSortBy('createdAt');
    setDirection('desc');
    setPageSize(DEFAULT_PAGE_SIZE);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Posts</h1>
          <p className="mt-1 text-sm text-slate-600">
            Quản lý, theo dõi và xuất bản bài đăng trên các nền tảng.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <IconButton
            disabled={loading}
            label="Làm mới"
            onClick={() => void loadPosts(cursorStack.at(-1))}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
          <IconButton disabled={exporting} label="Export CSV" onClick={() => void exportCsv()}>
            <Download className="h-4 w-4" />
          </IconButton>
          {canComment ? (
            <SecondaryButton
              className="h-11 gap-2 border-brand-200 text-brand-700 hover:bg-brand-50"
              disabled={loadingCommentModal || !canOpenBulkCommentFromFilter}
              onClick={() =>
                void openCommentModal(selectedPosts.length > 0 ? selectedPosts : undefined)
              }
              type="button"
            >
              <MessageSquarePlus className="h-4 w-4 text-brand-600" />
              {loadingCommentModal
                ? 'Đang gom bài...'
                : selectedCommentableTargets.length > 0
                  ? `Comment hàng loạt (${selectedCommentableTargets.length})`
                  : 'Comment hàng loạt'}
            </SecondaryButton>
          ) : null}
          {canSync ? (
            <SecondaryButton className="h-11 gap-2" onClick={openSyncPostsModal} type="button">
              <CloudDownload className="h-4 w-4 text-brand-600" />
              Đồng bộ bài viết
            </SecondaryButton>
          ) : null}
          {canCreate ? (
            <Link
              className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700"
              href="/posts/new"
            >
              <Plus className="h-4 w-4" />
              Tạo post
            </Link>
          ) : null}
        </div>
      </header>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[minmax(240px,1.7fr)_minmax(160px,1fr)_minmax(160px,1fr)_auto] xl:items-end">
          <div className="sm:col-span-2 lg:col-span-3 xl:col-span-1">
            <Field label="Tìm kiếm">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                />
                <input
                  className="h-11 w-full rounded-md border border-slate-300 bg-white pl-9 pr-9 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  placeholder="Tìm theo tiêu đề, nội dung, link..."
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    aria-label="Xóa từ khóa tìm kiếm"
                    className="absolute right-2.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-100"
                    onClick={() => {
                      setQuery('');
                      setDebouncedQuery('');
                    }}
                    title="Xóa từ khóa"
                    type="button"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </Field>
          </div>

          <div>
            <Field label="Nền tảng">
              <SelectInput value={platform} onChange={(event) => setPlatform(event.target.value)}>
                <option value="">Tất cả nền tảng</option>
                {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          <div>
            <Field label="Loại media">
              <SelectInput
                value={mediaType}
                onChange={(event) => setMediaType(event.target.value as PostMediaFilter)}
              >
                <option value="">Tất cả media</option>
                <option value="VIDEO">Video</option>
                <option value="IMAGE">Hình ảnh</option>
                <option value="NONE">Không có media</option>
              </SelectInput>
            </Field>
          </div>

          <div className="flex items-end">
            <SecondaryButton
              aria-expanded={showAdvancedFilters}
              className={`h-11 w-full whitespace-nowrap px-3 xl:w-auto ${
                showAdvancedFilters || activeAdvancedFilterCount > 0
                  ? 'border-brand-300 bg-brand-50/60 text-brand-700 hover:bg-brand-50'
                  : ''
              }`}
              onClick={() => setShowAdvancedFilters((current) => !current)}
              type="button"
            >
              <SlidersHorizontal className="h-4 w-4 shrink-0" />
              <span>Ngày &amp; Sắp xếp</span>
              {activeAdvancedFilterCount > 0 ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white">
                  {activeAdvancedFilterCount}
                </span>
              ) : null}
            </SecondaryButton>
          </div>
        </div>

        {showAdvancedFilters ? (
          <div className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50/70 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium text-slate-600">Chọn nhanh:</span>
              {(
                [
                  { id: 'today', label: 'Hôm nay' },
                  { id: 'last7d', label: '7 ngày qua' },
                  { id: 'last30d', label: '30 ngày qua' },
                  { id: 'thisMonth', label: 'Tháng này' },
                ] as const
              ).map((preset) => (
                <button
                  key={preset.id}
                  className="inline-flex h-7 items-center rounded-full border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                  onClick={() => applyQuickDatePreset(preset.id)}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
              {dateFrom || dateTo ? (
                <button
                  className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-800"
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                  }}
                  type="button"
                >
                  <X className="h-3 w-3" />
                  Xóa ngày
                </button>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Từ ngày">
                <TextInput
                  max={dateTo || undefined}
                  type="date"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                />
              </Field>
              <Field label="Đến ngày">
                <TextInput
                  min={dateFrom || undefined}
                  type="date"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                />
              </Field>
              <Field label="Sắp xếp theo">
                <SelectInput
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as 'createdAt' | 'updatedAt')}
                >
                  <option value="createdAt">Ngày tạo</option>
                  <option value="updatedAt">Ngày cập nhật</option>
                </SelectInput>
              </Field>
              <Field label="Thứ tự">
                <SelectInput
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as 'asc' | 'desc')}
                >
                  <option value="desc">Mới nhất trước</option>
                  <option value="asc">Cũ nhất trước</option>
                </SelectInput>
              </Field>
            </div>
          </div>
        ) : null}

        {activeFilterChips.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
            <span className="mr-1 text-xs font-medium text-slate-500">Đang lọc:</span>
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-200 bg-brand-50/70 py-1 pl-2.5 pr-1.5 text-xs font-medium text-brand-800"
              >
                <span className="max-w-[220px] truncate">{chip.label}</span>
                <button
                  aria-label={`Bỏ lọc ${chip.label}`}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-brand-600 transition hover:bg-brand-200/70 hover:text-brand-900"
                  onClick={chip.onRemove}
                  type="button"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-red-50 hover:text-red-600"
              onClick={resetFilters}
              type="button"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Đặt lại bộ lọc
            </button>
          </div>
        ) : null}

        <div className="-mx-4 mt-3 overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0">
          <div className="flex min-w-max items-center gap-1">
            <PostStatusTab
              active={status === ''}
              count={totalStatusCount}
              label="Tất cả"
              onClick={() => setStatus('')}
            />
            {POST_STATUSES.map((item) => (
              <PostStatusTab
                key={item}
                active={status === item}
                count={statusCounts[item] ?? 0}
                label={postStatusLabel(item)}
                onClick={() => setStatus(item)}
              />
            ))}
            {status ? (
              <button
                className="ml-auto inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                onClick={() => setStatus('')}
                title="Quay lại Tất cả trạng thái"
                type="button"
              >
                <X className="h-3.5 w-3.5" />
                Tất cả trạng thái
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <InlineError message={error} />

      <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium text-slate-700">
              {loading ? 'Đang tải...' : `Hiển thị ${posts.length} bài`}
            </p>
            {selectedDeletablePosts.length > 0 ? (
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                Đã chọn {selectedDeletablePosts.length}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {canComment && canOpenBulkCommentFromFilter ? (
              <SecondaryButton
                className="h-9 gap-2 border-brand-200 text-brand-700 hover:bg-brand-50"
                disabled={loadingCommentModal}
                onClick={() =>
                  void openCommentModal(selectedPosts.length > 0 ? selectedPosts : undefined)
                }
                type="button"
              >
                <MessageSquarePlus className="h-4 w-4" />
                {loadingCommentModal
                  ? 'Đang tải danh sách bài...'
                  : selectedCommentableTargets.length > 0
                    ? `Comment các bài đã chọn (${selectedCommentableTargets.length})`
                    : 'Comment nhiều bài / Gắn link SP'}
              </SecondaryButton>
            ) : null}
            {selectedDeletablePosts.length > 0 ? (
              <SecondaryButton
                className="h-9 gap-2 border-red-200 text-red-700 hover:bg-red-50"
                disabled={!canDelete || bulkDeleting}
                onClick={() => {
                  setBulkDeleteProgress([]);
                  setBulkDeleteOpen(true);
                }}
                type="button"
              >
                <Trash2 className="h-4 w-4" />
                Xóa đã chọn
              </SecondaryButton>
            ) : null}
            <p className="text-xs text-slate-500">Trang {cursorStack.length + 1}</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] table-fixed text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="w-12 px-4 py-3">
                  <input
                    aria-label="Chọn tất cả bài"
                    checked={
                      deletablePosts.length > 0 &&
                      deletablePosts.every((post) => selectedPostIds.includes(post.id))
                    }
                    disabled={(!canDelete && !canComment) || deletablePosts.length === 0}
                    type="checkbox"
                    onChange={toggleAllVisiblePosts}
                  />
                </th>
                <th className="w-28 px-4 py-3">Bài đăng</th>
                <th className="w-36 px-4 py-3">Nền tảng</th>
                <th className="w-40 px-4 py-3">Trạng thái</th>
                <th className="w-36 px-4 py-3">
                  <button
                    className="inline-flex items-center gap-1 font-semibold uppercase text-slate-500 transition hover:text-slate-900"
                    onClick={() => setDirection((current) => (current === 'desc' ? 'asc' : 'desc'))}
                    title={
                      direction === 'desc'
                        ? 'Đang xếp: Mới nhất → Cũ nhất (bấm để đảo ngược)'
                        : 'Đang xếp: Cũ nhất → Mới nhất (bấm để đảo ngược)'
                    }
                    type="button"
                  >
                    <span>Thời gian</span>
                    {direction === 'desc' ? (
                      <ArrowDown className="h-3.5 w-3.5 text-brand-600" />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5 text-brand-600" />
                    )}
                  </button>
                </th>
                <th className="w-48 px-4 py-3">Kết quả</th>
                <th className="w-52 px-4 py-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {posts.map((post) => (
                <tr
                  key={post.id}
                  className="border-l-2 border-transparent align-middle transition hover:border-brand-300 hover:bg-slate-50"
                >
                  <td className="px-4 py-3">
                    <input
                      aria-label={`Chọn bài ${post.title ?? post.id}`}
                      checked={selectedPostIds.includes(post.id)}
                      disabled={(!canDelete && !canComment) || !canDeletePostStatus(post.status)}
                      type="checkbox"
                      onChange={() => togglePostSelection(post)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <PostThumbnail post={post} onPreview={() => setPreviewPost(post)} />
                    <MediaSummary media={post.media} compact />
                    <PlatformErrors post={post} />
                  </td>
                  <td className="px-4 py-3">
                    <PlatformChips post={post} />
                    {(post.store ?? post.platformPosts.find((p) => p.store)?.store) ? (
                      <div className="mt-1.5">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                          style={{
                            backgroundColor:
                              (post.store ?? post.platformPosts.find((p) => p.store)?.store)
                                ?.color ?? '#2563eb',
                          }}
                        >
                          {(post.store ?? post.platformPosts.find((p) => p.store)?.store)?.name}
                        </span>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={post.status} />
                    {post.derivedStatus !== post.status ? (
                      <div className="mt-1">
                        <StatusBadge status={post.derivedStatus} muted />
                      </div>
                    ) : null}
                    {post.sourceType === 'EXTERNAL' ? (
                      <div className="mt-1">
                        <span className="inline-block rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                          EXTERNAL
                        </span>
                      </div>
                    ) : null}
                    <PostPendingAsyncBadge post={post} />
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <p>{formatShortDate(primaryPostTime(post))}</p>
                    <p className="mt-1 text-xs text-slate-500">{primaryPostTimeLabel(post)}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <PostResultSummary
                      post={post}
                      onOpenComments={() => setActiveCommentsPost(post)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      {post.platformPosts.some(
                        (pp) => pp.status === 'PUBLISHED' && Boolean(pp.externalPostId),
                      ) ? (
                        <IconButton
                          className="h-9 w-9 border-brand-200 text-brand-700 hover:bg-brand-50"
                          label="Xem & trả lời bình luận / Gắn link sản phẩm"
                          onClick={() => setActiveCommentsPost(post)}
                        >
                          <MessageSquare className="h-4 w-4" />
                        </IconButton>
                      ) : null}
                      <IconLink className="h-9 w-9" href={`/posts/${post.id}`} label="Xem chi tiết">
                        <Eye className="h-4 w-4" />
                      </IconLink>
                      <RowActions
                        canDelete={canDelete}
                        canRetry={canRetry}
                        deleting={deleting === post.id}
                        duplicating={duplicating === post.id}
                        post={post}
                        retrying={retrying === post.id}
                        retryDisabled={retrying !== null}
                        onDelete={() => openDeleteDialog(post)}
                        onDuplicate={() => void duplicatePost(post.id)}
                        onRetry={() => void retry(post.id)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && posts.length === 0 ? (
          <div className="p-6">
            <p className="text-sm font-semibold text-slate-950">{emptyState.title}</p>
            <p className="mt-1 text-sm text-slate-600">{emptyState.body}</p>
          </div>
        ) : null}
        {loading ? <p className="p-6 text-sm text-slate-600">Đang tải posts...</p> : null}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center whitespace-nowrap text-sm text-slate-600">
          <SelectInput
            aria-label="Số bài mỗi trang"
            className="h-10 w-28 shrink-0"
            value={String(pageSize)}
            onChange={(event) => {
              setCursorStack([]);
              setPageSize(Number(event.target.value));
            }}
          >
            <option value="10">10 / trang</option>
            <option value="20">20 / trang</option>
            <option value="50">50 / trang</option>
          </SelectInput>
        </label>
        <div className="flex items-center gap-3">
          <IconButton
            disabled={loading || cursorStack.length === 0}
            label="Trang trước"
            onClick={() => {
              const previous = cursorStack.slice(0, -1);
              setCursorStack(previous);
              void loadPosts(previous.at(-1));
            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <span className="min-w-16 text-center text-sm text-slate-500">
            Trang {cursorStack.length + 1}
          </span>
          <IconButton
            disabled={loading || !nextCursor}
            label="Trang sau"
            onClick={() => {
              if (!nextCursor) return;
              setCursorStack((current) => [...current, nextCursor]);
              void loadPosts(nextCursor);
            }}
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <DeletePostDialog
        busy={deleting !== null}
        capabilityByPlatform={capabilityByPlatform}
        post={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(input) => void deletePost(input)}
      />
      <BulkDeletePostsDialog
        busy={bulkDeleting}
        open={bulkDeleteOpen}
        posts={selectedDeletablePosts}
        progress={bulkDeleteProgress}
        onCancel={() => {
          if (bulkDeleting) return;
          setBulkDeleteOpen(false);
          setBulkDeleteProgress([]);
        }}
        onConfirm={(input) => void bulkDeletePosts(input)}
      />
      <MediaPreviewDialog post={previewPost} onClose={() => setPreviewPost(null)} />
      {workspace ? (
        <PostCommentsDrawer
          capabilityByPlatform={capabilityByPlatform}
          post={activeCommentsPost}
          workspaceId={workspace.id}
          onClose={() => setActiveCommentsPost(null)}
          onPostUpdated={() => void loadPosts(cursorStack.at(-1), { silent: true })}
        />
      ) : null}

      {syncModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">
                  Đồng bộ bài viết từ kênh mạng xã hội
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Lọc theo Store, Nền tảng và chọn chính xác các kênh bạn muốn kéo bài viết lịch sử
                  về.
                </p>
              </div>
              <button
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setSyncModalOpen(false)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Store / Brand
                  </label>
                  <div className="mt-1 flex h-[34px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs font-semibold text-slate-800">
                    {activeStore ? (
                      <>
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: activeStore.color ?? '#2563eb' }}
                        />
                        <span className="truncate">{activeStore.name}</span>
                      </>
                    ) : (
                      <span className="truncate text-slate-500">Chưa gán Store</span>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">Nền tảng</label>
                  <select
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => updateSyncFilters(syncFilterStoreId, e.target.value)}
                    value={syncFilterPlatform}
                  >
                    <option value="">Tất cả nền tảng</option>
                    {Object.entries(PLATFORM_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Khoảng thời gian
                  </label>
                  <select
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setSyncCutoffDays(Number(e.target.value))}
                    value={syncCutoffDays}
                  >
                    <option value={7}>7 ngày gần nhất</option>
                    <option value={30}>30 ngày gần nhất</option>
                    <option value={90}>90 ngày gần nhất</option>
                    <option value={365}>365 ngày gần nhất</option>
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-700">
                    Các kênh sẽ đồng bộ ({syncSelectedAccountIds.length}/
                    {syncCandidateAccounts.length})
                  </label>
                  <div className="flex gap-2 text-xs">
                    <button
                      className="font-medium text-brand-600 hover:underline"
                      onClick={() =>
                        setSyncSelectedAccountIds(syncCandidateAccounts.map((a) => a.id))
                      }
                      type="button"
                    >
                      Chọn tất cả
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                      className="font-medium text-slate-500 hover:underline"
                      onClick={() => setSyncSelectedAccountIds([])}
                      type="button"
                    >
                      Bỏ chọn
                    </button>
                  </div>
                </div>

                <div className="mt-1.5 max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                  {syncCandidateAccounts.length === 0 ? (
                    <p className="p-4 text-center text-xs text-slate-500">
                      Không có kênh CONNECTED nào khớp với bộ lọc Store / Nền tảng trên.
                    </p>
                  ) : (
                    syncCandidateAccounts.map((acc) => {
                      const checked = syncSelectedAccountIds.includes(acc.id);
                      const storeObj = stores.find((s) => s.id === acc.storeId);
                      return (
                        <label
                          key={acc.id}
                          className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-slate-50"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <input
                              checked={checked}
                              onChange={(e) => {
                                setSyncSelectedAccountIds((prev) =>
                                  e.target.checked
                                    ? [...prev, acc.id]
                                    : prev.filter((id) => id !== acc.id),
                                );
                              }}
                              type="checkbox"
                            />
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                              {PLATFORM_LABELS[acc.platform]}
                            </span>
                            <span className="truncate font-semibold text-slate-900">
                              {acc.name}
                            </span>
                            {acc.username ? (
                              <span className="truncate text-slate-400">@{acc.username}</span>
                            ) : null}
                          </div>
                          {storeObj ? (
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                              style={{ backgroundColor: storeObj.color ?? '#2563eb' }}
                            >
                              {storeObj.name}
                            </span>
                          ) : null}
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <SecondaryButton onClick={() => setSyncModalOpen(false)} type="button">
                Đóng
              </SecondaryButton>
              <PrimaryButton
                busy={syncingExternalPosts}
                disabled={syncingExternalPosts || syncSelectedAccountIds.length === 0}
                onClick={() => void submitSyncExternalPosts()}
                type="button"
              >
                Đồng bộ ngay ({syncSelectedAccountIds.length} kênh)
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}

      <BulkPostCommentModal
        capabilityByPlatform={capabilityByPlatform}
        initialMediaType={mediaType}
        initialPlatform={platform}
        initialStoreId={storeId || undefined}
        lockedStoreId={storeId || undefined}
        isExplicitSelection={commentModalExplicitSelection}
        posts={commentModalPosts}
        stores={stores}
        workspaceId={workspace.id}
        onClose={() => setCommentModalPosts([])}
        onSubmitted={() => {
          setSelectedPostIds([]);
          scheduleSilentReload(1500);
        }}
      />
    </div>
  );
}

function canDeletePostStatus(status: ContentPostView['status']) {
  return DELETABLE_POST_STATUSES.includes(status as (typeof DELETABLE_POST_STATUSES)[number]);
}

function deleteResultFailures(result: DeletePostResult) {
  return result.remoteDeleteResults?.filter((item) => !item.deleted && !item.queued) ?? [];
}

function deleteResultMessage(result: DeletePostResult) {
  const failures = deleteResultFailures(result);
  const queuedTargetItems = result.remoteDeleteResults?.filter((item) => item.queued) ?? [];
  const deletedTargetItems = result.remoteDeleteResults?.filter((item) => item.deleted) ?? [];
  const deletedTargetsText = summarizeDeleteTargets(deletedTargetItems);
  if (result.deleted) {
    return deletedTargetsText
      ? `Đã xóa bài viết khỏi workspace và xóa trên ${deletedTargetsText}.`
      : 'Đã xóa bài viết khỏi workspace.';
  }
  if (result.queued || queuedTargetItems.length > 0) {
    const queuedTargetsText = summarizeDeleteTargets(queuedTargetItems);
    return queuedTargetsText
      ? `Đã đưa yêu cầu xóa trên ${queuedTargetsText} vào hàng đợi chạy ngầm.`
      : 'Đã đưa yêu cầu xóa bài viết vào hàng đợi chạy ngầm.';
  }
  if (failures.length > 0) {
    const failedReasons = failures.map(formatDeleteFailure).slice(0, 2).join('; ');
    const suffix = failures.length > 2 ? ` và ${failures.length - 2} target khác` : '';
    const partial = deletedTargetsText ? `Đã xóa trên ${deletedTargetsText}, nhưng ` : '';
    return `${partial}chưa xóa bài khỏi workspace. Lỗi: ${failedReasons}${suffix}.`;
  }
  return deletedTargetsText
    ? `Đã xóa bản đăng đã chọn trên ${deletedTargetsText}. Bài trong workspace vẫn còn.`
    : 'Không có bản đăng trên nền tảng nào được xóa.';
}

function summarizeDeleteTargets(items: NonNullable<DeletePostResult['remoteDeleteResults']>) {
  if (items.length === 0) return '';
  const visible = items.slice(0, 2).map(formatDeleteTarget).join(', ');
  const hiddenCount = items.length - 2;
  return hiddenCount > 0 ? `${visible} và ${hiddenCount} target khác` : visible;
}

function formatDeleteTarget(item: NonNullable<DeletePostResult['remoteDeleteResults']>[number]) {
  return `${item.platform} / ${item.socialAccountName}`;
}

function formatDeleteFailure(item: NonNullable<DeletePostResult['remoteDeleteResults']>[number]) {
  const code = item.errorCode ? `${item.errorCode}: ` : '';
  const reason = item.errorMessage || 'Không rõ nguyên nhân.';
  return `${item.platform} / ${item.socialAccountName}: ${code}${reason}`;
}

function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      aria-label={label}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:translate-y-0 disabled:hover:border-slate-300 disabled:hover:bg-white disabled:hover:shadow-none ${className}`}
      title={label}
      type={props.type ?? 'button'}
    >
      {children}
    </button>
  );
}

function IconLink({
  href,
  label,
  children,
  className = '',
}: {
  href: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      aria-label={label}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-100 ${className}`}
      href={href}
      title={label}
    >
      {children}
    </Link>
  );
}

function PostThumbnail({ post, onPreview }: { post: ContentPostView; onPreview: () => void }) {
  const asset = post.media[0];

  if (!asset) {
    return (
      <div className="flex h-12 w-[72px] shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-medium text-slate-500">
        No media
      </div>
    );
  }

  const sources =
    asset.type === 'VIDEO' && asset.status !== 'ARCHIVED'
      ? mediaThumbnailSources(asset)
      : mediaPreviewSources(asset);
  if (sources.length === 0) {
    return (
      <div className="flex h-12 w-[72px] shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-medium text-slate-500">
        {asset.type}
      </div>
    );
  }

  if (asset.type === 'IMAGE' || asset.status === 'ARCHIVED') {
    return (
      <button
        className="relative block h-12 w-[72px] overflow-hidden rounded-md transition hover:-translate-y-px hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500"
        onClick={onPreview}
        title="Xem media"
        type="button"
      >
        <FallbackImage
          alt={asset.originalFileName ?? 'media'}
          className="h-full w-full object-cover"
          sources={sources}
        />
        {asset.status === 'ARCHIVED' ? (
          <span className="absolute bottom-1 left-1 rounded bg-slate-950/75 px-1 text-[9px] font-semibold text-white">
            ARCHIVED
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <button
      className="relative h-12 w-[72px] shrink-0 overflow-hidden rounded-md bg-slate-950 transition hover:-translate-y-px hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500"
      onClick={onPreview}
      title="Xem video"
      type="button"
    >
      {sources.length > 0 ? (
        <FallbackImage
          alt={asset.originalFileName ?? 'video thumbnail'}
          className="h-full w-full object-cover"
          sources={sources}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[11px] font-semibold text-white">
          VIDEO
        </span>
      )}
      <span className="absolute inset-0 flex items-center justify-center bg-slate-950/20 text-[11px] font-semibold text-white">
        VIDEO
      </span>
    </button>
  );
}

function MediaSummary({
  media,
  compact = false,
}: {
  media: ContentPostView['media'];
  compact?: boolean;
}) {
  if (media.length === 0) {
    return <p className="mt-1 text-xs text-slate-500">Không có media</p>;
  }

  const images = media.filter((asset) => asset.type === 'IMAGE').length;
  const videos = media.filter((asset) => asset.type === 'VIDEO').length;
  const statuses = [...new Set(media.map((asset) => asset.status))];
  const totalBytes = media.reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0);
  const parts = [
    images > 0 ? `${images} ảnh` : null,
    videos > 0 ? `${videos} video` : null,
    compact && media.length > 1 ? `${media.length} file` : null,
  ].filter(Boolean);

  return (
    <p className="mt-1 max-w-24 truncate text-xs text-slate-500" title={mediaSummaryTitle(media)}>
      {parts.join(' + ')} · {statuses.join('/')}
      {totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
    </p>
  );
}

function MediaPreviewDialog({
  post,
  onClose,
}: {
  post: ContentPostView | null;
  onClose: () => void;
}) {
  const asset = post?.media[0];
  const source = asset?.displayUrl ?? asset?.thumbnailUrl ?? asset?.readUrl;
  if (!post || !asset || !source) return null;

  const youtubeEmbed = extractYouTubeEmbedUrl(asset.displayUrl ?? asset.readUrl ?? source);
  const externalLink = post.platformPosts.find((pp) => pp.externalUrl)?.externalUrl ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6">
      <div className="w-full max-w-4xl overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-semibold text-slate-950">
            {post.title ?? asset.originalFileName ?? 'Media preview'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {externalLink ? (
              <a
                className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                href={externalLink}
                rel="noreferrer"
                target="_blank"
              >
                Mở bài gốc ↗
              </a>
            ) : null}
            <IconButton className="h-9 w-9" label="Đóng" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="bg-slate-950 p-3">
          {youtubeEmbed ? (
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="aspect-video max-h-[72vh] w-full rounded bg-black"
              src={youtubeEmbed}
              title={post.title ?? asset.originalFileName ?? 'YouTube video'}
            />
          ) : asset.type === 'VIDEO' &&
            asset.status !== 'ARCHIVED' &&
            asset.mimeType !== 'image/jpeg' ? (
            <video
              className="max-h-[72vh] w-full rounded bg-black"
              controls
              poster={asset.thumbnailUrl ?? undefined}
              src={source}
            />
          ) : (
            <FallbackImage
              alt={asset.originalFileName ?? 'media'}
              className="max-h-[72vh] w-full rounded object-contain"
              sources={mediaPreviewSources(asset)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function BulkDeletePostsDialog({
  busy,
  open,
  posts,
  progress,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  open: boolean;
  posts: ContentPostView[];
  progress: BulkDeleteProgressItem[];
  onCancel: () => void;
  onConfirm: (input: { deleteFromServer: boolean; deleteFromPlatforms: boolean }) => void;
}) {
  const [deleteFromServer, setDeleteFromServer] = useState(true);
  const [deleteFromPlatforms, setDeleteFromPlatforms] = useState(false);
  const remoteTargetCount = posts.reduce(
    (sum, post) =>
      sum +
      post.platformPosts.filter((item) => item.status === 'PUBLISHED' && item.externalPostId)
        .length,
    0,
  );
  const completedCount = progress.filter(
    (item) => item.status === 'DONE' || item.status === 'QUEUED' || item.status === 'ERROR',
  ).length;
  const successCount = progress.filter(
    (item) => item.status === 'DONE' || item.status === 'QUEUED',
  ).length;
  const errorCount = progress.filter((item) => item.status === 'ERROR').length;
  const totalCount = progress.length || posts.length;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const confirmDisabled = busy || progress.length > 0 || posts.length === 0 || !deleteFromServer;

  useEffect(() => {
    if (open) {
      setDeleteFromServer(true);
      setDeleteFromPlatforms(false);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 py-6">
      <div className="w-full max-w-xl rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Xóa nhiều bài viết</h2>
          <p className="mt-1 text-sm text-slate-600">
            Chọn phạm vi xóa rồi theo dõi tiến trình từng bài trong danh sách bên dưới.
          </p>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
            <input
              checked={deleteFromServer}
              className="mt-1"
              disabled={busy}
              type="checkbox"
              onChange={(event) => setDeleteFromServer(event.target.checked)}
            />
            <span>
              <span className="block font-semibold text-slate-950">Xóa ở server / workspace</span>
              <span className="block text-slate-500">
                Xóa khỏi danh sách quản lý, hủy lịch/job và dọn media không còn dùng.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-md border border-slate-200 px-3 py-3 text-sm">
            <input
              checked={deleteFromPlatforms}
              className="mt-1"
              disabled={busy || remoteTargetCount === 0}
              type="checkbox"
              onChange={(event) => setDeleteFromPlatforms(event.target.checked)}
            />
            <span>
              <span className="block font-semibold text-slate-950">
                Xóa cả trên nền tảng ({remoteTargetCount} bản đã publish)
              </span>
              <span className="block text-slate-500">
                Nếu bật mục này, từng bài chỉ bị xóa khỏi workspace sau khi mọi target social của
                bài đó xóa thành công.
              </span>
            </span>
          </label>

          {progress.length > 0 ? (
            <div className="rounded-md border border-slate-200 px-3 py-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold text-slate-900">
                  Tiến trình {completedCount}/{totalCount}
                </span>
                <span className="text-xs text-slate-500">
                  {successCount} xong · {errorCount} lỗi
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600 transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="max-h-48 overflow-auto rounded-md border border-slate-200">
            {(progress.length > 0 ? progress : posts.map(postToPendingProgress)).map((item) => (
              <div
                key={item.postId}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0"
              >
                <span className="min-w-0 truncate text-sm font-medium text-slate-800">
                  {item.title}
                </span>
                <BulkDeleteProgressBadge status={item.status} />
                {item.errorMessage ? (
                  <p className="min-w-0 flex-1 truncate text-right text-xs text-red-700">
                    {item.errorMessage}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {!deleteFromServer ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Bulk delete hiện cần bật xóa ở server/workspace. Xóa riêng trên social sẽ làm thành
              một thao tác riêng để tránh lệch dữ liệu.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <SecondaryButton disabled={busy} onClick={onCancel} type="button">
            {progress.length > 0 && !busy ? 'Đóng' : 'Hủy'}
          </SecondaryButton>
          <PrimaryButton
            busy={busy}
            disabled={confirmDisabled}
            onClick={() => onConfirm({ deleteFromServer, deleteFromPlatforms })}
            type="button"
          >
            Xóa {posts.length} bài
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function postToPendingProgress(post: ContentPostView): BulkDeleteProgressItem {
  return {
    postId: post.id,
    title: post.title ?? post.body ?? post.id,
    status: 'PENDING',
  };
}

function BulkDeleteProgressBadge({ status }: { status: BulkDeleteProgressStatus }) {
  const tone =
    status === 'DONE'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'QUEUED'
        ? 'bg-sky-50 text-sky-700'
        : status === 'ERROR'
          ? 'bg-red-50 text-red-700'
          : status === 'RUNNING'
            ? 'bg-amber-50 text-amber-700'
            : 'bg-slate-100 text-slate-500';
  const label =
    status === 'DONE'
      ? 'Xong'
      : status === 'QUEUED'
        ? 'Đã xếp queue'
        : status === 'ERROR'
          ? 'Lỗi'
          : status === 'RUNNING'
            ? 'Đang xóa'
            : 'Chờ';

  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

function PostResultSummary({
  post,
  onOpenComments,
}: {
  post: ContentPostView;
  onOpenComments?: () => void;
}) {
  const published = post.platformPosts.filter((item) => item.status === 'PUBLISHED').length;
  const scheduled =
    post.status === 'SCHEDULED'
      ? post.platformPosts.filter((item) => item.status === 'PENDING' || item.status === 'QUEUED')
          .length
      : 0;
  const failed = post.platformPosts.filter((item) => item.status === 'FAILED').length;
  const attempts = post.platformPosts.reduce((sum, item) => sum + item.attemptCount, 0);
  const total = post.platformPosts.length;
  const syncedComments = post.platformPosts.reduce(
    (sum, item) => sum + (item.commentCount ?? 0),
    0,
  );
  const metrics = aggregatePlatformMetrics(post.platformPosts);
  const hasMetrics = hasVisibleMetrics(metrics);
  const views = metrics.values.views?.value ?? metrics.values.impressions?.value ?? null;
  const engagement = metrics.values.engagement?.value ?? null;
  const metricComments = metrics.values.comments?.value ?? null;
  const displayComments =
    syncedComments > 0 ? syncedComments : metricComments !== null ? metricComments : 0;

  return (
    <div className="grid gap-1 text-xs leading-5">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-900">
          {scheduled > 0 && published === 0
            ? `${scheduled}/${total || 1} chờ lên lịch`
            : `${published}/${total || 1} đã đăng`}
        </span>
        {published > 0 && onOpenComments ? (
          <button
            className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 transition hover:bg-brand-100"
            onClick={onOpenComments}
            title="Xem và trả lời bình luận của bài này"
            type="button"
          >
            <MessageSquare className="h-3 w-3" />
            {displayComments} cmt
          </button>
        ) : null}
      </div>
      {hasMetrics ? (
        <span className="text-slate-600">
          {formatMetricNumber(views)} views · {formatMetricNumber(engagement)} tương tác
        </span>
      ) : null}
      <span className={failed > 0 ? 'font-medium text-red-700' : 'text-slate-500'}>
        {failed > 0 ? `${failed} lỗi` : 'Không lỗi'} · Attempts {attempts}/{total || 1}
      </span>
    </div>
  );
}

function PlatformChips({ post }: { post: ContentPostView }) {
  return (
    <div className="flex max-w-40 flex-wrap gap-2">
      {post.platformPosts.map((item) => (
        <span
          key={item.id}
          className="inline-flex h-8 min-w-10 items-center justify-center rounded-md bg-slate-100 px-2 text-xs font-semibold text-slate-700"
          title={`${PLATFORM_LABELS[item.platform]} - ${item.socialAccountName}`}
        >
          {platformShortLabel(item.platform)}
        </span>
      ))}
    </div>
  );
}

function readPlatformSubState(
  state: ContentPostView['platformPosts'][number]['platformState'],
  key: 'pendingDelete' | 'pendingUpdate',
): { state?: string; errorCode?: string; errorMessage?: string } | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const sub = (state as Record<string, unknown>)[key];
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return null;
  return sub as { state?: string; errorCode?: string; errorMessage?: string };
}

function PostPendingAsyncBadge({ post }: { post: ContentPostView }) {
  let deletingActive = false;
  let deletingFailed = false;
  let updatingActive = false;
  let updatingFailed = false;

  for (const pp of post.platformPosts) {
    const del = readPlatformSubState(pp.platformState, 'pendingDelete');
    if (del?.state === 'QUEUED' || del?.state === 'PROCESSING') deletingActive = true;
    if (del?.state === 'FAILED') deletingFailed = true;
    const upd = readPlatformSubState(pp.platformState, 'pendingUpdate');
    if (upd?.state === 'QUEUED' || upd?.state === 'PROCESSING') updatingActive = true;
    if (upd?.state === 'FAILED') updatingFailed = true;
  }

  if (deletingActive) {
    return (
      <div className="mt-1">
        <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
          Đang xóa MXH...
        </span>
      </div>
    );
  }
  if (deletingFailed) {
    return (
      <div className="mt-1">
        <span className="inline-block rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
          Lỗi xóa MXH
        </span>
      </div>
    );
  }
  if (updatingActive) {
    return (
      <div className="mt-1">
        <span className="inline-block rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
          Đang cập nhật MXH...
        </span>
      </div>
    );
  }
  if (updatingFailed) {
    return (
      <div className="mt-1">
        <span className="inline-block rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
          Lỗi cập nhật MXH
        </span>
      </div>
    );
  }
  return null;
}

function PlatformErrors({ post }: { post: ContentPostView }) {
  const failed = post.platformPosts.filter((item) => item.errorMessage);
  if (failed.length > 0) {
    return (
      <p className="mt-2 max-w-xl truncate rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
        {failed[0]?.errorCode}: {failed[0]?.errorMessage}
      </p>
    );
  }

  for (const pp of post.platformPosts) {
    const del = readPlatformSubState(pp.platformState, 'pendingDelete');
    if (del?.state === 'FAILED' && del.errorMessage) {
      return (
        <p className="mt-2 max-w-xl truncate rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          Xóa thất bại ({del.errorCode ?? 'ERROR'}): {del.errorMessage}
        </p>
      );
    }
    const upd = readPlatformSubState(pp.platformState, 'pendingUpdate');
    if (upd?.state === 'FAILED' && upd.errorMessage) {
      return (
        <p className="mt-2 max-w-xl truncate rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          Cập nhật thất bại ({upd.errorCode ?? 'ERROR'}): {upd.errorMessage}
        </p>
      );
    }
  }

  return null;
}

function RowActions({
  canDelete,
  canRetry,
  deleting,
  duplicating,
  post,
  retrying,
  retryDisabled,
  onDelete,
  onDuplicate,
  onRetry,
}: {
  canDelete: boolean;
  canRetry: boolean;
  deleting: boolean;
  duplicating: boolean;
  post: ContentPostView;
  retrying: boolean;
  retryDisabled: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onRetry: () => void;
}) {
  const hasFailedPlatformPost = post.platformPosts.some((item) => item.status === 'FAILED');

  return (
    <div className="flex gap-1">
      <IconLink className="h-9 w-9" href={`/posts/${post.id}/edit`} label="Sửa">
        <Pencil className="h-4 w-4" />
      </IconLink>
      <IconButton className="h-9 w-9" disabled={duplicating} label="Nhân bản" onClick={onDuplicate}>
        <Copy className="h-4 w-4" />
      </IconButton>
      <IconButton
        className="h-9 w-9"
        disabled={!canDelete || deleting || !canDeletePostStatus(post.status)}
        label="Xóa"
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
      </IconButton>
      {hasFailedPlatformPost ? (
        <IconButton
          className="h-9 w-9 border-brand-200 text-brand-700 hover:bg-brand-50"
          disabled={!canRetry || retryDisabled}
          label="Retry"
          onClick={onRetry}
        >
          <RotateCcw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
        </IconButton>
      ) : null}
    </div>
  );
}

function StatusBadge({ status, muted = false }: { status: string; muted?: boolean }) {
  if (muted) {
    return (
      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500">
        {postStatusLabel(status)}
      </span>
    );
  }

  const tone =
    status === 'PUBLISHED'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'SCHEDULED'
        ? 'bg-indigo-50 text-indigo-700'
        : status === 'FAILED'
          ? 'bg-red-50 text-red-700'
          : status === 'PROCESSING' || status === 'QUEUED'
            ? 'bg-amber-50 text-amber-700'
            : 'bg-slate-100 text-slate-600';

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {postStatusLabel(status)}
    </span>
  );
}

function PostStatusTab({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-11 shrink-0 items-center justify-between gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        active
          ? 'border-brand-600 text-brand-700'
          : 'border-transparent text-slate-600 hover:text-slate-950'
      }`}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${
          active ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function toLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateInputLabel(value: string): string {
  const parts = value.split('-');
  if (parts.length !== 3) return value;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function postStatusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: 'Draft',
    SCHEDULED: 'Đã lên lịch',
    QUEUED: 'Trong queue',
    PROCESSING: 'Đang xử lý',
    PUBLISHED: 'Đã đăng',
    PARTIALLY_PUBLISHED: 'Đăng một phần',
    FAILED: 'Lỗi',
    PENDING: 'Đang chờ',
    CANCELLED: 'Đã hủy',
    DELETED: 'Đã xóa',
  };
  return labels[status] ?? status;
}

function primaryPostTime(post: ContentPostView) {
  return post.publishedAt ?? post.scheduledAt ?? post.updatedAt ?? post.createdAt;
}

function primaryPostTimeLabel(post: ContentPostView) {
  if (post.publishedAt) return 'Đã đăng';
  if (post.scheduledAt) return 'Lên lịch';
  if (post.updatedAt) return 'Cập nhật';
  return 'Tạo';
}

function formatShortDate(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function mediaSummaryTitle(media: ContentPostView['media']): string {
  return media
    .map((asset) =>
      [
        asset.originalFileName ?? asset.id,
        asset.type,
        asset.mimeType,
        asset.status,
        asset.sizeBytes ? formatBytes(asset.sizeBytes) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    )
    .join('\n');
}

function platformShortLabel(platform: string) {
  const labels: Record<string, string> = {
    FACEBOOK: 'FB',
    INSTAGRAM: 'IG',
    YOUTUBE: 'YT',
    TIKTOK: 'TT',
    PINTEREST: 'PIN',
  };
  return labels[platform] ?? platform;
}

function downloadCsv(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
