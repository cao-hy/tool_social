'use client';

import Link from 'next/link';
import { ChevronLeft, ChevronRight, CloudDownload, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyticsApi, jobsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import { formatMetricNumber, metricSourceLabel } from '@/lib/post-metrics';
import type {
  AnalyticsDashboardView,
  AnalyticsMetricKey,
  BackgroundJobView,
  MetricValueView,
  PlatformMetricView,
  SocialAccountView,
} from '@/lib/types';
import { useToast } from '@/components/toast-provider';

const METRICS: Array<{ key: AnalyticsMetricKey; label: string; percent?: boolean }> = [
  { key: 'views', label: 'Views' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'reach', label: 'Reach' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'saves', label: 'Saves' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'engagementRate', label: 'Eng. rate', percent: true },
];

const ITEMS_PER_PAGE = 10;
const TERMINAL_JOB_STATUSES = new Set<BackgroundJobView['status']>(['COMPLETED', 'FAILED', 'DEAD']);

interface SyncProgressState {
  active: boolean;
  total: number;
  postMetricsQueued: number;
  accountMetricsQueued: number;
  jobIds: string[];
  items: BackgroundJobView[];
  startedAt: string;
  lastUpdatedAt: string | null;
  error: string | null;
}

interface ExternalSyncProgressState {
  active: boolean;
  total: number;
  jobIds: string[];
  items: BackgroundJobView[];
  startedAt: string;
  lastUpdatedAt: string | null;
  error: string | null;
}

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
  const [currentPage, setCurrentPage] = useState(1);
  const [tablePlatformFilter, setTablePlatformFilter] = useState<string>('ALL');

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
      setCurrentPage(1); // Reset page on load
      setTablePlatformFilter('ALL');
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

  const tablePlatforms = useMemo(() => {
    if (!dashboard) return [];
    return Array.from(new Set(dashboard.posts.map((p) => p.platform))).sort();
  }, [dashboard]);

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

  const filteredPosts = useMemo(() => {
    if (!dashboard) return [];
    if (tablePlatformFilter === 'ALL') return dashboard.posts;
    return dashboard.posts.filter((p) => p.platform === tablePlatformFilter);
  }, [dashboard, tablePlatformFilter]);

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

      {syncProgress ? <AnalyticsSyncProgress progress={syncProgress} /> : null}
      {externalSyncProgress ? <ExternalSyncProgress progress={externalSyncProgress} /> : null}

      <section className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
        <p className="font-semibold">Luồng dữ liệu Analytics</p>
        <p className="mt-1">
          Bài đăng tạo ngoài SocialHub phải chạy <strong>Kéo bài ngoài tool</strong> trước để nhập
          vào DB. Sau khi có bài trong danh sách, bấm <strong>Sync metrics</strong> để lấy số liệu
          view, reach, comment và các chỉ số nền tảng hỗ trợ.
        </p>
      </section>

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
              setCurrentPage(1);
              setTablePlatformFilter('ALL');
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

      {loading || !dashboard ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-sm text-slate-600">
          Đang tải analytics...
        </div>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-4">
            <SummaryCard label="Targets đã publish" value={dashboard.summary.publishedTargets} />
            <SummaryCard label="Đã sync metrics" value={dashboard.summary.syncedTargets} />
            <SummaryCard label="Chưa sync" value={dashboard.summary.notSyncedTargets} />
            <SummaryCard label="Không hỗ trợ" value={dashboard.summary.unsupportedTargets} />
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-semibold text-slate-950">Follower growth</h2>
              <p className="mt-1 text-sm text-slate-600">
                Theo từng tài khoản, không cộng gộp giữa các nền tảng.
              </p>
            </div>
            <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
              {dashboard.followerGrowth.map((account) => (
                <article
                  key={account.socialAccountId}
                  className="rounded-lg border border-slate-200 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500">
                        {account.platform}
                      </p>
                      <h3 className="mt-1 font-semibold text-slate-950">{account.accountName}</h3>
                      {account.username ? (
                        <p className="text-sm text-slate-600">@{account.username}</p>
                      ) : null}
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                      {account.firstDate && account.lastDate
                        ? `${account.firstDate} - ${account.lastDate}`
                        : 'Chưa có range'}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <MiniMetric label="Followers" metric={account.followers} />
                    <MiniMetric label="Growth" metric={account.followersGained} />
                  </div>
                </article>
              ))}
              {dashboard.followerGrowth.length === 0 ? (
                <p className="text-sm text-slate-600">
                  Chưa có snapshot follower. Bấm Sync metrics sau khi đã kết nối tài khoản.
                </p>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-semibold text-slate-950">So sánh nền tảng</h2>
              <p className="mt-1 text-sm text-slate-600">
                Range {dashboard.range.from} → {dashboard.range.to} · {dashboard.range.timezone}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Platform</th>
                    <th className="px-5 py-3">Targets</th>
                    {METRICS.map((metric) => (
                      <th key={metric.key} className="px-5 py-3">
                        {metric.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dashboard.byPlatform.map((row) => (
                    <tr key={row.platform}>
                      <td className="px-5 py-4 font-semibold text-slate-950">{row.platform}</td>
                      <td className="px-5 py-4 text-slate-700">
                        {row.syncedTargets}/{row.targets}
                      </td>
                      {METRICS.map((metric) => (
                        <td key={metric.key} className="px-5 py-4">
                          <MetricCell metric={row.metrics[metric.key]} percent={metric.percent} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {dashboard.byPlatform.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-slate-600" colSpan={METRICS.length + 2}>
                        Chưa có bài publish trong bộ lọc này. Nếu bài được đăng trực tiếp trên nền
                        tảng, hãy bấm Kéo bài ngoài tool trước.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-5">
              <h2 className="text-lg font-semibold text-slate-950">Metric riêng theo nền tảng</h2>
              <p className="mt-1 text-sm text-slate-600">
                Những chỉ số nền tảng có nhưng bảng chung không ép cộng ngang, ví dụ watch time,
                click rate, processing status, category hoặc breakdown engagement.
              </p>
            </div>
            <div className="grid gap-4 p-5 lg:grid-cols-2">
              {dashboard.byPlatform
                .filter((row) => row.platformMetrics.length > 0)
                .map((row) => (
                  <article key={row.platform} className="rounded-lg border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-semibold text-slate-950">{row.platform}</h3>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                        {row.platformMetrics.length} metric
                      </span>
                    </div>
                    <PlatformMetricGrid metrics={row.platformMetrics.slice(0, 12)} />
                  </article>
                ))}
              {dashboard.byPlatform.every((row) => row.platformMetrics.length === 0) ? (
                <p className="text-sm text-slate-600">
                  Chưa có metric riêng. Bấm Sync metrics sau khi bài đã publish hoặc kéo bài ngoài
                  tool về DB.
                </p>
              ) : null}
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1fr_420px]">
            <div className="rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 p-5">
                <h2 className="text-lg font-semibold text-slate-950">Chuỗi thời gian</h2>
              </div>
              <div className="max-h-[520px] overflow-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-5 py-3">Ngày</th>
                      <th className="px-5 py-3">Platform</th>
                      <th className="px-5 py-3">Views</th>
                      <th className="px-5 py-3">Engagement</th>
                      <th className="px-5 py-3">Reach</th>
                      <th className="px-5 py-3">Impressions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dashboard.timeSeries.map((row) => (
                      <tr key={`${row.date}:${row.platform}`}>
                        <td className="px-5 py-4 font-medium text-slate-950">{row.date}</td>
                        <td className="px-5 py-4 text-slate-700">{row.platform}</td>
                        <td className="px-5 py-4">
                          <MetricCell metric={row.metrics.views} />
                        </td>
                        <td className="px-5 py-4">
                          <MetricCell metric={row.metrics.engagement} />
                        </td>
                        <td className="px-5 py-4">
                          <MetricCell metric={row.metrics.reach} />
                        </td>
                        <td className="px-5 py-4">
                          <MetricCell metric={row.metrics.impressions} />
                        </td>
                      </tr>
                    ))}
                    {dashboard.timeSeries.length === 0 ? (
                      <tr>
                        <td className="px-5 py-8 text-slate-600" colSpan={6}>
                          Chưa có snapshot trong khoảng ngày này.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white xl:col-span-2">
              <div className="border-b border-slate-200 p-5 flex items-center justify-between gap-4 flex-wrap">
                <h2 className="text-lg font-semibold text-slate-950">Hiệu suất từng bài đăng</h2>
                {tablePlatforms.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => {
                        setTablePlatformFilter('ALL');
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition ${tablePlatformFilter === 'ALL' ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                    >
                      Tất cả
                    </button>
                    {tablePlatforms.map((plat) => (
                      <button
                        key={plat}
                        type="button"
                        onClick={() => {
                          setTablePlatformFilter(plat);
                          setCurrentPage(1);
                        }}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition ${tablePlatformFilter === plat ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                      >
                        {plat}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-5 py-3">Bài viết</th>
                      <th className="px-5 py-3">Nền tảng</th>
                      <th className="px-5 py-3">Lượt xem</th>
                      <th className="px-5 py-3">Tương tác</th>
                      <th className="px-5 py-3">Bình luận</th>
                      <th className="px-5 py-3">Chia sẻ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredPosts
                      .slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE)
                      .map((post) => (
                        <tr key={post.id}>
                          <td className="px-5 py-4">
                            <div className="max-w-[280px]">
                              <Link
                                className="block truncate font-semibold text-slate-950 hover:text-brand-700"
                                href={`/posts/${post.postId}`}
                              >
                                {post.title}
                              </Link>
                              {post.publishedAt ? (
                                <p className="mt-1 text-xs text-slate-500">
                                  {new Date(post.publishedAt).toLocaleString('vi-VN')}
                                </p>
                              ) : null}
                              <PlatformMetricBadges metrics={post.platformMetrics.slice(0, 4)} />
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <p className="font-semibold text-slate-950">{post.platform}</p>
                            <p className="text-xs text-slate-500">{post.accountName}</p>
                          </td>
                          <td className="px-5 py-4">
                            <MetricCell metric={post.metrics.views} />
                          </td>
                          <td className="px-5 py-4">
                            <MetricCell metric={post.metrics.engagement} />
                          </td>
                          <td className="px-5 py-4">
                            <MetricCell metric={post.metrics.comments} />
                          </td>
                          <td className="px-5 py-4">
                            <MetricCell metric={post.metrics.shares} />
                          </td>
                        </tr>
                      ))}
                    {filteredPosts.length === 0 ? (
                      <tr>
                        <td className="px-5 py-8 text-slate-600 text-center" colSpan={6}>
                          Không có bài viết nào phù hợp. Với bài đăng ngoài tool, hãy kéo bài về DB
                          rồi mới sync metrics.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {filteredPosts.length > ITEMS_PER_PAGE && (
                <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3">
                  <span className="text-sm text-slate-600">
                    Trang {currentPage} / {Math.ceil(filteredPosts.length / ITEMS_PER_PAGE)} (Tổng
                    số {filteredPosts.length} bài)
                  </span>
                  <div className="flex gap-2">
                    <button
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => p - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" /> Prev
                    </button>
                    <button
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      disabled={currentPage >= Math.ceil(filteredPosts.length / ITEMS_PER_PAGE)}
                      onClick={() => setCurrentPage((p) => p + 1)}
                    >
                      Next <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function AnalyticsSyncProgress({ progress }: { progress: SyncProgressState }) {
  const doneCount = progress.items.filter((job) => TERMINAL_JOB_STATUSES.has(job.status)).length;
  const failedCount = progress.items.filter(
    (job) => job.status === 'FAILED' || job.status === 'DEAD',
  ).length;
  const runningCount = progress.items.filter((job) => job.status === 'RUNNING').length;
  const knownQueuedCount = progress.items.filter((job) => job.status === 'QUEUED').length;
  const unseenCount = Math.max(0, progress.total - progress.items.length);
  const queuedCount = knownQueuedCount + unseenCount;
  const percent = progress.total > 0 ? Math.round((doneCount / progress.total) * 100) : 0;
  const recentJobs = progress.items.slice(0, 5);
  const queuedTooLong =
    progress.active &&
    runningCount === 0 &&
    doneCount === 0 &&
    Date.now() - new Date(progress.startedAt).getTime() > 15_000;

  return (
    <section
      className={`rounded-lg border p-4 ${
        failedCount > 0
          ? 'border-amber-200 bg-amber-50'
          : progress.active
            ? 'border-brand-200 bg-brand-50'
            : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            {progress.active ? 'Đang sync metrics' : 'Sync metrics đã xong'}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {progress.postMetricsQueued} job bài viết, {progress.accountMetricsQueued} job tài
            khoản.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-700">
          {doneCount}/{progress.total} xong
        </span>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
        <div
          className={`h-full rounded-full transition-all ${
            failedCount > 0 ? 'bg-amber-500' : 'bg-brand-600'
          }`}
          style={{ width: `${Math.max(progress.active ? 8 : 100, percent)}%` }}
        />
      </div>

      <div className="mt-3 grid gap-2 text-xs font-semibold text-slate-600 sm:grid-cols-4">
        <span>Đang chờ: {queuedCount}</span>
        <span>Đang chạy: {runningCount}</span>
        <span>Hoàn tất: {doneCount}</span>
        <span>Lỗi: {failedCount}</span>
      </div>

      {progress.error ? (
        <p className="mt-3 rounded-md bg-white px-3 py-2 text-sm text-amber-700">
          {progress.error}
        </p>
      ) : null}

      {queuedTooLong ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm text-amber-700">
          Worker chưa nhận job sau hơn 15 giây. Kiểm tra worker đang chạy và Redis có kết nối đúng
          không.
        </p>
      ) : null}

      {recentJobs.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {recentJobs.map((job) => (
            <div
              key={job.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-900">
                  {job.label ?? job.queueName}
                </p>
                {job.details ? (
                  <p className="truncate text-xs text-slate-500">{job.details}</p>
                ) : null}
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                {jobStatusLabel(job.status)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ExternalSyncProgress({ progress }: { progress: ExternalSyncProgressState }) {
  const doneCount = progress.items.filter((job) => TERMINAL_JOB_STATUSES.has(job.status)).length;
  const failedCount = progress.items.filter(
    (job) => job.status === 'FAILED' || job.status === 'DEAD',
  ).length;
  const runningCount = progress.items.filter((job) => job.status === 'RUNNING').length;
  const knownQueuedCount = progress.items.filter((job) => job.status === 'QUEUED').length;
  const unseenCount = Math.max(0, progress.total - progress.items.length);
  const queuedCount = knownQueuedCount + unseenCount;
  const percent = progress.total > 0 ? Math.round((doneCount / progress.total) * 100) : 0;
  const recentJobs = progress.items.slice(0, 5);

  return (
    <section
      className={`rounded-lg border p-4 ${
        failedCount > 0
          ? 'border-rose-200 bg-rose-50'
          : progress.active
            ? 'border-sky-200 bg-sky-50'
            : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">
            {progress.active ? 'Đang kéo bài ngoài tool' : 'Kéo bài ngoài tool đã xong'}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {progress.total} tài khoản đang được import bài đăng lịch sử vào DB.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-700">
          {doneCount}/{progress.total} xong
        </span>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
        <div
          className={`h-full rounded-full transition-all ${
            failedCount > 0 ? 'bg-rose-500' : 'bg-sky-600'
          }`}
          style={{ width: `${Math.max(progress.active ? 8 : 100, percent)}%` }}
        />
      </div>

      <div className="mt-3 grid gap-2 text-xs font-semibold text-slate-600 sm:grid-cols-4">
        <span>Đang chờ: {queuedCount}</span>
        <span>Đang chạy: {runningCount}</span>
        <span>Hoàn tất: {doneCount}</span>
        <span>Lỗi: {failedCount}</span>
      </div>

      {progress.error ? (
        <p className="mt-3 rounded-md bg-white px-3 py-2 text-sm text-amber-700">
          {progress.error}
        </p>
      ) : null}

      {recentJobs.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {recentJobs.map((job) => (
            <div key={job.id} className="grid gap-2 rounded-md bg-white px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-900">
                    {job.label ?? job.queueName}
                  </p>
                  {job.details ? (
                    <p className="truncate text-xs text-slate-500">{job.details}</p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                  {jobStatusLabel(job.status)}
                </span>
              </div>
              {job.errorMessage ? (
                <p className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">
                  {job.errorMessage}
                </p>
              ) : null}
              {job.progress?.counts ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  {Object.entries(job.progress.counts).map(([key, value]) => (
                    <span key={key}>
                      {countLabel(key)}: {value}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
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

function jobStatusLabel(status: BackgroundJobView['status']): string {
  switch (status) {
    case 'QUEUED':
      return 'Đang chờ';
    case 'RUNNING':
      return 'Đang chạy';
    case 'COMPLETED':
      return 'Xong';
    case 'FAILED':
      return 'Retry';
    case 'DEAD':
      return 'Lỗi';
  }
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

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-semibold text-slate-950">{value.toLocaleString('en-US')}</p>
    </div>
  );
}

function MetricCell({ metric, percent = false }: { metric: MetricValueView; percent?: boolean }) {
  return (
    <div>
      <p className="font-semibold text-slate-950">{formatMetricNumber(metric.value, percent)}</p>
      <p className="mt-1 text-xs text-slate-500">{metricSourceLabel(metric.source)}</p>
    </div>
  );
}

function PlatformMetricGrid({ metrics }: { metrics: PlatformMetricView[] }) {
  if (metrics.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">Chưa có metric riêng.</p>;
  }
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {metrics.map((metric) => (
        <div key={metric.key} className="rounded-md bg-slate-50 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold uppercase text-slate-500">{metric.label}</p>
            {metric.group ? (
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                {metric.group}
              </span>
            ) : null}
          </div>
          <p className="mt-2 break-words font-semibold text-slate-950">
            {formatPlatformMetricValue(metric)}
          </p>
        </div>
      ))}
    </div>
  );
}

function PlatformMetricBadges({ metrics }: { metrics: PlatformMetricView[] }) {
  if (metrics.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {metrics.map((metric) => (
        <span
          key={metric.key}
          className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600"
        >
          {metric.label}: {formatPlatformMetricValue(metric)}
        </span>
      ))}
    </div>
  );
}

function formatPlatformMetricValue(metric: PlatformMetricView): string {
  if (metric.value === null) return '—';
  if (typeof metric.value === 'boolean') return metric.value ? 'Có' : 'Không';
  if (typeof metric.value === 'string') return metric.value;
  if (metric.unit === 'percent') return `${metric.value.toLocaleString('en-US')}%`;
  if (metric.unit === 'seconds') return `${metric.value.toLocaleString('en-US')}s`;
  if (metric.unit === 'milliseconds') return `${metric.value.toLocaleString('en-US')}ms`;
  return metric.value.toLocaleString('en-US');
}

function MiniMetric({ label, metric }: { label: string; metric: MetricValueView }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-slate-950">{formatMetricNumber(metric.value)}</p>
    </div>
  );
}
