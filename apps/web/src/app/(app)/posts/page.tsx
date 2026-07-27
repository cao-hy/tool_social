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

export default function PostsPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [posts, setPosts] = useState<ContentPostView[]>([]);
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [socialAccountId, setSocialAccountId] = useState('');
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt'>('createdAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeFilters = useMemo(
    () => ({
      status: status || undefined,
      platform: platform || undefined,
      socialAccountId: socialAccountId || undefined,
      q: query.trim() || undefined,
      dateFrom: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
      dateTo: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
      sortBy,
      direction,
      limit: PAGE_SIZE,
    }),
    [dateFrom, dateTo, direction, platform, query, socialAccountId, sortBy, status],
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

  async function deletePost(post: ContentPostView) {
    if (!workspace) return;
    if (!['DRAFT', 'FAILED', 'SCHEDULED'].includes(post.status)) {
      setError('Chỉ xóa local record được draft, bài đã lên lịch hoặc bài thất bại.');
      return;
    }
    if (!window.confirm('Xóa bài viết này khỏi workspace?')) return;

    setDeleting(post.id);
    setError(null);
    try {
      await postsApi.delete(workspace.id, post.id);
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

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Posts</h1>
          <p className="mt-1 text-sm text-slate-600">
            Quản lý bài đăng theo trạng thái, nền tảng, tài khoản và lịch sử xử lý.
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
              className="inline-flex h-10 items-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white"
              href="/posts/new"
            >
              Tạo post
            </Link>
          ) : null}
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Từ khóa">
            <TextInput
              placeholder="title, body, link"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Field label="Trạng thái">
            <SelectInput value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Tất cả</option>
              {POST_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Nền tảng">
            <SelectInput
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                setSocialAccountId('');
              }}
            >
              <option value="">Tất cả</option>
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
              <option value="">Tất cả</option>
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
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
          <div className="flex items-end">
            <SecondaryButton
              className="w-full"
              onClick={() => {
                setStatus('');
                setPlatform('');
                setSocialAccountId('');
                setQuery('');
                setDateFrom('');
                setDateTo('');
                setSortBy('createdAt');
                setDirection('desc');
              }}
              type="button"
            >
              Xóa filter
            </SecondaryButton>
          </div>
        </div>
      </section>

      <InlineError message={error} />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="divide-y divide-slate-200">
          {posts.map((post) => (
            <article key={post.id} className="p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      className="truncate text-base font-semibold text-slate-950 hover:text-brand-700"
                      href={`/posts/${post.id}`}
                    >
                      {post.title ?? 'Untitled post'}
                    </Link>
                    <StatusBadge status={post.status} />
                    {post.derivedStatus !== post.status ? (
                      <StatusBadge status={post.derivedStatus} />
                    ) : null}
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-slate-600">
                    {post.body ?? 'Không có nội dung.'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-slate-500">
                    <span>Created: {formatDateTime(post.createdAt)}</span>
                    <span>Updated: {formatDateTime(post.updatedAt)}</span>
                    {post.scheduledAt ? (
                      <span>Scheduled: {formatDateTime(post.scheduledAt)}</span>
                    ) : null}
                    {post.publishedAt ? (
                      <span>Published: {formatDateTime(post.publishedAt)}</span>
                    ) : null}
                  </div>
                  {post.media.length > 0 ? (
                    <div className="mt-3 grid max-w-2xl gap-2 sm:grid-cols-2">
                      {post.media.slice(0, 4).map((asset) => (
                        <MediaPreview key={asset.id} asset={asset} />
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Link
                    className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                    href={`/posts/${post.id}`}
                  >
                    Detail
                  </Link>
                  <Link
                    className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                    href={`/posts/${post.id}/edit`}
                  >
                    Edit
                  </Link>
                  <SecondaryButton
                    disabled={duplicating !== null}
                    onClick={() => void duplicatePost(post.id)}
                    type="button"
                  >
                    {duplicating === post.id ? 'Đang nhân bản...' : 'Duplicate'}
                  </SecondaryButton>
                  <SecondaryButton
                    disabled={
                      deleting !== null || !['DRAFT', 'FAILED', 'SCHEDULED'].includes(post.status)
                    }
                    onClick={() => void deletePost(post)}
                    title={
                      post.status === 'PUBLISHED'
                        ? 'Xóa bài đã đăng trên nền tảng chưa được capability matrix xác minh.'
                        : undefined
                    }
                    type="button"
                  >
                    {deleting === post.id ? 'Đang xóa...' : 'Delete'}
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
                    Retry lỗi
                  </PrimaryButton>
                </div>
              </div>

              <div className="mt-4 grid gap-2 lg:grid-cols-2">
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
            <p className="p-6 text-sm text-slate-600">Không có post nào khớp filter.</p>
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
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'PUBLISHED'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'FAILED'
        ? 'bg-red-50 text-red-700'
        : status === 'PROCESSING' || status === 'QUEUED'
          ? 'bg-amber-50 text-amber-700'
          : 'bg-slate-100 text-slate-600';

  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>;
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
