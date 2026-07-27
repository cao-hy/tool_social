'use client';

import { hasPermission, PLATFORM_LABELS } from '@socialhub/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { MediaPreview } from '@/components/media-preview';
import { postsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { ContentPostView } from '@/lib/types';

export default function PostDetailPage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const workspace = auth.activeWorkspace;
  const [post, setPost] = useState<ContentPostView | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPost() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      setPost(await postsApi.get(workspace.id, params.id));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPost();
  }, [workspace, params.id]);

  async function retry() {
    if (!workspace || !post) return;
    setRetrying(true);
    setError(null);
    try {
      await postsApi.retry(workspace.id, post.id);
      await loadPost();
    } catch (retryError) {
      setError(getErrorMessage(retryError));
    } finally {
      setRetrying(false);
    }
  }

  async function deletePost() {
    if (!workspace || !post) return;
    if (!window.confirm('Xóa bài viết này khỏi workspace?')) return;
    setDeleting(true);
    setError(null);
    try {
      await postsApi.delete(workspace.id, post.id);
      router.push('/posts');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setDeleting(false);
    }
  }

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canRetry = hasPermission(workspace.role, 'post:publish');
  const canDelete = hasPermission(workspace.role, 'post:delete');
  const canUpdate = hasPermission(workspace.role, 'post:update');
  const hasFailedPlatformPost =
    post?.platformPosts.some((item) => item.status === 'FAILED') ?? false;
  const canDeleteLocal = post ? ['DRAFT', 'FAILED', 'SCHEDULED'].includes(post.status) : false;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <Link className="text-sm font-medium text-brand-700" href="/posts">
            Back to posts
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">
            {post?.title ?? 'Post detail'}
          </h1>
          {post ? (
            <p className="mt-1 text-sm text-slate-600">
              {post.status} · Created {formatDateTime(post.createdAt)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={loading} onClick={() => void loadPost()} type="button">
            Làm mới
          </SecondaryButton>
          {post && canUpdate ? (
            <Link
              className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              href={`/posts/${post.id}/edit`}
            >
              Edit
            </Link>
          ) : null}
          <SecondaryButton
            disabled={!post || !canDelete || !canDeleteLocal || deleting}
            onClick={() => void deletePost()}
            title={
              post?.status === 'PUBLISHED'
                ? 'Remote delete chưa được capability matrix xác minh; local delete bị khóa để tránh lệch dữ liệu.'
                : undefined
            }
            type="button"
          >
            {deleting ? 'Đang xóa...' : 'Delete'}
          </SecondaryButton>
          <PrimaryButton
            busy={retrying}
            disabled={!post || !canRetry || !hasFailedPlatformPost}
            onClick={() => void retry()}
            type="button"
          >
            Retry lỗi
          </PrimaryButton>
        </div>
      </header>

      <InlineError message={error} />

      {!post && loading ? (
        <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
          Đang tải post...
        </p>
      ) : null}

      {post ? (
        <>
          <section className="grid gap-5 xl:grid-cols-[1fr_360px]">
            <article className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={post.status} />
                <StatusBadge status={`Derived: ${post.derivedStatus}`} />
              </div>
              <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">
                {post.body ?? 'Không có nội dung.'}
              </p>
              {post.linkUrl ? (
                <a
                  className="mt-3 inline-block text-sm font-medium text-brand-700"
                  href={post.linkUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {post.linkUrl}
                </a>
              ) : null}
              {post.hashtags.length > 0 ? (
                <p className="mt-3 text-sm text-brand-700">
                  {post.hashtags.map((tag) => `#${tag}`).join(' ')}
                </p>
              ) : null}
              {post.media.length > 0 ? (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {post.media.map((asset) => (
                    <div key={asset.id} className="rounded-md border border-slate-200 p-3">
                      <MediaPreview asset={asset} />
                      <p className="mt-2 truncate text-sm font-medium text-slate-900">
                        {asset.originalFileName ?? asset.id}
                      </p>
                      <p className="text-xs text-slate-500">
                        {asset.mimeType ?? asset.type} · {asset.sizeBytes ?? 0} bytes
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>

            <aside className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-950">Timeline</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="Created" value={formatDateTime(post.createdAt)} />
                <Row label="Updated" value={formatDateTime(post.updatedAt)} />
                <Row
                  label="Scheduled"
                  value={post.scheduledAt ? formatDateTime(post.scheduledAt) : '-'}
                />
                <Row
                  label="Published"
                  value={post.publishedAt ? formatDateTime(post.publishedAt) : '-'}
                />
              </dl>
              <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Manual sync và remote delete chỉ bật sau khi capability chính thức của nền tảng được
                xác minh trong matrix.
              </p>
            </aside>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold text-slate-950">Platform posts</h2>
            <div className="mt-3 grid gap-3 xl:grid-cols-2">
              {post.platformPosts.map((platformPost) => (
                <article
                  key={platformPost.id}
                  className="rounded-md border border-slate-200 bg-slate-50 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {PLATFORM_LABELS[platformPost.platform]} · {platformPost.socialAccountName}
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
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold text-slate-950">Job history</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Queue</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Attempts</th>
                    <th className="py-2 pr-4">Started</th>
                    <th className="py-2 pr-4">Duration</th>
                    <th className="py-2 pr-4">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {post.jobs.map((job) => (
                    <tr key={job.id}>
                      <td className="py-3 pr-4 font-medium text-slate-900">{job.queueName}</td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={job.status} />
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {job.attempts}/{job.maxAttempts}
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {job.startedAt ? formatDateTime(job.startedAt) : '-'}
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {job.durationMs === null ? '-' : `${job.durationMs} ms`}
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {job.errorMessage ? `${job.errorCode}: ${job.errorMessage}` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {post.jobs.length === 0 ? (
                <p className="py-4 text-sm text-slate-600">Chưa có job history cho post này.</p>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status.includes('PUBLISHED') || status === 'COMPLETED'
      ? 'bg-emerald-50 text-emerald-700'
      : status.includes('FAILED') || status === 'DEAD'
        ? 'bg-red-50 text-red-700'
        : status === 'PROCESSING' || status === 'QUEUED' || status === 'RUNNING'
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
