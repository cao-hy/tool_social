'use client';

import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useWorkspaceEventSubscription } from '@/components/workspace-events-provider';
import { jobsApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';
import type { BackgroundJobView, JobActivityView } from '@/lib/types';

const ACTIVE_STATUSES = new Set<BackgroundJobView['status']>(['QUEUED', 'RUNNING']);

type OpenSource = 'header' | 'bottom' | null;
type CompletionBanner = 'success' | 'failed' | null;

interface JobActivityContextValue {
  workspaceId: string | null;
  isSidebarCollapsed: boolean;
  sseConnected: boolean;
  activity: JobActivityView | null;
  visibleJobs: BackgroundJobView[];
  activeCount: number;
  failedCount: number;
  staleQueuedCount: number;
  activeSummaryText: string;
  loading: boolean;
  error: string | null;
  isClearing: boolean;
  isClearingStale: boolean;
  openSource: OpenSource;
  setOpenSource: (next: OpenSource) => void;
  isPillDismissed: boolean;
  dismissPill: () => void;
  completionBanner: CompletionBanner;
  reload: () => Promise<void>;
  clearFailed: () => Promise<void>;
  clearStaleQueued: () => Promise<void>;
}

const JobActivityContext = createContext<JobActivityContextValue | null>(null);

function useJobActivityContext() {
  const ctx = useContext(JobActivityContext);
  if (!ctx) {
    throw new Error('useJobActivityContext must be used inside JobActivityProvider');
  }
  return ctx;
}

export function JobActivityProvider({
  workspaceId,
  isSidebarCollapsed = false,
  children,
}: {
  workspaceId: string | null;
  isSidebarCollapsed?: boolean;
  children: ReactNode;
}) {
  const [openSource, setOpenSource] = useState<OpenSource>(null);
  const [activity, setActivity] = useState<JobActivityView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isClearingStale, setIsClearingStale] = useState(false);
  const [isPillDismissed, setIsPillDismissed] = useState(false);
  const [completionBanner, setCompletionBanner] = useState<CompletionBanner>(null);

  const debounceTimerRef = useRef<number | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const prevActiveCountRef = useRef(0);
  const prevFailedCountRef = useRef(0);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!workspaceId) return;
      if (!options?.silent) setLoading(true);
      try {
        const next = await jobsApi.activity(workspaceId, { limit: 12, includeCompleted: true });
        setActivity(next);
        setError(null);
      } catch (loadError) {
        setError(getErrorMessage(loadError));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [workspaceId],
  );

  const { connected: sseConnected } = useWorkspaceEventSubscription((event) => {
    if (event.type === 'job.queued') {
      setIsPillDismissed(false);
    }
    if (
      event.type === 'job.queued' ||
      event.type === 'job.active' ||
      event.type === 'job.completed' ||
      event.type === 'job.failed' ||
      event.type === 'stream.reconnected'
    ) {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void load({ silent: true });
      }, 180);
    }
  });

  useEffect(() => {
    if (!workspaceId) {
      setActivity(null);
      setOpenSource(null);
      setCompletionBanner(null);
      prevActiveCountRef.current = 0;
      prevFailedCountRef.current = 0;
      return;
    }
    void load({ silent: true });
    const pollMs = sseConnected ? 30_000 : 5_000;
    const interval = window.setInterval(() => void load({ silent: true }), pollMs);
    return () => {
      window.clearInterval(interval);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [load, sseConnected, workspaceId]);

  useEffect(() => {
    return () => {
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
      }
    };
  }, []);

  const activeCount = activity?.activeCount ?? 0;
  const failedCount = activity?.failedCount ?? 0;
  const staleQueuedCount = activity?.staleQueuedCount ?? 0;

  useEffect(() => {
    const prevActive = prevActiveCountRef.current;
    const prevFailed = prevFailedCountRef.current;

    if (activeCount > prevActive) {
      setIsPillDismissed(false);
      setCompletionBanner(null);
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
    } else if (prevActive > 0 && activeCount === 0) {
      const hadNewFailure = failedCount > prevFailed;
      if (!isPillDismissed || hadNewFailure) {
        setCompletionBanner(hadNewFailure ? 'failed' : 'success');
        if (completionTimerRef.current !== null) {
          window.clearTimeout(completionTimerRef.current);
        }
        completionTimerRef.current = window.setTimeout(
          () => {
            setCompletionBanner(null);
            completionTimerRef.current = null;
          },
          hadNewFailure ? 4000 : 2500,
        );
      }
      setIsPillDismissed(false);
    }

    prevActiveCountRef.current = activeCount;
    prevFailedCountRef.current = failedCount;
  }, [activeCount, failedCount, isPillDismissed]);

  const visibleJobs = useMemo(() => activity?.items ?? [], [activity]);

  const activeLabels = useMemo(() => {
    if (!activity) return [];
    const active = activity.items.filter((job) => ACTIVE_STATUSES.has(job.status));
    return [...new Set(active.map((job) => job.label ?? job.queueName))];
  }, [activity]);

  const activeSummaryText = useMemo(() => {
    if (activeCount <= 0) return 'Server rảnh';
    if (activeLabels.length === 0) return `Đang xử lý ${activeCount} tác vụ...`;
    const displayed = activeLabels.slice(0, 2).join(', ');
    const extra = activeLabels.length > 2 ? ` (+${activeLabels.length - 2})` : '';
    return `Đang xử lý: ${displayed}${extra}`;
  }, [activeCount, activeLabels]);

  const clearFailed = useCallback(async () => {
    if (!workspaceId) return;
    setIsClearing(true);
    try {
      await jobsApi.clearFailed(workspaceId);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsClearing(false);
    }
  }, [load, workspaceId]);

  const clearStaleQueued = useCallback(async () => {
    if (!workspaceId) return;
    setIsClearingStale(true);
    try {
      await jobsApi.clearStaleQueued(workspaceId);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsClearingStale(false);
    }
  }, [load, workspaceId]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  const dismissPill = useCallback(() => {
    setIsPillDismissed(true);
    setCompletionBanner(null);
    if (openSource === 'bottom') {
      setOpenSource(null);
    }
  }, [openSource]);

  const value = useMemo<JobActivityContextValue>(
    () => ({
      workspaceId,
      isSidebarCollapsed,
      sseConnected,
      activity,
      visibleJobs,
      activeCount,
      failedCount,
      staleQueuedCount,
      activeSummaryText,
      loading,
      error,
      isClearing,
      isClearingStale,
      openSource,
      setOpenSource,
      isPillDismissed,
      dismissPill,
      completionBanner,
      reload,
      clearFailed,
      clearStaleQueued,
    }),
    [
      activeCount,
      activeSummaryText,
      activity,
      clearFailed,
      clearStaleQueued,
      completionBanner,
      dismissPill,
      error,
      failedCount,
      isClearing,
      isClearingStale,
      isPillDismissed,
      isSidebarCollapsed,
      loading,
      openSource,
      reload,
      sseConnected,
      staleQueuedCount,
      visibleJobs,
      workspaceId,
    ],
  );

  return <JobActivityContext.Provider value={value}>{children}</JobActivityContext.Provider>;
}

/**
 * Tầng 1 (Calm Chrome): Nút trạng thái cố định trên Top Header cạnh chuông Thông báo.
 * Chiếm 0px diện tích bảng dữ liệu bên dưới nhưng luôn sẵn sàng để tra cứu lịch sử Job.
 */
export function JobActivityHeaderControl({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { workspaceId, activeCount, failedCount, staleQueuedCount, openSource, setOpenSource } =
    useJobActivityContext();

  if (!workspaceId) return null;

  const isOpen = openSource === 'header';
  const attentionCount = failedCount > 0 ? failedCount : staleQueuedCount;

  const buttonTone =
    failedCount > 0
      ? 'border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100'
      : activeCount > 0
        ? 'border-brand-200 bg-brand-50 text-brand-700 hover:border-brand-300 hover:bg-brand-100'
        : staleQueuedCount > 0
          ? 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100'
          : isOpen
            ? 'border-brand-300 bg-brand-50 text-brand-700'
            : 'border-slate-300 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700';

  const tooltip =
    activeCount > 0
      ? `${activeCount} tác vụ đang chạy ngầm`
      : failedCount > 0
        ? `${failedCount} tác vụ ngầm bị lỗi`
        : staleQueuedCount > 0
          ? `${staleQueuedCount} job chờ cũ`
          : 'Tác vụ ngầm: Server rảnh';

  return (
    <div className="relative">
      <button
        aria-expanded={isOpen}
        aria-label="Mở tiến trình tác vụ ngầm"
        className={`relative inline-flex h-10 items-center justify-center gap-2 rounded-md border transition hover:-translate-y-px hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-100 ${
          activeCount > 0 ? 'px-3' : 'w-10'
        } ${buttonTone}`}
        title={tooltip}
        type="button"
        onClick={() => {
          if (!isOpen) onBeforeOpen?.();
          setOpenSource(isOpen ? null : 'header');
        }}
      >
        {activeCount > 0 ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span className="hidden text-xs font-semibold sm:inline">
              Đang chạy ({activeCount})
            </span>
          </>
        ) : failedCount > 0 || staleQueuedCount > 0 ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <Activity className="h-4 w-4" />
        )}

        {activeCount === 0 && attentionCount > 0 ? (
          <span
            className={`absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white shadow-sm ring-2 ring-white ${
              failedCount > 0 ? 'bg-rose-500' : 'bg-amber-500'
            }`}
          >
            {attentionCount > 99 ? '99+' : attentionCount}
          </span>
        ) : activeCount === 0 ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1.5 right-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white"
          />
        ) : null}
      </button>

      {isOpen ? (
        <>
          <button
            aria-label="Đóng bảng tác vụ ngầm"
            className="fixed inset-0 z-40 cursor-default"
            type="button"
            onClick={() => setOpenSource(null)}
          />
          <section className="absolute right-0 top-12 z-50 w-[min(420px,calc(100vw-2rem))]">
            <JobActivityPopoverCard onClose={() => setOpenSource(null)} />
          </section>
        </>
      ) : null}
    </div>
  );
}

