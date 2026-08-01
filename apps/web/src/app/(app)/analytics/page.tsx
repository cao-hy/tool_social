'use client';

import Link from 'next/link';
import { BarChart3, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { analyticsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import { formatMetricNumber, metricSourceLabel } from '@/lib/post-metrics';
import type {
  AnalyticsDashboardView,
  AnalyticsMetricKey,
  MetricValueView,
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
  const [error, setError] = useState<string | null>(null);

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
    }
  }, [activeWorkspace, filters.account, filters.from, filters.platform, filters.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const platforms = useMemo(
    () => Array.from(new Set(accounts.map((account) => account.platform))).sort(),
    [accounts],
  );

  async function syncMetrics() {
    if (!activeWorkspace) return;
    setSyncing(true);
    try {
      const result = await analyticsApi.sync(activeWorkspace.id, {
        platform: filters.platform || undefined,
        socialAccountId: filters.account || undefined,
      });
      toast.success(
        `Đã đưa ${result.queued} job vào queue: ${result.postMetricsQueued} bài, ${result.accountMetricsQueued} tài khoản.`,
      );
      await load();
    } catch (syncError) {
      toast.error(getErrorMessage(syncError));
    } finally {
      setSyncing(false);
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
        <button
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          disabled={syncing}
          onClick={syncMetrics}
          type="button"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          Sync metrics
        </button>
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
            onChange={(event) =>
              setFilters((current) => ({ ...current, platform: event.target.value, account: '' }))
            }
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
                        Chưa có bài publish trong bộ lọc này.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
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

            <div className="rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 p-5">
                <h2 className="text-lg font-semibold text-slate-950">Top posts</h2>
              </div>
              <div className="divide-y divide-slate-100">
                {dashboard.topPosts.map((post) => (
                  <article key={post.id} className="grid gap-3 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase text-slate-500">
                          {post.platform} · {post.accountName}
                        </p>
                        <Link
                          className="mt-1 block truncate font-semibold text-slate-950 hover:text-brand-700"
                          href={`/posts/${post.postId}`}
                        >
                          {post.title}
                        </Link>
                      </div>
                      <BarChart3 className="h-5 w-5 shrink-0 text-brand-600" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <MiniMetric label="Views" metric={post.metrics.views} />
                      <MiniMetric label="Eng." metric={post.metrics.engagement} />
                      <MiniMetric label="Comments" metric={post.metrics.comments} />
                    </div>
                  </article>
                ))}
                {dashboard.topPosts.length === 0 ? (
                  <p className="p-5 text-sm text-slate-600">
                    Chưa có top post vì metrics chưa sync.
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        </>
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

function MiniMetric({ label, metric }: { label: string; metric: MetricValueView }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-slate-950">{formatMetricNumber(metric.value)}</p>
    </div>
  );
}
