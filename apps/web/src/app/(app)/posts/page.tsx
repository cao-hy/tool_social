'use client';

import { hasPermission, PLATFORM_LABELS } from '@socialhub/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { MediaPreview } from '@/components/media-preview';
import { postsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { ContentPostView } from '@/lib/types';

export default function PostsPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [posts, setPosts] = useState<ContentPostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPosts() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await postsApi.list(workspace.id);
      setPosts(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPosts();
  }, [workspace]);

  async function retry(postId: string) {
    if (!workspace) return;
    setRetrying(postId);
    setError(null);
    try {
      await postsApi.retry(workspace.id, postId);
      await loadPosts();
    } catch (retryError) {
      setError(getErrorMessage(retryError));
    } finally {
      setRetrying(null);
    }
  }

  async function deletePost(post: ContentPostView) {
    if (!workspace) return;
    if (!['DRAFT', 'FAILED', 'SCHEDULED'].includes(post.status)) {
      setError('Chỉ xóa được draft, bài đã lên lịch hoặc bài thất bại.');
      return;
    }
    if (!window.confirm('Xóa bài viết này khỏi workspace?')) return;

    setDeleting(post.id);
    setError(null);
    try {
      await postsApi.delete(workspace.id, post.id);
      await loadPosts();
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
      await loadPosts();
    } catch (duplicateError) {
      setError(getErrorMessage(duplicateError));
    } finally {
      setDuplicating(null);
    }
  }

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canRetry = hasPermission(workspace.role, 'post:publish');

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Posts</h1>
          <p className="mt-1 text-sm text-slate-600">Theo dõi trạng thái từng platform post.</p>
        </div>
        <div className="flex gap-2">
          <SecondaryButton disabled={loading} onClick={() => void loadPosts()} type="button">
            Làm mới
          </SecondaryButton>
          <Link
            className="inline-flex h-10 items-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white"
            href="/posts/new"
          >
            Tạo post
          </Link>
        </div>
      </header>

      <InlineError message={error} />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="divide-y divide-slate-200">
          {posts.map((post) => (
            <article key={post.id} className="p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-slate-950">
                      {post.title ?? 'Untitled post'}
                    </h2>
                    <StatusBadge status={post.status} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm text-slate-600">
                    {post.body ?? 'Không có nội dung.'}
                  </p>
                  {post.scheduledAt ? (
                    <p className="mt-2 text-xs font-medium text-slate-500">
                      Scheduled: {new Date(post.scheduledAt).toLocaleString()}
                    </p>
                  ) : null}
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
                    className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
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
            <p className="p-6 text-sm text-slate-600">Chưa có post nào.</p>
          ) : null}
        </div>
      </section>
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
