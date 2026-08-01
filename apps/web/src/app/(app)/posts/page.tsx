'use client';

import { hasPermission, PLATFORM_LABELS } from '@socialhub/shared';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Filter,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/form-controls';
import { DeletePostDialog } from '@/components/delete-post-dialog';
import {
  FallbackImage,
  mediaPreviewSources,
  mediaThumbnailSources,
} from '@/components/media-preview';
import { useToast } from '@/components/toast-provider';
import { postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { rowsToCsv } from '@/lib/csv';
import { getErrorMessage } from '@/lib/errors';
import {
  aggregatePlatformMetrics,
  formatMetricNumber,
  hasVisibleMetrics,
} from '@/lib/post-metrics';
import type { ContentPostView, SocialAccountView } from '@/lib/types';

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

type BulkDeleteProgressStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'ERROR';

interface BulkDeleteProgressItem {
  postId: string;
  title: string;
  status: BulkDeleteProgressStatus;
  errorMessage?: string;
}

export default function PostsPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [posts, setPosts] = useState<ContentPostView[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [socialAccountId, setSocialAccountId] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt'>('createdAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
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

  const activeFilters = useMemo(
    () => ({
      status: status || undefined,
      platform: platform || undefined,
      socialAccountId: socialAccountId || undefined,
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
      pageSize,
      platform,
      socialAccountId,
      sortBy,
      status,
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

  async function loadPosts(cursor?: string) {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await postsApi.list(workspace.id, { ...activeFilters, cursor });
      setPosts(result.items);
      setStatusCounts(result.statusCounts);
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    socialAccountsApi
      .list(workspace.id)
      .then((result) => setAccounts(result.items))
      .catch((loadError) => setError(getErrorMessage(loadError)));
  }, [workspace]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query), 350);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    setCursorStack([]);
    void loadPosts();
  }, [workspace, activeFilters]);

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
      await postsApi.delete(workspace.id, deleteTarget.id, {
        deleteFromPlatforms: input.platformPostIds.length > 0,
        platformPostIds: input.platformPostIds,
      });
      setDeleteTarget(null);
      await loadPosts(cursorStack.at(-1));
      toast.success('Đã xóa bài viết.');
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
          await postsApi.delete(workspace.id, post.id, {
            deleteFromPlatforms: input.deleteFromPlatforms,
            platformPostIds,
          });
          deleted += 1;
          setBulkDeleteProgress((current) =>
            current.map((item) => (item.postId === post.id ? { ...item, status: 'DONE' } : item)),
          );
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
        toast.warning(`Đã xóa ${deleted}/${targets.length} bài. ${failed} bài lỗi.`);
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
  const activeAdvancedFilterCount = [
    platform,
    socialAccountId,
    dateFrom,
    dateTo,
    sortBy !== 'createdAt' ? sortBy : '',
    direction !== 'desc' ? direction : '',
  ].filter(Boolean).length;
  const hasAnyFilter = Boolean(
    status ||
    platform ||
    socialAccountId ||
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
        title: 'Chưa có bài viết nào',
        body: 'Tạo draft đầu tiên, chọn tài khoản publish, rồi đăng ngay hoặc đưa vào lịch.',
      };

  function resetFilters() {
    setStatus('');
    setPlatform('');
    setSocialAccountId('');
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
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[220px_180px_180px_minmax(280px,1fr)_auto]">
          <Field label="Nền tảng">
            <SelectInput
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setSocialAccountId('');
              }}
            >
              <option value="">Tất cả nền tảng</option>
              {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Từ ngày">
            <TextInput
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </Field>
          <Field label="Đến ngày">
            <TextInput
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </Field>
          <Field label="Tìm kiếm">
            <TextInput
              placeholder="Tìm theo tiêu đề, nội dung, link..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <div className="flex items-end gap-2">
            <SecondaryButton
              aria-expanded={showAdvancedFilters}
              className="h-11 gap-2"
              onClick={() => setShowAdvancedFilters((current) => !current)}
              type="button"
            >
              <Filter className="h-4 w-4" />
              Bộ lọc {activeAdvancedFilterCount > 0 ? `(${activeAdvancedFilterCount})` : ''}
            </SecondaryButton>
          </div>
        </div>

        {showAdvancedFilters ? (
          <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 md:grid-cols-3">
            <Field label="Tài khoản">
              <SelectInput
                value={socialAccountId}
                onChange={(event) => setSocialAccountId(event.target.value)}
              >
                <option value="">Tất cả tài khoản</option>
                {accounts
                  .filter((account) => !platform || account.platform === platform)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </SelectInput>
            </Field>
            <Field label="Sắp xếp">
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
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-1 border-b border-slate-200">
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
          {hasAnyFilter ? (
            <IconButton
              className="ml-auto h-9 w-9 border-transparent"
              label="Xóa lọc"
              onClick={resetFilters}
            >
              <X className="h-4 w-4" />
            </IconButton>
          ) : null}
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
                    aria-label="Chọn tất cả bài có thể xóa"
                    checked={
                      deletablePosts.length > 0 &&
                      deletablePosts.every((post) => selectedPostIds.includes(post.id))
                    }
                    disabled={!canDelete || deletablePosts.length === 0}
                    type="checkbox"
                    onChange={toggleAllVisiblePosts}
                  />
                </th>
                <th className="w-28 px-4 py-3">Bài đăng</th>
                <th className="w-36 px-4 py-3">Nền tảng</th>
                <th className="w-40 px-4 py-3">Trạng thái</th>
                <th className="w-36 px-4 py-3">Thời gian</th>
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
                      disabled={!canDelete || !canDeletePostStatus(post.status)}
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
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={post.status} />
                    {post.derivedStatus !== post.status ? (
                      <div className="mt-1">
                        <StatusBadge status={post.derivedStatus} muted />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <p>{formatShortDate(primaryPostTime(post))}</p>
                    <p className="mt-1 text-xs text-slate-500">{primaryPostTimeLabel(post)}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <PostResultSummary post={post} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
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
    </div>
  );
}

function canDeletePostStatus(status: ContentPostView['status']) {
  return DELETABLE_POST_STATUSES.includes(status as (typeof DELETABLE_POST_STATUSES)[number]);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6">
      <div className="w-full max-w-4xl overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-semibold text-slate-950">
            {post.title ?? asset.originalFileName ?? 'Media preview'}
          </p>
          <IconButton className="h-9 w-9" label="Đóng" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="bg-slate-950 p-3">
          {asset.type === 'VIDEO' && asset.status !== 'ARCHIVED' ? (
            <video className="max-h-[72vh] w-full rounded bg-black" controls src={source} />
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
    (item) => item.status === 'DONE' || item.status === 'ERROR',
  ).length;
  const successCount = progress.filter((item) => item.status === 'DONE').length;
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
                Xóa mềm khỏi danh sách quản lý, hủy lịch và dọn job publish đang chờ.
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
                Chỉ áp dụng với nền tảng có API xóa bài. Nếu nền tảng từ chối, bài đó sẽ báo lỗi.
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
      : status === 'ERROR'
        ? 'bg-red-50 text-red-700'
        : status === 'RUNNING'
          ? 'bg-amber-50 text-amber-700'
          : 'bg-slate-100 text-slate-500';
  const label =
    status === 'DONE'
      ? 'Xong'
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

function PostResultSummary({ post }: { post: ContentPostView }) {
  const published = post.platformPosts.filter((item) => item.status === 'PUBLISHED').length;
  const failed = post.platformPosts.filter((item) => item.status === 'FAILED').length;
  const attempts = post.platformPosts.reduce((sum, item) => sum + item.attemptCount, 0);
  const total = post.platformPosts.length;
  const metrics = aggregatePlatformMetrics(post.platformPosts);
  const hasMetrics = hasVisibleMetrics(metrics);
  const views = metrics.values.views?.value ?? metrics.values.impressions?.value ?? null;
  const engagement = metrics.values.engagement?.value ?? null;
  const comments = metrics.values.comments?.value ?? null;

  return (
    <div className="grid gap-1 text-xs leading-5">
      <span className="font-semibold text-slate-900">
        {published}/{total || 1} đã đăng
      </span>
      {hasMetrics ? (
        <span className="text-slate-600">
          {formatMetricNumber(views)} views · {formatMetricNumber(engagement)} tương tác ·{' '}
          {formatMetricNumber(comments)} cmt
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

function PlatformErrors({ post }: { post: ContentPostView }) {
  const failed = post.platformPosts.filter((item) => item.errorMessage);
  if (failed.length === 0) return null;

  return (
    <p className="mt-2 max-w-xl truncate rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
      {failed[0]?.errorCode}: {failed[0]?.errorMessage}
    </p>
  );
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
      className={`inline-flex h-11 items-center justify-between gap-2 border-b-2 px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
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
