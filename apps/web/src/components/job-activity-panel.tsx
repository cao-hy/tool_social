'use client';

import { AlertTriangle, CheckCircle2, ChevronUp, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { jobsApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';
import type { BackgroundJobView, JobActivityView } from '@/lib/types';

const ACTIVE_STATUSES = new Set<BackgroundJobView['status']>(['QUEUED', 'RUNNING']);
const FAILED_STATUSES = new Set<BackgroundJobView['status']>(['FAILED', 'DEAD']);

export function JobActivityPanel({ workspaceId }: { workspaceId: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activity, setActivity] = useState<JobActivityView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isClearing, setIsClearing] = useState(false);
  const [isClearingStale, setIsClearingStale] = useState(false);

  async function load(options?: { silent?: boolean }) {
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
  }

  async function clearFailed() {
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
  }

  async function clearStaleQueued() {
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
  }

  useEffect(() => {
    if (!workspaceId) return;
    void load({ silent: true });
    const interval = setInterval(() => void load({ silent: true }), 5000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  const visibleJobs = useMemo(
    () =>
      activity?.items.filter(
        (job) =>
          ACTIVE_STATUSES.has(job.status) ||
          FAILED_STATUSES.has(job.status) ||
          recentCompleted(job),
      ) ?? [],
    [activity],
  );
  const activeCount = activity?.activeCount ?? 0;
  const failedCount = activity?.failedCount ?? 0;
  const staleQueuedCount = activity?.staleQueuedCount ?? 0;
  const hasAttention = activeCount > 0 || failedCount > 0;

  const activeLabels = useMemo(() => {
    if (!activity) return [];
    const active = activity.items.filter((job) => ACTIVE_STATUSES.has(job.status));
    return [...new Set(active.map((job) => job.label ?? job.queueName))];
  }, [activity]);

  const failedLabels = useMemo(() => {
    if (!activity) return [];
    const failed = activity.items.filter((job) => FAILED_STATUSES.has(job.status));
    return [...new Set(failed.map((job) => job.label ?? job.queueName))];
  }, [activity]);

  function renderBubbleText() {
    if (activeCount > 0) {
      if (activeLabels.length === 0) return `${activeCount} job đang chạy`;
      const displayed = activeLabels.slice(0, 2).join(', ');
      const extra = activeLabels.length > 2 ? ` (+${activeLabels.length - 2})` : '';
      return `Đang: ${displayed}${extra}`;
    }
    if (failedCount > 0) {
      if (failedLabels.length === 0) return `${failedCount} job lỗi`;
      const displayed = failedLabels.slice(0, 2).join(', ');
      const extra = failedLabels.length > 2 ? ` (+${failedLabels.length - 2})` : '';
      return `Lỗi: ${displayed}${extra}`;
    }
    if (staleQueuedCount > 0) return `${staleQueuedCount} job chờ cũ`;
    return 'Server rảnh';
  }

  if (!workspaceId) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[min(420px,calc(100vw-2rem))]">
      {isOpen ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 p-3">
            <button
              className="flex items-center gap-2 text-left text-sm font-semibold text-slate-950"
              onClick={() => setIsOpen(false)}
              type="button"
            >
              <ChevronUp className="h-4 w-4" />
              Server activity
            </button>
            <div className="flex items-center gap-2">
              {failedCount > 0 ? (
                <button
                  className="inline-flex h-9 items-center justify-center rounded-md bg-rose-50 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                  disabled={isClearing || loading}
                  onClick={() => void clearFailed()}
                  type="button"
                >
                  Xóa lỗi
                </button>
              ) : null}
              {staleQueuedCount > 0 ? (
                <button
                  className="inline-flex h-9 items-center justify-center rounded-md bg-amber-50 px-3 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                  disabled={isClearingStale || loading}
                  onClick={() => void clearStaleQueued()}
                  type="button"
                >
                  Dọn job chờ cũ
                </button>
              ) : null}
              <button
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                disabled={loading}
                onClick={() => void load()}
                title="Làm mới"
                type="button"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="max-h-[440px] overflow-auto">
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
                Không có job đang chạy.
              </div>
            )}
          </div>
        </div>
      ) : (
        <button
          className={`ml-auto flex items-center gap-2 rounded-full border px-4 py-3 text-sm font-semibold shadow-lg transition ${
            failedCount > 0
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : hasAttention
                ? 'border-brand-200 bg-white text-brand-700'
                : staleQueuedCount > 0
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-slate-200 bg-white text-slate-700'
          }`}
          onClick={() => setIsOpen(true)}
          type="button"
        >
          {activeCount > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : failedCount > 0 ? (
            <AlertTriangle className="h-4 w-4" />
          ) : staleQueuedCount > 0 ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          <span>{renderBubbleText()}</span>
        </button>
      )}
    </div>
  );
}

function JobRow({ job }: { job: BackgroundJobView }) {
  const status = statusMeta(job);
  return (
    <article className="grid gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">
            {job.label ?? job.queueName}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500">{job.details ?? job.queueName}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${status.className}`}
        >
          {status.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          Attempts {job.attempts}/{job.maxAttempts}
        </span>
        <span>
          {job.startedAt ? runningTime(job.startedAt, job.finishedAt) : relativeTime(job.updatedAt)}
        </span>
      </div>

      {job.errorMessage ? (
        <p className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">{job.errorMessage}</p>
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

function recentCompleted(job: BackgroundJobView): boolean {
  if (job.status !== 'COMPLETED') return false;
  return Date.now() - new Date(job.updatedAt).getTime() < 1000 * 60 * 5;
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