/**
 * Tầng 2 (Transient Shopify Dark Pill):
 * - Tàng hình 100% khi "Server rảnh" -> Không bao giờ che phân trang hay bảng dữ liệu.
 * - Chỉ trượt lên ở giữa đáy khi thực sự có job đang chạy (`activeCount > 0`), và tự ẩn sau 2.5s khi hoàn tất.
 * - Đặt `z-30` để luôn nằm dưới Modal / PostCommentsDrawer (`z-50`).
 */
export function JobActivityTransientBar() {
  const {
    workspaceId,
    isSidebarCollapsed,
    activeCount,
    activeSummaryText,
    isPillDismissed,
    dismissPill,
    completionBanner,
    openSource,
    setOpenSource,
  } = useJobActivityContext();

  if (!workspaceId) return null;

  const isBottomOpen = openSource === 'bottom';
  const showActive = activeCount > 0 && !isPillDismissed;
  const shouldRender = showActive || completionBanner !== null || isBottomOpen;

  if (!shouldRender) return null;

  const horizontalPositionClass = isSidebarCollapsed
    ? 'left-1/2 lg:left-[calc(50%+40px)]'
    : 'left-1/2 lg:left-[calc(50%+140px)]';

  return (
    <div
      className={`fixed bottom-4 z-30 -translate-x-1/2 transition-all duration-200 ${horizontalPositionClass} max-w-[calc(100vw-2rem)]`}
    >
      {isBottomOpen ? (
        <>
          <button
            aria-label="Đóng chi tiết tác vụ ngầm"
            className="fixed inset-0 z-40 cursor-default"
            type="button"
            onClick={() => setOpenSource(null)}
          />
          <div className="relative z-50 mb-3 w-[min(420px,calc(100vw-2rem))]">
            <JobActivityPopoverCard onClose={() => setOpenSource(null)} />
          </div>
        </>
      ) : null}

      <div className="relative z-50 mx-auto flex w-fit max-w-full items-center gap-2.5 rounded-full border border-white/10 bg-zinc-900/95 px-4 py-2 text-xs text-white shadow-2xl shadow-slate-950/30 backdrop-blur-md sm:text-sm">
        {activeCount > 0 ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" />
            <span className="max-w-[210px] truncate font-medium text-zinc-100 sm:max-w-[320px]">
              {activeSummaryText}
            </span>
            {activeCount > 1 ? (
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-200">
                {activeCount}
              </span>
            ) : null}
            <button
              className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-white/20"
              type="button"
              onClick={() => setOpenSource(isBottomOpen ? null : 'bottom')}
            >
              {isBottomOpen ? 'Ẩn' : 'Chi tiết'}
            </button>
            <button
              aria-label="Thu gọn thanh tiến trình lên Header"
              className="shrink-0 rounded-full p-1 text-zinc-400 transition hover:bg-white/10 hover:text-white"
              title="Thu gọn lên thanh công cụ"
              type="button"
              onClick={dismissPill}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : completionBanner === 'failed' ? (
          <>
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span className="truncate font-medium text-zinc-100">Có tác vụ ngầm gặp lỗi</span>
            <button
              className="shrink-0 rounded-full bg-rose-500/20 px-2.5 py-1 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/30"
              type="button"
              onClick={() => setOpenSource(isBottomOpen ? null : 'bottom')}
            >
              {isBottomOpen ? 'Ẩn' : 'Xem lỗi'}
            </button>
            <button
              aria-label="Đóng thông báo"
              className="shrink-0 rounded-full p-1 text-zinc-400 transition hover:bg-white/10 hover:text-white"
              type="button"
              onClick={dismissPill}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span className="truncate font-medium text-zinc-100">Đã hoàn tất tác vụ ngầm</span>
          </>
        )}
      </div>
    </div>
  );
}

