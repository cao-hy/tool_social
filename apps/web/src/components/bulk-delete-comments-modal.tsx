'use client';

import { PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import {
  AlertTriangle,
  CheckCircle2,
  EyeOff,
  Link2,
  MessageSquareOff,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { useWorkspaceEventSubscription } from '@/components/workspace-events-provider';
import { commentsApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';
import type {
  BulkModerateCommentAction,
  CommentView,
  ContentPostView,
  PlatformCapabilitiesView,
  PlatformPostView,
} from '@/lib/types';

type AuthorSourceFilter = 'PAGE' | 'VIEWER' | 'ALL';
type ModalPlatformFilter = 'ALL' | 'FACEBOOK' | 'INSTAGRAM' | 'YOUTUBE';

const PLATFORM_BADGE_STYLES: Record<Platform, string> = {
  FACEBOOK: 'bg-blue-50 text-blue-700 border-blue-200',
  INSTAGRAM: 'bg-pink-50 text-pink-700 border-pink-200',
  YOUTUBE: 'bg-red-50 text-red-700 border-red-200',
  TIKTOK: 'bg-slate-900 text-white border-slate-800',
  PINTEREST: 'bg-rose-50 text-rose-700 border-rose-200',
};

const PLATFORM_SHORT_CODES: Record<Platform, string> = {
  FACEBOOK: 'FB',
  INSTAGRAM: 'IG',
  YOUTUBE: 'YT',
  TIKTOK: 'TT',
  PINTEREST: 'PIN',
};

const URL_DETECTION_REGEX = /(https?:\/\/\S+|\/s\/[a-zA-Z0-9_-]+)/i;

export function isModerateCommentSupportedPlatform(
  platform: Platform,
  capabilityByPlatform?: Partial<Record<Platform, PlatformCapabilitiesView>>,
): boolean {
  const delCap = capabilityByPlatform?.[platform]?.capabilities?.deleteComment;
  const hideCap = capabilityByPlatform?.[platform]?.capabilities?.hideComment;
  if (delCap || hideCap) {
    return (
      delCap?.state === 'SUPPORTED' ||
      delCap?.state === 'CONDITIONAL' ||
      hideCap?.state === 'SUPPORTED' ||
      hideCap?.state === 'CONDITIONAL'
    );
  }
  return platform === 'FACEBOOK' || platform === 'INSTAGRAM' || platform === 'YOUTUBE';
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Vừa xong';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} giờ trước`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} ngày trước`;
  return new Date(ts).toLocaleDateString('vi-VN');
}

function resolvePostReadableSnippet(post: ContentPostView, target: PlatformPostView): string {
  const raw =
    post.title?.trim() ||
    post.body?.trim() ||
    target.title?.trim() ||
    target.caption?.trim() ||
    target.description?.trim() ||
    '';
  if (!raw) return 'Bài đăng không có tiêu đề';
  const firstLine =
    raw
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? raw;
  return firstLine.length > 70 ? `${firstLine.slice(0, 70)}…` : firstLine;
}

interface BulkDeleteCommentsModalProps {
  workspaceId: string;
  posts: ContentPostView[];
  activeStoreName?: string | null;
  activeStoreColor?: string | null;
  capabilityByPlatform?: Partial<Record<Platform, PlatformCapabilitiesView>>;
  onClose: () => void;
  onSubmitted?: () => void;
}

export function BulkDeleteCommentsModal({
  workspaceId,
  posts,
  activeStoreName,
  activeStoreColor,
  capabilityByPlatform,
  onClose,
  onSubmitted,
}: BulkDeleteCommentsModalProps) {
  const toast = useToast();

  const [comments, setComments] = useState<CommentView[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [syncingFromPlatforms, setSyncingFromPlatforms] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Smart Filters & Safety Toggles
  const [authorSource, setAuthorSource] = useState<AuthorSourceFilter>('PAGE');
  const [platformFilter, setPlatformFilter] = useState<ModalPlatformFilter>('ALL');
  const [keyword, setKeyword] = useState('');
  const [skipWithCustomerReplies, setSkipWithCustomerReplies] = useState(true);
  const [onlyWithLinks, setOnlyWithLinks] = useState(false);
  const [onlyLatestPagePerPost, setOnlyLatestPagePerPost] = useState(false);

  // Action Mode & Selection
  const [actionMode, setActionMode] = useState<BulkModerateCommentAction>('DELETE_FROM_PLATFORM');
  const [uncheckedIds, setUncheckedIds] = useState<Set<string>>(new Set());

  const reloadTimerRef = useRef<number | null>(null);

  const supportedTargets = useMemo(() => {
    const list: Array<{ post: ContentPostView; target: PlatformPostView }> = [];
    for (const post of posts) {
      for (const pp of post.platformPosts) {
        if (
          pp.status === 'PUBLISHED' &&
          Boolean(pp.externalPostId) &&
          isModerateCommentSupportedPlatform(pp.platform, capabilityByPlatform)
        ) {
          list.push({ post, target: pp });
        }
      }
    }
    return list;
  }, [capabilityByPlatform, posts]);

  const targetMetaByPlatformPostId = useMemo(() => {
    const map = new Map<string, { post: ContentPostView; target: PlatformPostView }>();
    for (const item of supportedTargets) {
      map.set(item.target.id, item);
    }
    return map;
  }, [supportedTargets]);

  const supportedPlatformPostIds = useMemo(
    () => supportedTargets.map((item) => item.target.id),
    [supportedTargets],
  );

  const loadComments = useCallback(
    async (options?: { silent?: boolean }) => {
      if (supportedPlatformPostIds.length === 0) {
        setComments([]);
        return;
      }
      if (!options?.silent) {
        setLoadingComments(true);
      }
      try {
        const chunkSize = 150;
        const merged = new Map<string, CommentView>();
        for (let i = 0; i < supportedPlatformPostIds.length; i += chunkSize) {
          const chunk = supportedPlatformPostIds.slice(i, i + chunkSize);
          const res = await commentsApi.list(workspaceId, {
            platformPostIds: chunk,
            limit: 500,
          });
          for (const item of res.items) {
            merged.set(item.id, item);
          }
        }
        const sorted = Array.from(merged.values()).sort(
          (a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt),
        );
        setComments(sorted);
      } catch (err) {
        if (!options?.silent) {
          toast.error(getErrorMessage(err));
        }
      } finally {
        if (!options?.silent) {
          setLoadingComments(false);
        }
      }
    },
    [supportedPlatformPostIds, toast, workspaceId],
  );

  useEffect(() => {
    if (posts.length === 0) return;
    setUncheckedIds(new Set());
    void loadComments();
  }, [loadComments, posts.length]);

  useEffect(() => {
    return () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []);

  useWorkspaceEventSubscription((event) => {
    if (posts.length === 0) return;
    if (
      event.type === 'comments.synced' &&
      (!event.platformPostId || targetMetaByPlatformPostId.has(event.platformPostId))
    ) {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void loadComments({ silent: true });
      }, 600);
    }
  });

  function handleChangeAuthorSource(next: AuthorSourceFilter) {
    setAuthorSource(next);
    setUncheckedIds(new Set());
    if (next === 'PAGE' && actionMode === 'HIDE_ON_PLATFORM') {
      setActionMode('DELETE_FROM_PLATFORM');
    } else if (next === 'VIEWER' && actionMode === 'DELETE_FROM_PLATFORM') {
      // Gợi ý chế độ Ẩn trên MXH khi chuyển sang dọn bình luận người xem (giữ Social Proof)
      setActionMode('HIDE_ON_PLATFORM');
    }
  }

  const normalizedKeyword = keyword.trim().toLowerCase();

  // Đếm số bình luận đang được bảo vệ bởi toggle `skipWithCustomerReplies`
  const protectedCustomerThreadCount = useMemo(() => {
    return comments.filter((cmt) => {
      if (authorSource === 'PAGE' && !cmt.isFromPage) return false;
      if (authorSource === 'VIEWER' && cmt.isFromPage) return false;
      if (platformFilter !== 'ALL' && cmt.platform !== platformFilter) return false;
      return (cmt.customerReplyCount ?? 0) > 0;
    }).length;
  }, [authorSource, comments, platformFilter]);

  const filteredComments = useMemo(() => {
    const base = comments.filter((cmt) => {
      if (authorSource === 'PAGE' && !cmt.isFromPage) return false;
      if (authorSource === 'VIEWER' && cmt.isFromPage) return false;
      if (platformFilter !== 'ALL' && cmt.platform !== platformFilter) return false;

      if (skipWithCustomerReplies && (cmt.customerReplyCount ?? 0) > 0) {
        return false;
      }

      const msg = cmt.message ?? '';
      if (onlyWithLinks && !URL_DETECTION_REGEX.test(msg)) {
        return false;
      }

      if (normalizedKeyword) {
        const author = cmt.authorName?.toLowerCase() ?? '';
        if (!msg.toLowerCase().includes(normalizedKeyword) && !author.includes(normalizedKeyword)) {
          return false;
        }
      }

      if (
        actionMode === 'HIDE_ON_PLATFORM' &&
        (cmt.isHidden || (cmt.isFromPage && cmt.platform !== 'YOUTUBE'))
      ) {
        return false;
      }

      return true;
    });

    if (onlyLatestPagePerPost && authorSource === 'PAGE') {
      const seenPostIds = new Set<string>();
      const latestOnly: CommentView[] = [];
      // `comments` đã được sort mới nhất -> cũ nhất
      for (const cmt of base) {
        if (seenPostIds.has(cmt.platformPostId)) continue;
        seenPostIds.add(cmt.platformPostId);
        latestOnly.push(cmt);
      }
      return latestOnly;
    }

    return base;
  }, [
    actionMode,
    authorSource,
    comments,
    normalizedKeyword,
    onlyLatestPagePerPost,
    onlyWithLinks,
    platformFilter,
    skipWithCustomerReplies,
  ]);

  const selectedComments = useMemo(
    () => filteredComments.filter((cmt) => !uncheckedIds.has(cmt.id)),
    [filteredComments, uncheckedIds],
  );

  const matchedPostCount = useMemo(
    () => new Set(filteredComments.map((cmt) => cmt.platformPostId)).size,
    [filteredComments],
  );

  const selectedWithChildCount = useMemo(
    () => selectedComments.filter((cmt) => (cmt.childCommentCount ?? 0) > 0).length,
    [selectedComments],
  );

  if (posts.length === 0) {
    return null;
  }

  function toggleOneComment(commentId: string) {
    setUncheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
      }
      return next;
    });
  }

  function selectAllFiltered() {
    setUncheckedIds(new Set());
  }

  function deselectAllFiltered() {
    setUncheckedIds(new Set(filteredComments.map((item) => item.id)));
  }

  async function handleBulkSyncFromPlatforms() {
    if (supportedPlatformPostIds.length === 0) return;
    setSyncingFromPlatforms(true);
    try {
      const res = await commentsApi.bulkSync(workspaceId, supportedPlatformPostIds);
      if (res.queued > 0) {
        toast.success(
          `Đã đưa ${res.queued} bản đăng vào hàng đợi kéo bình luận mới từ MXH. Danh sách sẽ tự làm mới sau vài giây...`,
        );
        window.setTimeout(() => {
          void loadComments({ silent: true });
        }, 3200);
      } else {
        toast.warning('Không có bản đăng nào đủ điều kiện đồng bộ bình luận.');
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSyncingFromPlatforms(false);
    }
  }

  async function handleSubmit() {
    if (selectedComments.length === 0) {
      toast.warning('Hãy chọn ít nhất 1 bình luận để thực hiện.');
      return;
    }

    if (actionMode === 'DELETE_FROM_PLATFORM') {
      const childNotice =
        selectedWithChildCount > 0
          ? `\nLưu ý: Có ${selectedWithChildCount} bình luận gốc đang kèm phản hồi con bên dưới cũng sẽ bị xóa theo.`
          : '';
      const ok = window.confirm(
        `Xác nhận xóa vĩnh viễn ${selectedComments.length} bình luận đã chọn trên mạng xã hội?${childNotice}\n\nHành động này không thể khôi phục trên nền tảng.`,
      );
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      const res = await commentsApi.bulkModerate(workspaceId, {
        commentIds: selectedComments.map((item) => item.id),
        action: actionMode,
      });

      const dedupText =
        res.skippedByParent > 0 ? ` (tự động gộp ${res.skippedByParent} phản hồi con)` : '';

      if (res.failed > 0) {
        const firstError = res.results.find((r) => !r.processed)?.errorMessage;
        toast.warning(
          `Đã xử lý ${res.processed}/${res.requested} bình luận${dedupText}. Lỗi ${res.failed} mục${
            firstError ? `: ${firstError}` : ''
          }.`,
        );
      } else if (actionMode === 'HIDE_ON_PLATFORM') {
        toast.success(
          `Đã đưa ${res.queued} bình luận vào hàng đợi Ẩn trên MXH (giãn nhịp an toàn).`,
        );
      } else if (actionMode === 'DELETE_LOCAL_ONLY') {
        toast.success(`Đã gỡ ${res.processed} bình luận khỏi danh sách hệ thống${dedupText}.`);
      } else {
        toast.success(`Đã đưa ${res.queued} bình luận vào hàng đợi xóa ngầm trên MXH${dedupText}!`);
      }

      onSubmitted?.();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const hasPageSelectedForHide = actionMode === 'HIDE_ON_PLATFORM' && authorSource === 'PAGE';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 sm:p-5">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <MessageSquareOff className="h-5 w-5 text-rose-600" />
              <h2 className="text-lg font-bold text-slate-950">Dọn / Xóa bình luận hàng loạt</h2>
              {activeStoreName ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-800">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: activeStoreColor ?? '#2563eb' }}
                  />
                  {activeStoreName}
                </span>
              ) : null}
              <span className="rounded-full bg-slate-200/80 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                {supportedTargets.length} bản đăng (FB / IG / YT)
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              Lọc chính xác bình luận cần gỡ hoặc ẩn trên nhiều bài cùng lúc — có bảo vệ luồng khách
              hỏi mua và giãn nhịp chống Rate Limit.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
              disabled={syncingFromPlatforms || supportedPlatformPostIds.length === 0}
              onClick={() => void handleBulkSyncFromPlatforms()}
              title="Kéo bình luận mới nhất từ Facebook / Instagram / YouTube về trước khi lọc"
              type="button"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 text-brand-600 ${
                  syncingFromPlatforms ? 'animate-spin' : ''
                }`}
              />
              {syncingFromPlatforms ? 'Đang kéo từ MXH...' : 'Làm mới bình luận từ MXH'}
            </button>

            <button
              aria-label="Đóng"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-200/70 hover:text-slate-700"
              onClick={onClose}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filter & Safety Bar */}
        <div className="space-y-3 border-b border-slate-200 bg-white px-5 py-3.5">
          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-semibold text-slate-600">Đối tượng:</span>
              {(
                [
                  {
                    id: 'PAGE',
                    label: 'Của Page / Kênh đăng',
                    hint: 'An toàn: chỉ quét comment của shop (link /s/, mã sale...)',
                  },
                  {
                    id: 'VIEWER',
                    label: 'Người xem / Khách',
                    hint: 'Dùng để ẩn/xóa spam hoặc tiêu cực từ người ngoài',
                  },
                  {
                    id: 'ALL',
                    label: 'Tất cả',
                    hint: 'Quét toàn bộ bình luận trên các bài đã chọn',
                  },
                ] as const
              ).map((tab) => {
                const active = authorSource === tab.id;
                return (
                  <button
                    key={tab.id}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                      active
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                    onClick={() => handleChangeAuthorSource(tab.id)}
                    title={tab.hint}
                    type="button"
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                {(['ALL', 'FACEBOOK', 'INSTAGRAM', 'YOUTUBE'] as const).map((plat) => {
                  const active = platformFilter === plat;
                  return (
                    <button
                      key={plat}
                      className={`rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                        active
                          ? 'border-brand-600 bg-brand-50 text-brand-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                      onClick={() => setPlatformFilter(plat)}
                      type="button"
                    >
                      {plat === 'ALL' ? 'Mọi nền tảng' : PLATFORM_SHORT_CODES[plat]}
                    </button>
                  );
                })}
              </div>

              <div className="relative min-w-[230px] flex-1 sm:flex-initial">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  className="h-8 w-full rounded-lg border border-slate-300 pl-8 pr-7 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="Lọc từ khóa / link (VD: /s/, sale, http...)"
                  type="text"
                  value={keyword}
                />
                {keyword ? (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    onClick={() => setKeyword('')}
                    type="button"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* Safety & Quick Filter Checkboxes */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs">
            <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-slate-800">
              <input
                checked={skipWithCustomerReplies}
                className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                onChange={(e) => setSkipWithCustomerReplies(e.target.checked)}
                type="checkbox"
              />
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              <span>Bảo vệ: Bỏ qua bình luận đang có khách trả lời bên dưới</span>
              {protectedCustomerThreadCount > 0 ? (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                  Đang giữ an toàn {protectedCustomerThreadCount}
                </span>
              ) : null}
            </label>

            <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
              <input
                checked={onlyWithLinks}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                onChange={(e) => setOnlyWithLinks(e.target.checked)}
                type="checkbox"
              />
              <Link2 className="h-3.5 w-3.5 text-brand-600" />
              <span>Chỉ bình luận chứa link (http / /s/)</span>
            </label>

            {authorSource === 'PAGE' ? (
              <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
                <input
                  checked={onlyLatestPagePerPost}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  onChange={(e) => setOnlyLatestPagePerPost(e.target.checked)}
                  type="checkbox"
                />
                <span>Chỉ lấy 1 bình luận mới nhất của Page trên mỗi bài</span>
              </label>
            ) : null}
          </div>
        </div>

        {/* Preview List */}
        <div className="min-h-[260px] flex-1 overflow-y-auto bg-slate-50/40 px-5 py-3.5">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-600">
              {loadingComments ? (
                'Đang quét bình luận trên các bài đã chọn...'
              ) : (
                <>
                  Khớp <strong className="text-slate-900">{filteredComments.length}</strong> bình
                  luận trên <strong className="text-slate-900">{matchedPostCount}</strong> bản đăng
                  {' · '}Đang chọn xử lý{' '}
                  <strong className="text-rose-700">{selectedComments.length}</strong>
                </>
              )}
            </p>

            {filteredComments.length > 0 ? (
              <div className="flex items-center gap-2 text-xs">
                <button
                  className="font-semibold text-brand-700 hover:underline"
                  onClick={selectAllFiltered}
                  type="button"
                >
                  Chọn tất cả ({filteredComments.length})
                </button>
                <span className="text-slate-300">|</span>
                <button
                  className="font-medium text-slate-500 hover:text-slate-800 hover:underline"
                  onClick={deselectAllFiltered}
                  type="button"
                >
                  Bỏ chọn hết
                </button>
              </div>
            ) : null}
          </div>

          {hasPageSelectedForHide ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
              <span>
                Facebook &amp; Instagram không cho phép <strong>Ẩn</strong> bình luận do chính Page
                đăng — hãy chuyển sang chế độ <strong>Xóa trên MXH</strong> để gỡ bình luận của
                Page.
              </span>
              <button
                className="shrink-0 rounded-md bg-amber-700 px-2.5 py-1 font-semibold text-white hover:bg-amber-800"
                onClick={() => setActionMode('DELETE_FROM_PLATFORM')}
                type="button"
              >
                Chuyển sang Xóa trên MXH
              </button>
            </div>
          ) : null}

          {loadingComments ? (
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-xs text-slate-500">
              Đang tải danh sách bình luận...
            </div>
          ) : filteredComments.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white px-4 text-center">
              <CheckCircle2 className="h-7 w-7 text-slate-300" />
              <p className="mt-2 text-sm font-semibold text-slate-800">
                Không có bình luận nào khớp bộ lọc hiện tại
              </p>
              <p className="mt-1 max-w-md text-xs text-slate-500">
                {comments.length === 0
                  ? 'Các bài viết này chưa có bình luận trong hệ thống. Bấm "Làm mới bình luận từ MXH" ở góc phải trên để kéo bình luận mới nhất về.'
                  : 'Thử đổi bộ lọc Đối tượng, xóa từ khóa tìm kiếm hoặc tắt bớt điều kiện lọc.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredComments.map((cmt) => {
                const checked = !uncheckedIds.has(cmt.id);
                const meta = targetMetaByPlatformPostId.get(cmt.platformPostId);
                const postSnippet = meta
                  ? resolvePostReadableSnippet(meta.post, meta.target)
                  : cmt.contentPostTitle || 'Bài đăng';
                const customerReplies = cmt.customerReplyCount ?? 0;
                const totalChildren = cmt.childCommentCount ?? 0;

                return (
                  <label
                    key={cmt.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                      checked
                        ? 'border-slate-300 bg-white shadow-xs'
                        : 'border-slate-200/70 bg-slate-50/60 opacity-65'
                    }`}
                  >
                    <input
                      checked={checked}
                      className="mt-1 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                      onChange={() => toggleOneComment(cmt.id)}
                      type="checkbox"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span
                          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                            PLATFORM_BADGE_STYLES[cmt.platform]
                          }`}
                        >
                          {PLATFORM_SHORT_CODES[cmt.platform]}
                        </span>
                        <span className="font-semibold text-slate-800">
                          {cmt.socialAccountName}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className="max-w-[260px] truncate text-slate-500" title={postSnippet}>
                          Bài: {postSnippet}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span
                          className="text-slate-400"
                          title={new Date(cmt.postedAt).toLocaleString('vi-VN')}
                        >
                          {formatRelativeTime(cmt.postedAt)}
                        </span>

                        {cmt.isFromPage ? (
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                            Của Page/Kênh
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                            {cmt.authorName ?? 'Người xem'}
                          </span>
                        )}

                        {cmt.isHidden ? (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            Đã ẩn
                          </span>
                        ) : null}

                        {customerReplies > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                            <AlertTriangle className="h-3 w-3 text-amber-600" />
                            Có {customerReplies} phản hồi khách hàng
                          </span>
                        ) : totalChildren > 0 ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                            +{totalChildren} phản hồi con
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-slate-900">
                        {cmt.message || (
                          <em className="text-slate-400">(Bình luận đính kèm ảnh/nhãn dán)</em>
                        )}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer: Action Mode + Submit */}
        <div className="border-t border-slate-200 bg-white px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-semibold text-slate-700">Chế độ xử lý:</span>

                <button
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                    actionMode === 'DELETE_FROM_PLATFORM'
                      ? 'border-rose-600 bg-rose-50 text-rose-700'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                  onClick={() => setActionMode('DELETE_FROM_PLATFORM')}
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Xóa vĩnh viễn trên MXH
                </button>

                <button
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
                    actionMode === 'HIDE_ON_PLATFORM'
                      ? 'border-amber-600 bg-amber-50 text-amber-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                  disabled={authorSource === 'PAGE'}
                  onClick={() => setActionMode('HIDE_ON_PLATFORM')}
                  title={
                    authorSource === 'PAGE'
                      ? 'Bình luận của chính Page đăng không hỗ trợ Ẩn trên Facebook/Instagram'
                      : 'Ẩn bình luận người ngoài trên MXH mà vẫn giữ tổng lượt bình luận (Social Proof)'
                  }
                  type="button"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Ẩn trên MXH (Giữ tương tác)
                </button>

                <button
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                    actionMode === 'DELETE_LOCAL_ONLY'
                      ? 'border-slate-800 bg-slate-100 text-slate-900'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  onClick={() => setActionMode('DELETE_LOCAL_ONLY')}
                  title="Chỉ gỡ khỏi danh sách trong hệ thống, giữ nguyên trên mạng xã hội"
                  type="button"
                >
                  Chỉ gỡ khỏi hệ thống
                </button>
              </div>

              <p className="text-[11px] text-slate-500">
                Hàng đợi tự động khử trùng bình luận cha–con (tiết kiệm Quota API) và giãn nhịp{' '}
                <strong>0.9s / kênh</strong> qua Proxy riêng của Store để tránh dính Rate Limit.
              </p>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2">
              <SecondaryButton onClick={onClose} type="button">
                Đóng
              </SecondaryButton>
              <PrimaryButton
                busy={submitting}
                className={
                  actionMode === 'DELETE_FROM_PLATFORM'
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : actionMode === 'HIDE_ON_PLATFORM'
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : ''
                }
                disabled={submitting || selectedComments.length === 0}
                onClick={() => void handleSubmit()}
                type="button"
              >
                {actionMode === 'HIDE_ON_PLATFORM'
                  ? `Ẩn ${selectedComments.length} bình luận trên MXH`
                  : actionMode === 'DELETE_LOCAL_ONLY'
                    ? `Gỡ ${selectedComments.length} bình luận nội bộ`
                    : `Xóa ${selectedComments.length} bình luận trên MXH`}
              </PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { PLATFORM_LABELS };
