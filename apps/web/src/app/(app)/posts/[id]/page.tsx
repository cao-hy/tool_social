'use client';

import { hasPermission, PLATFORM_LABELS } from '@socialhub/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DeletePostDialog } from '@/components/delete-post-dialog';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { MediaPreview } from '@/components/media-preview';
import { postsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type {
  ContentPostView,
  PlatformPostView,
  TikTokPlatformState,
  YouTubePlatformState,
} from '@/lib/types';

const DELETABLE_POST_STATUSES = [
  'DRAFT',
  'FAILED',
  'SCHEDULED',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
] as const;

export default function PostDetailPage() {
  const auth = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const workspace = auth.activeWorkspace;
  const [post, setPost] = useState<ContentPostView | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContentPostView | null>(null);
  const [platformAction, setPlatformAction] = useState<string | null>(null);
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

  function openDeleteDialog() {
    if (!post) return;
    if (!canDeletePostStatus(post.status)) {
      setError('Bài này không ở trạng thái có thể xóa.');
      return;
    }
    setDeleteTarget(post);
  }

  async function deletePost(input: { platformPostIds: string[] }) {
    if (!workspace || !post) return;
    setDeleting(true);
    setError(null);
    try {
      await postsApi.delete(workspace.id, post.id, {
        deleteFromPlatforms: input.platformPostIds.length > 0,
        platformPostIds: input.platformPostIds,
      });
      setDeleteTarget(null);
      router.push('/posts');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setDeleting(false);
    }
  }

  async function refreshPlatformState(platformPost: PlatformPostView) {
    if (!workspace || !post) return;
    setPlatformAction(`refresh:${platformPost.id}`);
    setError(null);
    try {
      const result = await postsApi.refreshPlatformState(workspace.id, post.id, platformPost.id);
      setPost(result.post);
    } catch (refreshError) {
      setError(getErrorMessage(refreshError));
    } finally {
      setPlatformAction(null);
    }
  }

  async function makeYouTubePublic(platformPost: PlatformPostView) {
    if (!workspace || !post) return;
    setPlatformAction(`public:${platformPost.id}`);
    setError(null);
    try {
      const result = await postsApi.makeYouTubePublic(workspace.id, post.id, platformPost.id);
      setPost(result.post);
    } catch (publishError) {
      setError(getErrorMessage(publishError));
    } finally {
      setPlatformAction(null);
    }
  }

  async function cancelTikTokPublish(platformPost: PlatformPostView) {
    if (!workspace || !post) return;
    if (!window.confirm('Hủy publish TikTok đang chờ xử lý?')) return;
    setPlatformAction(`cancel:${platformPost.id}`);
    setError(null);
    try {
      const result = await postsApi.cancelTikTokPublish(workspace.id, post.id, platformPost.id);
      setPost(result.post);
    } catch (cancelError) {
      setError(getErrorMessage(cancelError));
    } finally {
      setPlatformAction(null);
    }
  }

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canRetry = hasPermission(workspace.role, 'post:publish');
  const canPublish = hasPermission(workspace.role, 'post:publish');
  const canDelete = hasPermission(workspace.role, 'post:delete');
  const canUpdate = hasPermission(workspace.role, 'post:update');
  const hasFailedPlatformPost =
    post?.platformPosts.some((item) => item.status === 'FAILED') ?? false;
  const canDeleteStatus = post ? canDeletePostStatus(post.status) : false;

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
            disabled={!post || !canDelete || !canDeleteStatus || deleting}
            onClick={openDeleteDialog}
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
                  {hasPlatformOverride(platformPost) ? (
                    <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
                      <p className="text-xs font-semibold uppercase text-slate-500">
                        Override cho target này
                      </p>
                      <div className="mt-2 space-y-2 text-sm text-slate-700">
                        {platformPost.title ? (
                          <p>
                            <span className="font-semibold text-slate-900">Title:</span>{' '}
                            {platformPost.title}
                          </p>
                        ) : null}
                        {platformPost.caption ? (
                          <p className="whitespace-pre-wrap">
                            <span className="font-semibold text-slate-900">Caption:</span>{' '}
                            {platformPost.caption}
                          </p>
                        ) : null}
                        {platformPost.description ? (
                          <p className="whitespace-pre-wrap">
                            <span className="font-semibold text-slate-900">Description:</span>{' '}
                            {platformPost.description}
                          </p>
                        ) : null}
                        {platformPost.linkUrl ? (
                          <p className="break-all">
                            <span className="font-semibold text-slate-900">Link:</span>{' '}
                            {platformPost.linkUrl}
                          </p>
                        ) : null}
                      </div>
                      {platformPost.media.length > 0 ? (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {platformPost.media.map((asset) => (
                            <MediaPreview key={asset.id} asset={asset} className="max-h-40" />
                          ))}
                        </div>
                      ) : null}
                      {platformPost.options ? (
                        <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                          {JSON.stringify(platformPost.options, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                  {platformPost.platform === 'YOUTUBE' ? (
                    <YouTubeStatePanel
                      canPublish={canPublish}
                      onMakePublic={() => void makeYouTubePublic(platformPost)}
                      onRefresh={() => void refreshPlatformState(platformPost)}
                      platformAction={platformAction}
                      platformPost={platformPost}
                    />
                  ) : null}
                  {platformPost.platform === 'TIKTOK' ? (
                    <TikTokStatePanel
                      canPublish={canPublish}
                      onCancel={() => void cancelTikTokPublish(platformPost)}
                      onRefresh={() => void refreshPlatformState(platformPost)}
                      platformAction={platformAction}
                      platformPost={platformPost}
                    />
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
      <DeletePostDialog
        busy={deleting}
        post={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(input) => void deletePost(input)}
      />
    </div>
  );
}

function TikTokStatePanel({
  platformPost,
  platformAction,
  canPublish,
  onRefresh,
  onCancel,
}: {
  platformPost: PlatformPostView;
  platformAction: string | null;
  canPublish: boolean;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const state = isTikTokPlatformState(platformPost.platformState)
    ? platformPost.platformState
    : null;
  const finalIds = state?.publiclyAvailablePostIds?.join(', ') || '-';
  const publishId = state?.publishId ?? platformPost.externalPostId ?? '';
  const status = String(state?.status ?? '').toUpperCase();
  const sentToInbox = status === 'SEND_TO_USER_INBOX' || publishId.startsWith('v_inbox_');
  const directComplete = status === 'PUBLISH_COMPLETE' || finalIds !== '-';
  const canCancel =
    canPublish &&
    Boolean(platformPost.externalPostId) &&
    !['PUBLISH_COMPLETE', 'FAILED', 'CANCELLED'].includes(status);

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
      {sentToInbox ? (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          TikTok đã nhận video vào Inbox/Draft. Bài này chưa public cho người khác xem cho tới khi
          bạn mở TikTok và đăng thủ công.
        </p>
      ) : null}
      {directComplete ? (
        <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
          TikTok đã hoàn tất publish. Nếu privacy là Public, người khác có thể xem bài trên TikTok.
        </p>
      ) : null}
      <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
        <StateRow label="Publish ID" value={publishId || '-'} />
        <StateRow label="Status" value={state?.status ?? '-'} />
        <StateRow
          label="Uploaded"
          value={state?.uploadedBytes ? `${state.uploadedBytes} bytes` : '-'}
        />
        <StateRow label="Final IDs" value={finalIds} />
        <StateRow
          label="Refreshed"
          value={state?.refreshedAt ? formatDateTime(state.refreshedAt) : '-'}
        />
      </div>
      {state?.failReason ? (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {state.failReason}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton
          disabled={!platformPost.externalPostId || platformAction !== null}
          onClick={onRefresh}
          type="button"
        >
          {platformAction === `refresh:${platformPost.id}` ? 'Đang refresh...' : 'Refresh status'}
        </SecondaryButton>
        <SecondaryButton
          disabled={!canCancel || platformAction !== null}
          onClick={onCancel}
          type="button"
        >
          {platformAction === `cancel:${platformPost.id}` ? 'Đang hủy...' : 'Cancel publish'}
        </SecondaryButton>
      </div>
    </div>
  );
}

function YouTubeStatePanel({
  platformPost,
  platformAction,
  canPublish,
  onRefresh,
  onMakePublic,
}: {
  platformPost: PlatformPostView;
  platformAction: string | null;
  canPublish: boolean;
  onRefresh: () => void;
  onMakePublic: () => void;
}) {
  const state = isYouTubePlatformState(platformPost.platformState)
    ? platformPost.platformState
    : null;
  const processing = state?.processingStatus ?? '-';
  const privacy = state?.privacyStatus ?? '-';
  const upload = state?.uploadStatus ?? '-';
  const progress = processingProgressText(state);
  const canMakePublic =
    canPublish &&
    Boolean(platformPost.externalPostId) &&
    state?.privacyStatus !== 'public' &&
    state?.processingStatus !== 'processing' &&
    state?.processingStatus !== 'failed';

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
      <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
        <StateRow label="Processing" value={processing} />
        <StateRow label="Privacy" value={privacy} />
        <StateRow label="Upload" value={upload} />
        <StateRow label="Progress" value={progress} />
        <StateRow
          label="Refreshed"
          value={state?.refreshedAt ? formatDateTime(state.refreshedAt) : '-'}
        />
      </div>
      {state?.processingFailureReason ? (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {state.processingFailureReason}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton
          disabled={!platformPost.externalPostId || platformAction !== null}
          onClick={onRefresh}
          type="button"
        >
          {platformAction === `refresh:${platformPost.id}` ? 'Đang refresh...' : 'Refresh status'}
        </SecondaryButton>
        <PrimaryButton
          busy={platformAction === `public:${platformPost.id}`}
          disabled={!canMakePublic || platformAction !== null}
          onClick={onMakePublic}
          type="button"
        >
          Make public
        </PrimaryButton>
      </div>
      {state?.processingStatus === 'processing' ? (
        <p className="mt-2 text-xs text-amber-700">
          YouTube vẫn đang xử lý video. Khi trạng thái thành succeeded thì có thể public.
        </p>
      ) : null}
    </div>
  );
}

function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-900">{value}</span>
    </div>
  );
}

function isYouTubePlatformState(value: unknown): value is YouTubePlatformState {
  return Boolean(value && typeof value === 'object' && 'videoId' in value);
}

function isTikTokPlatformState(value: unknown): value is TikTokPlatformState {
  return Boolean(value && typeof value === 'object' && 'publishId' in value);
}

function processingProgressText(state: YouTubePlatformState | null): string {
  const progress = state?.processingProgress;
  if (!progress?.partsTotal || progress.partsProcessed === undefined) return '-';
  const percent = Math.round((progress.partsProcessed / progress.partsTotal) * 100);
  const timeLeft =
    progress.timeLeftMs === undefined ? '' : ` · còn ${Math.ceil(progress.timeLeftMs / 1000)}s`;
  return `${percent}%${timeLeft}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function hasPlatformOverride(platformPost: PlatformPostView): boolean {
  return Boolean(
    platformPost.title ||
    platformPost.caption ||
    platformPost.description ||
    platformPost.linkUrl ||
    platformPost.options ||
    platformPost.media.length > 0,
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

function canDeletePostStatus(status: ContentPostView['status']) {
  return DELETABLE_POST_STATUSES.includes(status as (typeof DELETABLE_POST_STATUSES)[number]);
}