function JobActivityPopoverCard({ onClose }: { onClose: () => void }) {
  const {
    sseConnected,
    visibleJobs,
    activeCount,
    failedCount,
    staleQueuedCount,
    loading,
    error,
    isClearing,
    isClearingStale,
    reload,
    clearFailed,
    clearStaleQueued,
  } = useJobActivityContext();

  const subtitle =
    activeCount > 0
      ? `${activeCount} tác vụ đang xử lý`
      : failedCount > 0
        ? `${failedCount} tác vụ lỗi cần kiểm tra`
        : `Server rảnh · ${sseConnected ? 'Realtime đang bật' : 'Đang đồng bộ định kỳ'}`;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-950">Tác vụ ngầm (Server activity)</p>
            <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
          </div>
          <button
            aria-label="Đóng"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={() => void reload()}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Làm mới
          </button>
          {failedCount > 0 ? (
            <button
              className="inline-flex h-8 items-center justify-center rounded-md bg-rose-50 px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
              disabled={isClearing || loading}
              type="button"
              onClick={() => void clearFailed()}
            >
              Xóa lỗi ({failedCount})
            </button>
          ) : null}
          {staleQueuedCount > 0 ? (
            <button
              className="inline-flex h-8 items-center justify-center rounded-md bg-amber-50 px-3 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
              disabled={isClearingStale || loading}
              type="button"
              onClick={() => void clearStaleQueued()}
            >
              Dọn job chờ cũ ({staleQueuedCount})
            </button>
          ) : null}
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto">
        {error ? (
          <div className="border-b border-amber-100 bg-amber-50 p-3 text-sm text-amber-800">
            {error}
          </div>
        ) : null}

        {visibleJobs.length > 0 ? (
          <div className="divide-y divide-slate-100">
            {visibleJobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        ) : (
          <div className="grid place-items-center gap-2 p-8 text-center text-sm text-slate-500">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            Chưa có tác vụ ngầm nào gần đây.
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job }: { job: BackgroundJobView }) {
  const status = statusMeta(job);
  return (
    <article className="grid gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">
            {job.label ?? job.queueName}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500">{job.details ?? job.queueName}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.className}`}
        >
          {status.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          Attempts {job.attempts}/{job.maxAttempts}
        </span>
        <span>
          {job.status === 'RUNNING' && job.startedAt
            ? runningTime(job.startedAt, job.finishedAt)
            : relativeTime(job.updatedAt)}
        </span>
        {job.durationMs !== null && job.status === 'COMPLETED' ? (
          <span>
            {job.durationMs < 1000
              ? `${job.durationMs}ms`
              : `${(job.durationMs / 1000).toFixed(1)}s`}
          </span>
        ) : null}
      </div>

      {job.errorMessage ? (
        <p className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
          {job.errorMessage}
        </p>
      ) : null}

      {job.progress ? (
        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>{job.progress.label}</span>
            {job.progress.percent !== null ? <span>{job.progress.percent}%</span> : null}
          </div>
          {job.progress.counts ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
              {Object.entries(job.progress.counts).map(([key, value]) => (
                <span key={key}>
                  {countLabel(key)}: {value}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {job.status === 'RUNNING' || job.status === 'QUEUED' ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${job.isStaleQueued ? 'bg-amber-500' : 'bg-brand-500'} ${
              job.progress?.percent === null ? 'w-2/3 animate-pulse' : ''
            }`}
            style={
              job.progress?.percent !== null && job.progress?.percent !== undefined
                ? { width: `${Math.max(4, job.progress.percent)}%` }
                : undefined
            }
          />
        </div>
      ) : null}
    </article>
  );
}

function countLabel(key: string): string {
  switch (key) {
    case 'scanned':
      return 'quét';
    case 'imported':
      return 'mới';
    case 'updated':
      return 'cập nhật';
    case 'skipped':
      return 'bỏ qua';
    case 'failed':
      return 'lỗi';
    default:
      return key;
  }
}

function statusMeta(job: BackgroundJobView) {
  if (job.isStaleQueued) {
    return { label: 'Stale', className: 'bg-amber-50 text-amber-700' };
  }
  const status = job.status;
  switch (status) {
    case 'QUEUED':
      return { label: 'Queued', className: 'bg-slate-100 text-slate-700' };
    case 'RUNNING':
      return { label: 'Running', className: 'bg-brand-50 text-brand-700' };
    case 'COMPLETED':
      return { label: 'Done', className: 'bg-emerald-50 text-emerald-700' };
    case 'FAILED':
      return { label: 'Retrying', className: 'bg-amber-50 text-amber-700' };
    case 'DEAD':
      return { label: 'Failed', className: 'bg-rose-50 text-rose-700' };
  }
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s trước`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  return `${hours} giờ trước`;
}

function runningTime(startedAt: string, finishedAt: string | null): string {
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
