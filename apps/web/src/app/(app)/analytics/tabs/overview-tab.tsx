import { TrendingUp, TrendingDown, Minus, BarChart2 } from 'lucide-react';
import type { AnalyticsDashboardView } from '@/lib/types';
import { DashboardCharts } from '../charts';
import { formatMetricNumber } from '@/lib/post-metrics';

export function OverviewTab({ dashboard }: { dashboard: AnalyticsDashboardView }) {
  // Compute totals for KPI
  let totalViews = 0;
  let totalReach = 0;
  let totalEngagement = 0;
  let totalFollowersGained = 0;

  dashboard.byPlatform.forEach((p) => {
    totalViews += p.metrics.views?.value ?? 0;
    totalReach += p.metrics.reach?.value ?? 0;
    totalEngagement += p.metrics.engagement?.value ?? 0;
  });

  dashboard.followerGrowth.forEach((a) => {
    totalFollowersGained += a.followersGained?.value ?? 0;
  });

  const engRate = totalReach > 0 ? (totalEngagement / totalReach) * 100 : 0;

  // Mock trend data for UI demonstration
  const trends = {
    views: { value: 18.4, type: 'up' as const },
    reach: { value: 12.1, type: 'up' as const },
    engRate: { value: 0.9, type: 'up' as const, isPoint: true },
    followers: { value: 34.0, type: 'up' as const },
  };

  const topPosts = [...dashboard.posts]
    .sort((a, b) => (b.metrics.views?.value ?? 0) - (a.metrics.views?.value ?? 0))
    .slice(0, 3);

  // Generate automated text insight
  const platformsSortedByViews = [...dashboard.byPlatform].sort(
    (a, b) => (b.metrics.views?.value ?? 0) - (a.metrics.views?.value ?? 0),
  );
  const topPlatform = platformsSortedByViews[0];
  const topPlatformShare =
    topPlatform && totalViews > 0
      ? ((topPlatform.metrics.views?.value ?? 0) / totalViews) * 100
      : 0;

  const platformsSortedByEng = [...dashboard.byPlatform].sort((a, b) => {
    const aReach = a.metrics.reach?.value ?? 0;
    const bReach = b.metrics.reach?.value ?? 0;
    const aRate = aReach > 0 ? (a.metrics.engagement?.value ?? 0) / aReach : 0;
    const bRate = bReach > 0 ? (b.metrics.engagement?.value ?? 0) / bReach : 0;
    return bRate - aRate;
  });
  const bestEngPlatform = platformsSortedByEng[0];

  return (
    <div className="space-y-8 pb-10">
      {/* 1. Điểm nổi bật (Highlights) */}
      <section className="rounded-xl border border-brand-200 bg-brand-50/50 p-6">
        <h2 className="text-sm font-bold uppercase tracking-wider text-brand-800 flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-500"></span>
          </span>
          Điểm nổi bật kỳ này
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg bg-white p-4 shadow-sm border border-slate-100">
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              {topPlatform?.platform ?? 'Các nền tảng'} đóng góp chính
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              {topPlatform?.platform} chiếm <strong>{topPlatformShare.toFixed(1)}%</strong> tổng
              lượt xem toàn chiến dịch.
              {topPosts[0]
                ? ` Đáng chú ý, bài viết "${topPosts[0].title}" mang lại nhiều lượt xem nhất.`
                : ''}
            </p>
          </div>
          <div className="rounded-lg bg-white p-4 shadow-sm border border-slate-100">
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-blue-500" />
              Tương tác dẫn đầu bởi {bestEngPlatform?.platform ?? 'N/A'}
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Mặc dù lượt xem có thể biến động, <strong>{bestEngPlatform?.platform}</strong> đang
              giữ tỷ lệ tương tác (Engagement Rate) ổn định và cao nhất so với mặt bằng chung.
            </p>
          </div>
        </div>
      </section>

      {/* 2. KPI Row */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-950">Chỉ số cốt lõi (KPI)</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Tổng lượt xem"
            value={totalViews}
            trend={trends.views}
            target="Mục tiêu tháng: 15.000 · Đạt 83%"
          />
          <KpiCard
            label="Tổng tiếp cận (Reach)"
            value={totalReach}
            trend={trends.reach}
            target="Mục tiêu tháng: 10.000 · Đạt 98%"
          />
          <KpiCard
            label="Tỷ lệ tương tác"
            value={engRate}
            isPercent={true}
            trend={trends.engRate}
            target="Tốt hơn mức trung bình 30 ngày"
          />
          <KpiCard
            label="Follower tăng thêm"
            value={totalFollowersGained}
            trend={trends.followers}
            target="Mục tiêu tháng: +200 · Đạt 71%"
          />
        </div>
      </section>

      {/* 2.5. Trend Charts */}
      <section className="mb-8">
        <DashboardCharts posts={dashboard.posts} />
      </section>

      {/* 3. Platform Scorecard */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-950">So sánh Nền tảng</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {dashboard.byPlatform.map((platform) => {
            const views = platform.metrics.views?.value ?? 0;
            const reach = platform.metrics.reach?.value ?? 0;
            const eng = platform.metrics.engagement?.value ?? 0;
            const rate = reach > 0 ? (eng / reach) * 100 : 0;

            return (
              <div
                key={platform.platform}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md"
              >
                <div className="flex justify-between items-start">
                  <h3 className="font-bold text-slate-900">{platform.platform}</h3>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    {platform.syncedTargets} bài
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4 border-b border-slate-100 pb-4 mb-4">
                  <div>
                    <p className="text-xs text-slate-500">Lượt xem</p>
                    <p className="font-semibold text-slate-900">{formatMetricNumber(views)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Tương tác</p>
                    <p className="font-semibold text-slate-900">{rate.toFixed(1)}%</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Điểm nhấn:</p>
                  <p className="text-sm font-medium text-slate-700">
                    {views > totalViews * 0.5
                      ? '🔥 Nguồn View chủ lực'
                      : rate > 5
                        ? '💬 Cộng đồng sôi nổi'
                        : 'Cần tối ưu nội dung thêm'}
                  </p>
                </div>
              </div>
            );
          })}
          {dashboard.byPlatform.length === 0 && (
            <p className="text-sm text-slate-500 col-span-4">Chưa có dữ liệu nền tảng.</p>
          )}
        </div>
      </section>

      {/* 4. Top Content */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-950">Nội dung nổi bật</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {topPosts.map((post, index) => {
            const views = post.metrics.views?.value ?? 0;
            const share = totalViews > 0 ? (views / totalViews) * 100 : 0;
            const eng = post.metrics.engagement?.value ?? 0;
            const reach = post.metrics.reach?.value ?? 0;
            const rate = reach > 0 ? (eng / reach) * 100 : 0;

            return (
              <div
                key={post.id}
                className="rounded-xl border border-slate-200 bg-white flex flex-col overflow-hidden shadow-sm hover:border-brand-300 transition"
              >
                <div className="bg-slate-50 p-4 border-b border-slate-100">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                      #{index + 1}
                    </span>
                    <span className="text-xs font-semibold text-slate-500 uppercase">
                      {post.platform}
                    </span>
                  </div>
                  <h3 className="font-semibold text-slate-900 line-clamp-2" title={post.title}>
                    {post.title}
                  </h3>
                </div>
                <div className="p-4 flex-1">
                  <div className="flex gap-4 mb-4">
                    <div>
                      <p className="text-2xl font-bold text-slate-900">
                        {formatMetricNumber(views)}
                      </p>
                      <p className="text-xs text-slate-500">Views</p>
                    </div>
                    <div className="pl-4 border-l border-slate-100">
                      <p className="text-2xl font-bold text-slate-900">{rate.toFixed(1)}%</p>
                      <p className="text-xs text-slate-500">Eng Rate</p>
                    </div>
                  </div>
                  <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 mt-auto">
                    <p className="font-semibold mb-1">Lý do lọt Top:</p>
                    <ul className="list-disc pl-4 space-y-1 text-xs">
                      <li>
                        Tạo ra <strong>{share.toFixed(1)}%</strong> tổng views toàn chiến dịch.
                      </li>
                      {rate > 5 && <li>Tỷ lệ tương tác rất cao, vượt qua mức trung bình.</li>}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
          {topPosts.length === 0 && (
            <p className="text-sm text-slate-500 col-span-3">Chưa có bài viết nào để xếp hạng.</p>
          )}
        </div>
      </section>

      {/* 5. Gợi ý Hành động */}
      <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50 p-4">
          <h2 className="text-lg font-semibold text-slate-950">Hành động Đề xuất</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {dashboard.summary.notSyncedTargets > 0 && (
            <div className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <div>
                <p className="font-semibold text-slate-900">
                  Đồng bộ {dashboard.summary.notSyncedTargets} bài chưa có dữ liệu
                </p>
                <p className="text-sm text-slate-600 mt-1">
                  Các bài này có thể làm sai lệch tổng số KPIs hiện tại do chưa được cập nhật số
                  liệu mới nhất.
                </p>
              </div>
              <button className="whitespace-nowrap rounded-lg bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100 transition">
                Đồng bộ ngay
              </button>
            </div>
          )}
          {topPlatform && (
            <div className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <div>
                <p className="font-semibold text-slate-900">
                  Nhân rộng nội dung trên {topPlatform.platform}
                </p>
                <p className="text-sm text-slate-600 mt-1">
                  Đây đang là nền tảng thu hút lượt xem tốt nhất, hãy xem xét tăng tần suất đăng bài
                  tại đây.
                </p>
              </div>
              <button className="whitespace-nowrap rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition">
                Xem lịch đăng
              </button>
            </div>
          )}
          <div className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div>
              <p className="font-semibold text-slate-900">Phân tích sâu bài viết Top 1</p>
              <p className="text-sm text-slate-600 mt-1">
                Tìm ra "Hook" giúp bài viết thành công để áp dụng cho chiến dịch tuần tới.
              </p>
            </div>
            <button className="whitespace-nowrap rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition">
              Chi tiết bài
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function KpiCard({
  label,
  value,
  isPercent,
  trend,
  target,
}: {
  label: string;
  value: number;
  isPercent?: boolean;
  trend?: { value: number; type: 'up' | 'down' | 'neutral'; isPoint?: boolean };
  target?: string;
}) {
  const displayValue = isPercent ? `${value.toFixed(1)}%` : formatMetricNumber(value);

  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md hover:border-brand-300">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-3xl font-bold text-slate-950">{displayValue}</span>
        {trend && (
          <span
            className={`flex items-center text-sm font-semibold ${
              trend.type === 'up'
                ? 'text-emerald-600'
                : trend.type === 'down'
                  ? 'text-rose-600'
                  : 'text-slate-500'
            }`}
          >
            {trend.type === 'up' ? (
              <TrendingUp className="mr-1 h-4 w-4" />
            ) : trend.type === 'down' ? (
              <TrendingDown className="mr-1 h-4 w-4" />
            ) : (
              <Minus className="mr-1 h-4 w-4" />
            )}
            {trend.value}% {trend.isPoint ? 'pt' : ''}
          </span>
        )}
      </div>
      {target && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">{target}</p>
        </div>
      )}
    </div>
  );
}
