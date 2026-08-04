'use client';

import { CloudDownload, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyticsApi, jobsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';

import type { AnalyticsDashboardView, BackgroundJobView, SocialAccountView } from '@/lib/types';
import { useToast } from '@/components/toast-provider';
import { DataQualityTab } from './tabs/data-quality-tab';
import { OverviewTab } from './tabs/overview-tab';
import { ContentTab } from './tabs/content-tab';
import { PlatformTab } from './tabs/platform-tab';
import type { SyncProgressState, ExternalSyncProgressState } from './tabs/data-quality-tab';

const TERMINAL_JOB_STATUSES = new Set<BackgroundJobView['status']>(['COMPLETED', 'FAILED', 'DEAD']);

export default function AnalyticsPage() {
  const { activeWorkspace } = useAuth();
  const toast = useToast();
  const [dashboard, setDashboard] = useState<AnalyticsDashboardView | null>(null);
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [filters, setFilters] = useState<{
    from: string;
    to: string;
    platform: string;
    account: string;
  }>({
    from: '',
    to: '',
    platform: '',
    account: '',
  });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [externalSyncing, setExternalSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null);
  const [externalSyncProgress, setExternalSyncProgress] =
    useState<ExternalSyncProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState('overview');

  const load = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      const [analytics, accountResult] = await Promise.all([
        analyticsApi.dashboard(activeWorkspace.id, {
          from: filters.from || undefined,
          to: filters.to || undefined,
          platform: filters.platform || undefined,
          socialAccountId: filters.account || undefined,
        }),
        socialAccountsApi.list(activeWorkspace.id),
      ]);
      setDashboard(analytics);
      setAccounts(accountResult.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
      // Reset page on load
    }
  }, [activeWorkspace, filters.account, filters.from, filters.platform, filters.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncJobKey = useMemo(() => syncProgress?.jobIds.join('|') ?? '', [syncProgress?.jobIds]);
  const externalSyncJobKey = useMemo(
    () => externalSyncProgress?.jobIds.join('|') ?? '',
    [externalSyncProgress?.jobIds],
  );

  useEffect(() => {
    if (!activeWorkspace || !syncProgress?.active || syncProgress.jobIds.length === 0) return;

    let cancelled = false;
    const workspaceId = activeWorkspace.id;
    const jobIds = syncProgress.jobIds;
    const totalJobs = syncProgress.total;

    async function poll() {
      try {
        const status = await jobsApi.status(workspaceId, jobIds);
        if (cancelled) return;
        const doneCount = status.items.filter((job) =>
          TERMINAL_JOB_STATUSES.has(job.status),
        ).length;
        const failedCount = status.items.filter(
          (job) => job.status === 'FAILED' || job.status === 'DEAD',
        ).length;
        const isDone = doneCount >= totalJobs;
        setSyncProgress((current) =>
          current
            ? {
                ...current,
                active: !isDone,
                items: status.items,
                lastUpdatedAt: status.generatedAt,
                error: null,
              }
            : current,
        );
        if (isDone) {
          if (failedCount > 0) {
            toast.error(`Sync metrics xong nhưng có ${failedCount} job lỗi.`);
          } else {
            toast.success('Sync metrics đã hoàn tất.');
          }
          void load();
        }
      } catch (pollError) {
        if (cancelled) return;
        setSyncProgress((current) =>
          current ? { ...current, error: getErrorMessage(pollError) } : current,
        );
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeWorkspace, load, syncJobKey, syncProgress?.active, syncProgress?.total, toast]);

  useEffect(() => {
    if (
      !activeWorkspace ||
      !externalSyncProgress?.active ||
      externalSyncProgress.jobIds.length === 0
    ) {
      return;
    }

    let cancelled = false;
    const workspaceId = activeWorkspace.id;
    const jobIds = externalSyncProgress.jobIds;
    const totalJobs = externalSyncProgress.total;

    async function poll() {
      try {
        const status = await jobsApi.status(workspaceId, jobIds);
        if (cancelled) return;
        const doneCount = status.items.filter((job) =>
          TERMINAL_JOB_STATUSES.has(job.status),
        ).length;
        const failedJobs = status.items.filter(
          (job) => job.status === 'FAILED' || job.status === 'DEAD',
        );
        const isDone = doneCount >= totalJobs;
        setExternalSyncProgress((current) =>
          current
            ? {
                ...current,
                active: !isDone,
                items: status.items,
                lastUpdatedAt: status.generatedAt,
                error: null,
              }
            : current,
        );
        if (isDone) {
          if (failedJobs.length > 0) {
            toast.error(
              failedJobs[0]?.errorMessage ?? `Có ${failedJobs.length} job kéo bài ngoài tool lỗi.`,
              'Kéo bài ngoài tool lỗi',
            );
          } else {
            toast.success('Kéo bài ngoài tool đã hoàn tất.');
          }
          void load();
        }
      } catch (pollError) {
        if (cancelled) return;
        setExternalSyncProgress((current) =>
          current ? { ...current, error: getErrorMessage(pollError) } : current,
        );
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    activeWorkspace,
    externalSyncJobKey,
    externalSyncProgress?.active,
    externalSyncProgress?.total,
    load,
    toast,
  ]);

  const platforms = useMemo(
    () => Array.from(new Set(accounts.map((account) => account.platform))).sort(),
    [accounts],
  );

  const externalSyncAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.status === 'CONNECTED' &&
          (!filters.platform || account.platform === filters.platform) &&
          (!filters.account || account.id === filters.account),
      ),
    [accounts, filters.account, filters.platform],
  );

  async function syncMetrics() {
    if (!activeWorkspace) return;
    setSyncing(true);
    try {
      const result = await analyticsApi.sync(activeWorkspace.id, {
        platform: filters.platform || undefined,
        socialAccountId: filters.account || undefined,
      });
      if (result.queued === 0) {
        toast.info('Không có metric nào cần đưa vào queue trong bộ lọc hiện tại.');
        await load();
        return;
      }
      setSyncProgress({
        active: true,
        total: result.queued,
        postMetricsQueued: result.postMetricsQueued,
        accountMetricsQueued: result.accountMetricsQueued,
        jobIds: result.jobs.map((job) => job.id),
        items: [],
        startedAt: new Date().toISOString(),
        lastUpdatedAt: null,
        error: null,
      });
      toast.success(
        `Đã đưa ${result.queued} job vào queue: ${result.postMetricsQueued} bài, ${result.accountMetricsQueued} tài khoản.`,
      );
    } catch (syncError) {
      toast.error(getErrorMessage(syncError));
    } finally {
      setSyncing(false);
    }
  }

  async function syncExternalPosts() {
    if (!activeWorkspace) return;
    if (externalSyncAccounts.length === 0) {
      toast.warning('Không có tài khoản đã kết nối nào khớp bộ lọc hiện tại.');
      return;
    }

    setExternalSyncing(true);
    try {
      const results = await Promise.allSettled(
        externalSyncAccounts.map((account) =>
          socialAccountsApi.syncPosts(activeWorkspace.id, account.id),
        ),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      const succeeded = results.length - failed.length;

      if (succeeded > 0) {
        toast.success(
          `Đã đưa ${succeeded} tài khoản vào queue kéo bài ngoài tool. Xem Server activity để theo dõi.`,
        );
      }
      if (failed.length > 0) {
        toast.error(
          failed[0]?.status === 'rejected'
            ? getErrorMessage(failed[0].reason)
            : `${failed.length} tài khoản không đưa được vào queue.`,
          'Kéo bài ngoài tool lỗi',
        );
      }
      const jobIds = results
        .filter((result) => result.status === 'fulfilled' && result.value.backgroundJobId)
        .map((result) => (result.status === 'fulfilled' ? result.value.backgroundJobId : null))
        .filter((id): id is string => Boolean(id));
      if (jobIds.length > 0) {
        setExternalSyncProgress({
          active: true,
          total: jobIds.length,
          jobIds,
          items: [],
          startedAt: new Date().toISOString(),
          lastUpdatedAt: null,
          error: null,
        });
      }
    } finally {
      setExternalSyncing(false);
    }
  }

  if (!activeWorkspace) return null;

  return (
    <main className="mx-auto grid max-w-7xl gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">Analytics</h1>
          <p className="mt-2 text-slate-600">
            Metrics theo nguồn dữ liệu, không cộng gộp mù giữa các nền tảng.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            disabled={externalSyncing || !!externalSyncProgress?.active}
            onClick={() => void syncExternalPosts()}
            type="button"
          >
            <CloudDownload
              className={`h-4 w-4 ${externalSyncing || externalSyncProgress?.active ? 'animate-pulse' : ''}`}
            />
            {externalSyncing || externalSyncProgress?.active
              ? 'Đang kéo bài'
              : 'Kéo bài ngoài tool'}
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={syncing || !!syncProgress?.active}
            onClick={syncMetrics}
            type="button"
          >
            <RefreshCw
              className={`h-4 w-4 ${syncing || syncProgress?.active ? 'animate-spin' : ''}`}
            />
            {syncProgress?.active ? 'Đang sync' : 'Sync metrics'}
          </button>
        </div>
      </header>

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 md:grid-cols-4">
        <FilterInput
          label="Từ ngày"
          type="date"
          value={filters.from}
          onChange={(from) => setFilters((current) => ({ ...current, from }))}
        />
        <FilterInput
          label="Đến ngày"
          type="date"
          value={filters.to}
          onChange={(to) => setFilters((current) => ({ ...current, to }))}
        />
        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          Nền tảng
          <select
            className="h-11 rounded-lg border border-slate-300 px-3 font-normal text-slate-950"
            value={filters.platform}
            onChange={(event) => {
              setFilters((current) => ({ ...current, platform: event.target.value, account: '' }));
            }}
          >
            <option value="">Tất cả</option>
            {platforms.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          Tài khoản
          <select
            className="h-11 rounded-lg border border-slate-300 px-3 font-normal text-slate-950"
            value={filters.account}
            onChange={(event) =>
              setFilters((current) => ({ ...current, account: event.target.value }))
            }
          >
            <option value="">Tất cả</option>
            {accounts
              .filter((account) => !filters.platform || account.platform === filters.platform)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.platform} · {account.name}
                </option>
              ))}
          </select>
        </label>
      </section>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className="border-b border-slate-200">
        <nav className="-mb-px flex gap-6 overflow-x-auto">
          {[
            { id: 'overview', label: 'Tổng quan' },
            { id: 'content', label: 'Nội dung' },
            { id: 'platform', label: 'Nền tảng' },
            { id: 'data_quality', label: 'Chất lượng dữ liệu' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`whitespace-nowrap border-b-2 py-4 px-1 text-sm font-medium ${
                currentTab === tab.id
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {loading || !dashboard ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-sm text-slate-600">
          Đang tải analytics...
        </div>
      ) : (
        <div className="pt-2">
          {currentTab === 'overview' && <OverviewTab dashboard={dashboard} />}
          {currentTab === 'content' && <ContentTab dashboard={dashboard} />}
          {currentTab === 'platform' && <PlatformTab dashboard={dashboard} />}
          {currentTab === 'data_quality' && (
            <DataQualityTab
              dashboard={dashboard}
              syncProgress={syncProgress}
              externalSyncProgress={externalSyncProgress}
            />
          )}
        </div>
      )}
    </main>
  );
}

function FilterInput({
  label,
  value,
  type,
  onChange,
}: {
  label: string;
  value: string;
  type: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-slate-700">
      {label}
      <input
        className="h-11 rounded-lg border border-slate-300 px-3 font-normal text-slate-950"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
