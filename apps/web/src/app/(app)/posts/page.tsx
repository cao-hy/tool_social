'use client';

import { hasPermission, PLATFORM_LABELS } from '@socialhub/shared';
import Link from 'next/link';
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
import { MediaPreview } from '@/components/media-preview';
import { postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { rowsToCsv } from '@/lib/csv';
import { getErrorMessage } from '@/lib/errors';
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

const PAGE_SIZE = 10;
const DELETABLE_POST_STATUSES = [
  'DRAFT',
  'FAILED',
  'SCHEDULED',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
] as const;

export default function PostsPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [posts, setPosts] = useState<ContentPostView[]>([]);
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
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContentPostView | null>(null);
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
      limit: PAGE_SIZE,
    }),
    [dateFrom, dateTo, debouncedQuery, direction, platform, socialAccountId, sortBy, status],
  );

  async function loadPosts(cursor?: string) {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await postsApi.list(workspace.id, { ...activeFilters, cursor });
      setPosts(result.items);
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

  async function retry(postId: string) {
    if (!workspace) return;
    setRetrying(postId);
    setError(null);
    try {
      await postsApi.retry(workspace.id, postId);
      await loadPosts(cursorStack.at(-1));
    } catch (retryError) {
      setError(getErrorMessage(retryError));
    } finally {
      setRetrying(null);
    }
  }

  function openDeleteDialog(post: ContentPostView) {
    if (!canDeletePostStatus(post.status)) {
      setError('Bài này không ở trạng thái có thể xóa.');
      return;
    }
    setDeleteTarget(post);
  }

  async function deletePost(input: { platformPostIds: string[] }) {
    if (!workspace) return;
    if (!deleteTarget || !canDeletePostStatus(deleteTarget.status)) {
      setError('Bài này không ở trạng thái có thể xóa.');
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
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setDeleting(null);
    }
  }

  async function duplicatePost(postId: string) {
    if (!workspace) return;
    setDuplicating(postId);
    setError(null);
    try {
      await postsApi.duplicate(workspace.id, postId);
      await loadPosts(cursorStack.at(-1));
    } catch (duplicateError) {
      setError(getErrorMessage(duplicateError));
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
    } catch (exportError) {
      setError(getErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  }

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canRetry = hasPermission(workspace.role, 'post:publish');
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
  const statusCounts = new Map<string, number>();
  for (const post of posts) {
    statusCounts.set(post.status, (statusCounts.get(post.status) ?? 0) + 1);
  }
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
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-brand-700">Publishing queue</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Posts</h1>
          <p className="mt-1 text-sm text-slate-600">
            Màn vận hành bài đăng: theo dõi draft, lịch đăng, queue worker, lỗi từng nền tảng và
            thao tác retry/duplicate/export.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton
            disabled={loading}
            onClick={() => void loadPosts(cursorStack.at(-1))}
            type="button"
          >
            Làm mới
          </SecondaryButton>
          <SecondaryButton disabled={exporting} onClick={() => void exportCsv()} type="button">
            {exporting ? 'Đang export...' : 'Export CSV'}
          </SecondaryButton>
          {canCreate ? (
            <Link
              className="inline-flex h-10 items-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white transition hover:bg-brand-700"
              href="/posts/new"
            >
              Tạo post
            </Link>
          ) : null}
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid gap-3 xl:grid-cols-[1fr_auto] xl:items-center">
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
            <PostStatusTab
              active={status === ''}
              count={posts.length}
              label="Tất cả"
              onClick={() => setStatus('')}
            />
            {POST_STATUSES.map((item) => (
              <PostStatusTab
                key={item}
                active={status === item}
                count={statusCounts.get(item) ?? 0}
                label={postStatusLabel(item)}
                onClick={() => setStatus(item)}
              />
            ))}
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(240px,380px)_auto]">
            <TextInput
              aria-label="Tìm bài viết"
              placeholder="Tìm title, nội dung, link..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <SecondaryButton
              aria-expanded={showAdvancedFilters}
              onClick={() => setShowAdvancedFilters((current) => !current)}
              type="button"
            >
              Bộ lọc {activeAdvancedFilterCount > 0 ? `(${activeAdvancedFilterCount})` : ''}
            </SecondaryButton>
          </div>
        </div>

        {showAdvancedFilters ? (
          <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 md:grid-cols-2 xl:grid-cols-6">
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
            <Field label="Từ ngày tạo">
              <TextInput
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
              />
            </Field>
            <Field label="Đến ngày tạo">
              <TextInput
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
              />
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
      </section>

      <InlineError message={error} />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {loading ? 'Đang tải...' : `${posts.length} bài trong trang này`}
            </p>
            <p className="text-xs text-slate-500">
              Mỗi bài có thể có nhiều platform post, mỗi platform post có trạng thái riêng.
            </p>
          </div>
          {hasAnyFilter ? (
            <button
              className="text-sm font-medium text-brand-700 hover:text-brand-800"
              onClick={resetFilters}
              type="button"
            >
              Xóa filter
            </button>
          ) : null}
        </div>
        <div className="divide-y divide-slate-200">
          {posts.map((post) => (
            <article key={post.id} className="p-4 transition hover:bg-slate-50/60">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={post.status} />
                    {post.derivedStatus !== post.status ? (
                      <StatusBadge status={post.derivedStatus} muted />
                    ) : null}
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                      {post.platformPosts.length} target
                    </span>
                    {post.media.length > 0 ? (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                        {post.media.length} media
                      </span>
                    ) : null}
                  </div>

                  <Link
                    className="mt-3 block truncate text-base font-semibold text-slate-950 hover:text-brand-700"
                    href={`/posts/${post.id}`}
                  >
                    {post.title ?? 'Untitled post'}
                  </Link>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">
                    {post.body ?? 'Không có nội dung.'}
                  </p>
                  {post.hashtags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {post.hashtags.slice(0, 8).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
                        >
                          #{tag.replace(/^#/, '')}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2 xl:grid-cols-4">
                    <TimelineItem label="Tạo" value={post.createdAt} />
                    <TimelineItem label="Cập nhật" value={post.updatedAt} />
                    <TimelineItem label="Lên lịch" value={post.scheduledAt} />
                    <TimelineItem label="Đã đăng" value={post.publishedAt} />
                  </div>

                  {post.media.length > 0 ? (
                    <div className="mt-3 grid max-w-2xl gap-2 sm:grid-cols-2">
                      {post.media.slice(0, 4).map((asset) => (
                        <MediaPreview key={asset.id} asset={asset} />
                      ))}
                    </div>
                  ) : null}
                </div>

                <aside className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
                  <Link
                    className="inline-flex h-10 w-full items-center justify-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white transition hover:bg-brand-700"
                    href={`/posts/${post.id}`}
                  >
                    Xem chi tiết
                  </Link>
                  <div className="grid grid-cols-2 gap-2">
                    <Link
                      className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                      href={`/posts/${post.id}/edit`}
                    >
                      Sửa
                    </Link>
                    <SecondaryButton
                      disabled={duplicating !== null}
                      onClick={() => void duplicatePost(post.id)}
                      type="button"
                    >
                      {duplicating === post.id ? 'Đang...' : 'Nhân bản'}
                    </SecondaryButton>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <SecondaryButton
                      disabled={deleting !== null || !canDeletePostStatus(post.status)}
                      onClick={() => openDeleteDialog(post)}
                      type="button"
                    >
                      {deleting === post.id ? 'Đang...' : 'Xóa'}
                    </SecondaryButton>
                    <PrimaryButton
                      busy={retrying === post.id}
                      disabled={
                        !canRetry ||
                        !post.platformPosts.some((item) => item.status === 'FAILED') ||
                        retrying !== null
                      }
                      onClick={() => void retry(post.id)}
                      type="button"
                    >
                      Retry
                    </PrimaryButton>
                  </div>
                </aside>
              </div>

              <div className="mt-4 grid gap-2 xl:grid-cols-2">
                {post.platformPosts.map((platformPost) => (
                  <div
                    key={platformPost.id}
                    className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {PLATFORM_LABELS[platformPost.platform]} ·{' '}
                          {platformPost.socialAccountName}
                        </p>
                        <p className="text-xs text-slate-500">
                          Attempts: {platformPost.attemptCount}
                        </p>
                      </div>
                      <StatusBadge status={platformPost.status} />
                    </div>
                    {platformPost.errorMessage ? (
                      <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                        {platformPost.errorCode}: {platformPost.errorMessage}
                      </p>
                    ) : null}
                    {platformPost.externalUrl ? (
                      <a
                        className="mt-2 inline-block text-xs font-medium text-brand-700"
                        href={platformPost.externalUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Mở bài trên nền tảng
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            </article>
          ))}

          {!loading && posts.length === 0 ? (
            <div className="p-6">
              <p className="text-sm font-semibold text-slate-950">{emptyState.title}</p>
              <p className="mt-1 text-sm text-slate-600">{emptyState.body}</p>
            </div>
          ) : null}
          {loading ? <p className="p-6 text-sm text-slate-600">Đang tải posts...</p> : null}
        </div>
      </section>

      <div className="flex items-center justify-between">
        <SecondaryButton
          disabled={loading || cursorStack.length === 0}
          onClick={() => {
            const previous = cursorStack.slice(0, -1);
            setCursorStack(previous);
            void loadPosts(previous.at(-1));
          }}
          type="button"
        >
          Trang trước
        </SecondaryButton>
        <span className="text-sm text-slate-500">Trang {cursorStack.length + 1}</span>
        <SecondaryButton
          disabled={loading || !nextCursor}
          onClick={() => {
            if (!nextCursor) return;
            setCursorStack((current) => [...current, nextCursor]);
            void loadPosts(nextCursor);
          }}
          type="button"
        >
          Trang sau
        </SecondaryButton>
      </div>
      <DeletePostDialog
        busy={deleting !== null}
        post={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(input) => void deletePost(input)}
      />
    </div>
  );
}

function canDeletePostStatus(status: ContentPostView['status']) {
  return DELETABLE_POST_STATUSES.includes(status as (typeof DELETABLE_POST_STATUSES)[number]);
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
      className={`inline-flex h-11 items-center justify-between gap-3 rounded-md border px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        active
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
      }`}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${
          active ? 'bg-white text-brand-700' : 'bg-slate-100 text-slate-500'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function TimelineItem({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <p className="font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-slate-700">{value ? formatDateTime(value) : '—'}</p>
    </div>
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

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value));
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
