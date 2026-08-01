'use client';

import { hasPermission, PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import { Edit3, ExternalLink, Eye, RefreshCw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Fragment } from 'react';
import { useEffect, useState } from 'react';
import { DeletePostDialog } from '@/components/delete-post-dialog';
import {
  FallbackImage,
  mediaPreviewSources,
  mediaThumbnailSources,
} from '@/components/media-preview';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { platformsApi, postsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  extractPlatformPostMetrics,
  formatMetricNumber,
  hasVisibleMetrics,
  metricDefinitionsForPlatform,
  metricSourceLabel,
} from '@/lib/post-metrics';
import type {
  ContentPostView,
  DeletePostResult,
  MediaAssetView,
  PlatformCapabilitiesView,
  PlatformPostView,
  PublishNetworkProof,
  TikTokPlatformState,
  YouTubePlatformState,
} from '@/lib/types';

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

export default function PostDetailPage() {
  const auth = useAuth();
  const toast = useToast();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const workspace = auth.activeWorkspace;
  const [post, setPost] = useState<ContentPostView | null>(null);
  const [capabilityByPlatform, setCapabilityByPlatform] = useState<
    Partial<Record<Platform, PlatformCapabilitiesView>>
  >({});
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContentPostView | null>(null);
  const [previewAsset, setPreviewAsset] = useState<MediaAssetView | null>(null);
  const [platformAction, setPlatformAction] = useState<string | null>(null);
  const [expandedPlatformPostId, setExpandedPlatformPostId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!workspace) return;
    platformsApi
      .capabilities()
      .then((result) =>
        setCapabilityByPlatform(
          Object.fromEntries(result.platforms.map((item) => [item.platform, item])) as Partial<
            Record<Platform, PlatformCapabilitiesView>
          >,
        ),
      )
      .catch((loadError) => setError(getErrorMessage(loadError)));
  }, [workspace]);

  async function retry() {
    if (!workspace || !post) return;
    setRetrying(true);
    setError(null);
    try {
      await postsApi.retry(workspace.id, post.id);
      await loadPost();
      toast.info('Đã đưa bài vào queue retry.');
    } catch (retryError) {
      toast.error(getErrorMessage(retryError));
    } finally {
      setRetrying(false);
    }
  }

  function openDeleteDialog() {
    if (!post) return;
    if (!canDeletePostStatus(post.status)) {
      toast.warning('Bài này không ở trạng thái có thể xóa.');
      return;
    }
    setDeleteTarget(post);
  }

  async function deletePost(input: { platformPostIds: string[] }) {
    if (!workspace || !post) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await postsApi.delete(workspace.id, post.id, {
        deleteFromPlatforms: input.platformPostIds.length > 0,
        platformPostIds: input.platformPostIds,
      });
      setDeleteTarget(null);
      const message = deleteResultMessage(result);
      if (result.deleted) {
        toast.success(message);
        router.push('/posts');
      } else {
        await loadPost();
        if (deleteResultFailures(result).length > 0) {
          toast.warning(message);
        } else {
          toast.success(message);
        }
      }
    } catch (deleteError) {
      toast.error(getErrorMessage(deleteError));
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
      toast.success('Đã cập nhật trạng thái nền tảng.');
    } catch (refreshError) {
      toast.error(getErrorMessage(refreshError));
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
      toast.success('Đã chuyển YouTube video sang public.');
    } catch (publishError) {
      toast.error(getErrorMessage(publishError));
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
      toast.success('Đã hủy publish TikTok.');
    } catch (cancelError) {
      toast.error(getErrorMessage(cancelError));
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
          <Link className="text-sm font-medium text-brand-700 hover:text-brand-800" href="/posts">
            Quay lại Posts
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">
            {post?.title ?? 'Chi tiết bài đăng'}
          </h1>
          {post ? (
            <p className="mt-1 text-sm text-slate-600">
              {postStatusLabel(post.status)} · Tạo {formatDateTime(post.createdAt)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <IconButton disabled={loading} label="Làm mới" onClick={() => void loadPost()}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </IconButton>
          {post && canUpdate ? (
            <IconLink href={`/posts/${post.id}/edit`} label="Sửa">
              <Edit3 className="h-4 w-4" />
            </IconLink>
          ) : null}
          <IconButton
            disabled={!post || !canDelete || !canDeleteStatus || deleting}
            label="Xóa"
            onClick={openDeleteDialog}
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
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
            <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={post.status} />
                {post.derivedStatus !== post.status ? (
                  <StatusBadge status={`Derived: ${post.derivedStatus}`} />
                ) : null}
              </div>
              <p className="mt-4 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {post.body ?? 'Không có nội dung.'}
              </p>
              <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <InfoBlock
                  label="Link"
                  value={post.linkUrl ?? '-'}
                  href={post.linkUrl ?? undefined}
                />
                <InfoBlock
                  label="Hashtags"
                  value={
                    post.hashtags.length > 0 ? post.hashtags.map((tag) => `#${tag}`).join(' ') : '-'
                  }
                />
              </div>
              <MediaInfoPanel media={post.media} />
              <MediaStrip media={post.media} onPreview={setPreviewAsset} />
            </article>

            <aside className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
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
                Một số thao tác ngoài nền tảng chỉ khả dụng khi tài khoản còn kết nối và nền tảng hỗ
                trợ API tương ứng.
              </p>
            </aside>
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-950">Bản đăng theo nền tảng</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] table-fixed text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                  <tr>
                    <th className="w-56 px-4 py-3">Nền tảng</th>
                    <th className="w-36 px-4 py-3">Trạng thái</th>
                    <th className="w-24 px-4 py-3">Attempts</th>
                    <th className="px-4 py-3">Ghi chú</th>
                    <th className="w-48 px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {post.platformPosts.map((platformPost) => {
                    const expanded = expandedPlatformPostId === platformPost.id;
                    return (
                      <Fragment key={platformPost.id}>
                        <tr className="align-middle hover:bg-slate-50">
                          <td className="px-4 py-3">
                            <p className="truncate font-semibold text-slate-950">
                              {PLATFORM_LABELS[platformPost.platform]}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {platformPost.socialAccountName}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={platformPost.status} />
                          </td>
                          <td className="px-4 py-3 text-slate-700">{platformPost.attemptCount}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            <PlatformPostNote platformPost={platformPost} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-1.5">
                              {platformPost.externalUrl ? (
                                <IconLink
                                  href={platformPost.externalUrl}
                                  label="Mở bài trên nền tảng"
                                  external
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </IconLink>
                              ) : null}
                              <button
                                className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                                onClick={() =>
                                  setExpandedPlatformPostId(expanded ? null : platformPost.id)
                                }
                                type="button"
                              >
                                {expanded ? 'Ẩn' : 'Chi tiết'}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="bg-slate-50/70">
                            <td colSpan={5} className="px-4 pb-4 pt-0">
                              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                                <PlatformPostDetails
                                  canPublish={canPublish}
                                  onCancel={() => void cancelTikTokPublish(platformPost)}
                                  onMakePublic={() => void makeYouTubePublic(platformPost)}
                                  onPreview={setPreviewAsset}
                                  onRefresh={() => void refreshPlatformState(platformPost)}
                                  platformAction={platformAction}
                                  platformPost={platformPost}
                                />
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <details className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <summary className="cursor-pointer text-base font-semibold text-slate-950">
              Job history ({post.jobs.length})
            </summary>
            <div className="mt-4 overflow-x-auto">
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
          </details>
        </>
      ) : null}
      <DeletePostDialog
        busy={deleting}
        capabilityByPlatform={capabilityByPlatform}
        post={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(input) => void deletePost(input)}
      />
      <MediaPreviewDialog asset={previewAsset} onClose={() => setPreviewAsset(null)} />
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
          {platformAction === `refresh:${platformPost.id}`
            ? 'Đang làm mới...'
            : 'Làm mới trạng thái'}
        </SecondaryButton>
        <SecondaryButton
          disabled={!canCancel || platformAction !== null}
          onClick={onCancel}
          type="button"
        >
          {platformAction === `cancel:${platformPost.id}` ? 'Đang hủy...' : 'Hủy publish'}
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
          {platformAction === `refresh:${platformPost.id}`
            ? 'Đang làm mới...'
            : 'Làm mới trạng thái'}
        </SecondaryButton>
        <PrimaryButton
          busy={platformAction === `public:${platformPost.id}`}
          disabled={!canMakePublic || platformAction !== null}
          onClick={onMakePublic}
          type="button"
        >
          Chuyển public
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
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="break-all text-right font-medium text-slate-900">{value}</span>
    </div>
  );
}

function getPublishNetworkProof(
  state: PlatformPostView['platformState'],
): PublishNetworkProof | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const network = (state as Record<string, unknown>).publishNetwork;
  if (!network || typeof network !== 'object' || Array.isArray(network)) return null;
  const record = network as Record<string, unknown>;
  if (typeof record.checkedAt !== 'string') return null;
  return {
    checkedAt: record.checkedAt,
    ip: typeof record.ip === 'string' ? record.ip : null,
    countryCode: typeof record.countryCode === 'string' ? record.countryCode : null,
    country: typeof record.country === 'string' ? record.country : null,
    city: typeof record.city === 'string' ? record.city : null,
    isp: typeof record.isp === 'string' ? record.isp : null,
    provider: typeof record.provider === 'string' ? record.provider : null,
    checkOk: record.checkOk === true,
    checkError: typeof record.checkError === 'string' ? record.checkError : null,
    checkErrors: Array.isArray(record.checkErrors)
      ? record.checkErrors.filter((item): item is string => typeof item === 'string')
      : [],
    proxyEnabled: record.proxyEnabled === true,
    proxyAvailable: record.proxyAvailable === true,
    proxyActive: record.proxyActive === true,
    countryLock: typeof record.countryLock === 'string' ? record.countryLock : null,
    countryLockSatisfied: record.countryLockSatisfied === true,
  };
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

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {postStatusLabel(status)}
    </span>
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
    CANCELLED: 'Đã hủy',
    DELETED: 'Đã xóa',
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function canDeletePostStatus(status: ContentPostView['status']) {
  return DELETABLE_POST_STATUSES.includes(status as (typeof DELETABLE_POST_STATUSES)[number]);
}

function deleteResultFailures(result: DeletePostResult) {
  return result.remoteDeleteResults?.filter((item) => !item.deleted) ?? [];
}

function deleteResultMessage(result: DeletePostResult) {
  const failures = deleteResultFailures(result);
  const deletedTargetItems = result.remoteDeleteResults?.filter((item) => item.deleted) ?? [];
  const deletedTargetsText = summarizeDeleteTargets(deletedTargetItems);
  if (result.deleted) {
    return deletedTargetsText
      ? `Đã xóa bài viết khỏi workspace và xóa trên ${deletedTargetsText}.`
      : 'Đã xóa bài viết khỏi workspace.';
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
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      aria-label={label}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm disabled:cursor-not-allowed disabled:text-slate-400 ${props.className ?? ''}`}
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
  external = false,
}: {
  href: string;
  label: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <Link
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm"
      href={href}
      rel={external ? 'noreferrer' : undefined}
      target={external ? '_blank' : undefined}
      title={label}
    >
      {children}
    </Link>
  );
}

function InfoBlock({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 px-3 py-2">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      {href ? (
        <a
          className="mt-1 block truncate text-sm font-medium text-brand-700"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {value}
        </a>
      ) : (
        <p className="mt-1 truncate text-sm text-slate-800">{value}</p>
      )}
    </div>
  );
}

function MediaStrip({
  media,
  onPreview,
}: {
  media: MediaAssetView[];
  onPreview: (asset: MediaAssetView) => void;
}) {
  if (media.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {media.map((asset) => {
        const sources =
          asset.type === 'VIDEO' && asset.status !== 'ARCHIVED'
            ? mediaThumbnailSources(asset)
            : mediaPreviewSources(asset);
        return (
          <button
            key={asset.id}
            className="relative h-16 w-24 overflow-hidden rounded-md bg-slate-950 text-xs font-semibold text-white transition hover:-translate-y-px hover:shadow-md"
            onClick={() => onPreview(asset)}
            title={asset.originalFileName ?? 'Xem media'}
            type="button"
          >
            {(asset.type === 'IMAGE' || asset.status === 'ARCHIVED') && sources.length > 0 ? (
              <FallbackImage
                alt={asset.originalFileName ?? 'media'}
                className="h-full w-full object-cover"
                sources={sources}
              />
            ) : asset.type === 'VIDEO' ? (
              <>
                {sources.length > 0 ? (
                  <FallbackImage
                    alt={asset.originalFileName ?? 'video thumbnail'}
                    className="h-full w-full object-cover"
                    sources={sources}
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-slate-950 text-[11px] font-semibold text-white">
                    VIDEO
                  </span>
                )}
              </>
            ) : (
              <span className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500">
                {asset.type}
              </span>
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-slate-950/20 opacity-0 transition hover:opacity-100">
              <Eye className="h-5 w-5" />
            </span>
            {asset.status === 'ARCHIVED' ? (
              <span className="absolute bottom-1 left-1 rounded bg-slate-950/75 px-1 text-[9px] font-semibold text-white">
                ARCHIVED
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function MediaInfoPanel({ media }: { media: MediaAssetView[] }) {
  if (media.length === 0) {
    return (
      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Bài này không có media.
      </div>
    );
  }

  const images = media.filter((asset) => asset.type === 'IMAGE').length;
  const videos = media.filter((asset) => asset.type === 'VIDEO').length;
  const totalBytes = media.reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0);

  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase text-slate-500">
        <span>Media</span>
        {images > 0 ? <span className="rounded bg-white px-2 py-1">{images} ảnh</span> : null}
        {videos > 0 ? <span className="rounded bg-white px-2 py-1">{videos} video</span> : null}
        <span className="rounded bg-white px-2 py-1">{formatBytes(totalBytes)}</span>
      </div>
      <div className="mt-2 grid gap-2">
        {media.map((asset) => (
          <div
            key={asset.id}
            className="grid gap-1 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 sm:grid-cols-[1fr_auto_auto]"
          >
            <span className="min-w-0 truncate font-medium text-slate-800">
              {asset.originalFileName ?? asset.id}
            </span>
            <span>{asset.mimeType ?? asset.type}</span>
            <span className="font-semibold">{asset.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MediaPreviewDialog({
  asset,
  onClose,
}: {
  asset: MediaAssetView | null;
  onClose: () => void;
}) {
  const source = asset?.displayUrl ?? asset?.thumbnailUrl ?? asset?.readUrl;
  if (!asset || !source) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6">
      <div className="w-full max-w-4xl overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-semibold text-slate-950">
            {asset.originalFileName ?? 'Media preview'}
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

function PlatformPostNote({ platformPost }: { platformPost: PlatformPostView }) {
  const metrics = extractPlatformPostMetrics(platformPost);
  if (platformPost.errorMessage) {
    return (
      <span className="text-red-700">
        {platformPost.errorCode}: {platformPost.errorMessage}
      </span>
    );
  }
  if (metrics.error) return <span className="text-amber-700">Metrics: {metrics.error}</span>;
  if (hasVisibleMetrics(metrics)) {
    const views = metrics.values.views?.value ?? metrics.values.impressions?.value ?? null;
    const engagement = metrics.values.engagement?.value ?? null;
    return (
      <span>
        {formatMetricNumber(views)} views · {formatMetricNumber(engagement)} tương tác
      </span>
    );
  }
  if (hasPlatformOverride(platformPost)) return <span>Có override riêng</span>;
  if (platformPost.externalPostId) return <span>Đã có external ID</span>;
  return <span>-</span>;
}

function PlatformPostDetails({
  platformPost,
  platformAction,
  canPublish,
  onRefresh,
  onMakePublic,
  onCancel,
  onPreview,
}: {
  platformPost: PlatformPostView;
  platformAction: string | null;
  canPublish: boolean;
  onRefresh: () => void;
  onMakePublic: () => void;
  onCancel: () => void;
  onPreview: (asset: MediaAssetView) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <DetailInfo label="Target" value={PLATFORM_LABELS[platformPost.platform]} />
        <DetailInfo label="Account" value={platformPost.socialAccountName} />
        <DetailInfo label="External ID" value={platformPost.externalPostId ?? '-'} />
        <DetailInfo
          label="Published"
          value={platformPost.publishedAt ? formatDateTime(platformPost.publishedAt) : '-'}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <section className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-950">Nội dung target</h3>
            <span className="text-xs font-medium text-slate-500">
              {hasPlatformOverride(platformPost) ? 'Có tùy chỉnh riêng' : 'Dùng nội dung chung'}
            </span>
          </div>
          {hasPlatformOverride(platformPost) ? (
            <div className="mt-3 space-y-3 text-sm text-slate-700">
              {platformPost.title ? <DetailText label="Title" value={platformPost.title} /> : null}
              {platformPost.caption ? (
                <DetailText label="Caption" value={platformPost.caption} multiline />
              ) : null}
              {platformPost.description ? (
                <DetailText label="Description" value={platformPost.description} multiline />
              ) : null}
              {platformPost.linkUrl ? (
                <DetailText label="Link" value={platformPost.linkUrl} />
              ) : null}
              <MediaStrip media={platformPost.media} onPreview={onPreview} />
              {platformPost.options ? (
                <details className="rounded-md border border-slate-200 bg-white px-3 py-2">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-600">
                    Options kỹ thuật
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                    {JSON.stringify(platformPost.options, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
              Target này đang dùng title, caption, link và media từ nội dung chung của bài.
            </p>
          )}
        </section>

        <aside className="space-y-3">
          <PlatformMetricsPanel
            onRefresh={onRefresh}
            platformAction={platformAction}
            platformPost={platformPost}
          />
          {platformPost.platform === 'YOUTUBE' ? (
            <YouTubeStatePanel
              canPublish={canPublish}
              onMakePublic={onMakePublic}
              onRefresh={onRefresh}
              platformAction={platformAction}
              platformPost={platformPost}
            />
          ) : null}
          {platformPost.platform === 'TIKTOK' ? (
            <TikTokStatePanel
              canPublish={canPublish}
              onCancel={onCancel}
              onRefresh={onRefresh}
              platformAction={platformAction}
              platformPost={platformPost}
            />
          ) : null}
          <PublishNetworkPanel state={platformPost.platformState} />
        </aside>
      </div>
    </div>
  );
}

function PlatformMetricsPanel({
  platformPost,
  platformAction,
  onRefresh,
}: {
  platformPost: PlatformPostView;
  platformAction: string | null;
  onRefresh: () => void;
}) {
  const metrics = extractPlatformPostMetrics(platformPost);
  const definitions = metricDefinitionsForPlatform(platformPost.platform);
  const busy = platformAction === `refresh:${platformPost.id}`;
  const hasMetrics = hasVisibleMetrics(metrics);

  return (
    <section className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">
            Insights {PLATFORM_LABELS[platformPost.platform]}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {metrics.refreshedAt
              ? `Cập nhật ${formatDateTime(metrics.refreshedAt)}`
              : 'Chưa có snapshot metrics.'}
          </p>
        </div>
        <SecondaryButton
          disabled={!platformPost.externalPostId || platformAction !== null}
          onClick={onRefresh}
          type="button"
        >
          {busy ? 'Đang sync...' : 'Sync'}
        </SecondaryButton>
      </div>

      {metrics.error ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {metrics.error}
        </p>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {definitions.map((definition) => {
          const metric = metrics.values[definition.key];
          return (
            <div
              key={definition.key}
              className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
              title={definition.hint}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-semibold uppercase text-slate-500">
                  {definition.label}
                </p>
                <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                  {metricSourceLabel(metric?.source)}
                </span>
              </div>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {formatMetricNumber(metric?.value, definition.percent)}
              </p>
            </div>
          );
        })}
      </div>

      {!hasMetrics && !metrics.error ? (
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Chưa có số liệu thật. Bấm Sync sau khi bài đã publish; nếu nền tảng không cấp API metrics
          thì ô tương ứng sẽ giữ trạng thái chưa sync/không hỗ trợ.
        </p>
      ) : null}
    </section>
  );
}

function DetailInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 px-3 py-2">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-slate-900">{value}</p>
    </div>
  );
}

function DetailText({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p
        className={`mt-1 text-sm text-slate-800 ${multiline ? 'whitespace-pre-wrap' : 'break-all'}`}
      >
        {value}
      </p>
    </div>
  );
}

function PublishNetworkPanel({ state }: { state: PlatformPostView['platformState'] }) {
  const network = getPublishNetworkProof(state);
  if (!network) return null;
  const location = [network.city, network.country].filter(Boolean).join(', ') || '-';
  const tone =
    network.proxyActive && network.countryLockSatisfied && network.checkOk !== false
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : network.proxyEnabled
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-slate-200 bg-slate-50 text-slate-700';

  return (
    <div className={`rounded-md border p-3 text-xs ${tone}`}>
      <p className="font-semibold uppercase">Publish network proof</p>
      <p className="mt-1 text-xs opacity-80">
        Snapshot lúc bài này được publish, không phải trạng thái proxy hiện tại.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <StateRow label="IP publish" value={network.ip ?? '-'} />
        <StateRow label="Quốc gia" value={network.countryCode ?? '-'} />
        <StateRow label="Vị trí" value={location} />
        <StateRow label="ISP" value={network.isp ?? '-'} />
        <StateRow label="Provider" value={network.provider ?? '-'} />
        <StateRow label="Check OK" value={network.checkOk === false ? 'NO' : 'YES'} />
        <StateRow label="Proxy" value={network.proxyActive ? 'ACTIVE' : 'NOT ACTIVE'} />
        <StateRow label="Country lock" value={network.countryLock ?? '-'} />
        <StateRow label="Lock OK" value={network.countryLockSatisfied ? 'YES' : 'NO'} />
        <StateRow label="Checked" value={formatDateTime(network.checkedAt)} />
      </div>
      {network.checkErrors?.length ? (
        <div className="mt-2 space-y-1">
          {network.checkErrors.map((error) => (
            <p key={error} className="break-words">
              {error}
            </p>
          ))}
        </div>
      ) : network.checkError ? (
        <p className="mt-2 break-words">{network.checkError}</p>
      ) : null}
    </div>
  );
}
