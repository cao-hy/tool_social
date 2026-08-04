'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  Line,
  PieChart,
  Pie,
  Cell,
  LineChart,
} from 'recharts';
import type { AnalyticsDashboardView } from '@/lib/types';

export type DashboardPost = AnalyticsDashboardView['posts'][number];

const COLORS = ['#0ea5e9', '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function DashboardCharts({ posts }: { posts: DashboardPost[] }) {
  // Aggregate Top 5 Posts by View
  const topByViews = [...posts]
    .sort((a, b) => (b.metrics.views.value ?? 0) - (a.metrics.views.value ?? 0))
    .slice(0, 5)
    .map((p) => ({
      name: p.title
        ? p.title.length > 20
          ? p.title.slice(0, 20) + '...'
          : p.title
        : 'Không tiêu đề',
      Views: p.metrics.views.value ?? 0,
      Reach: p.metrics.reach.value ?? 0,
    }));

  const topByWatchTime = [...posts]
    .filter((p) => (p.metrics.watchTime?.value ?? null) !== null)
    .sort((a, b) => (b.metrics.watchTime?.value ?? 0) - (a.metrics.watchTime?.value ?? 0))
    .slice(0, 5)
    .map((p) => ({
      name: p.title
        ? p.title.length > 20
          ? p.title.slice(0, 20) + '...'
          : p.title
        : 'Không tiêu đề',
      'Watch Time (s)': p.metrics.watchTime?.value ?? 0,
      'Avg Watch Time (s)': p.metrics.avgWatchTime?.value ?? 0,
    }));

  const totalReach = posts.reduce((sum, p) => sum + (p.metrics.reach.value ?? 0), 0);
  const totalViews = posts.reduce((sum, p) => sum + (p.metrics.views.value ?? 0), 0);
  const totalClicks = posts.reduce((sum, p) => sum + (p.metrics.clicks?.value ?? 0), 0);
  const totalLinkClicks = posts.reduce((sum, p) => sum + (p.metrics.linkClicks?.value ?? 0), 0);

  const funnelData = [
    { name: 'Reach', value: totalReach },
    { name: 'Views', value: totalViews },
    { name: 'Clicks', value: totalClicks },
    { name: 'Link Clicks', value: totalLinkClicks },
  ].filter((d) => d.value > 0);

  // Platform Comparison Chart (Grouped Bar)
  const platformStats: Record<
    string,
    { name: string; Views: number; Engagement: number; Comments: number }
  > = {};
  posts.forEach((p) => {
    let stat = platformStats[p.platform];
    if (!stat) {
      stat = { name: p.platform, Views: 0, Engagement: 0, Comments: 0 };
      platformStats[p.platform] = stat;
    }
    stat.Views += p.metrics.views?.value ?? 0;
    stat.Engagement += p.metrics.engagement?.value ?? 0;
    stat.Comments += p.metrics.comments?.value ?? 0;
  });
  const platformComparisonData = Object.values(platformStats);

  // Platform Distribution Pie Chart
  const platformPieData = platformComparisonData
    .map((d) => ({ name: d.name, value: d.Views }))
    .filter((d) => d.value > 0);

  // Daily Views Line Chart
  const dailyViews: Record<string, number> = {};
  posts.forEach((p) => {
    if (p.publishedAt) {
      const dateStr = new Date(p.publishedAt).toLocaleDateString('vi-VN');
      let viewsForDate = dailyViews[dateStr];
      if (typeof viewsForDate !== 'number') {
        viewsForDate = 0;
      }
      dailyViews[dateStr] = viewsForDate + (p.metrics.views?.value ?? 0);
    }
  });
  const dailyViewsData = Object.entries(dailyViews)
    .map(([date, Views]) => ({ date, Views }))
    .sort((a, b) => {
      // Sort by date (assuming DD/MM/YYYY for vi-VN but this simple sort might need robust parsing, we'll just sort by raw string or parse it)
      const [d1, m1, y1] = a.date.split('/');
      const [d2, m2, y2] = b.date.split('/');
      return (
        new Date(Number(y1), Number(m1) - 1, Number(d1)).getTime() -
        new Date(Number(y2), Number(m2) - 1, Number(d2)).getTime()
      );
    });

  if (posts.length === 0) return null;

  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950 mb-4">
          Top 5 bài viết nhiều View nhất
        </h2>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topByViews} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip cursor={{ fill: '#f1f5f9' }} />
              <Legend />
              <Bar dataKey="Views" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Reach" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950 mb-4">
          Phễu chuyển đổi (Toàn chiến dịch)
        </h2>
        <div className="h-[300px] w-full">
          {funnelData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={funnelData}
                layout="vertical"
                margin={{ top: 10, right: 10, left: 20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Bar
                  dataKey="value"
                  name="Lượt"
                  fill="#f59e0b"
                  barSize={32}
                  radius={[0, 4, 4, 0]}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500">
              Chưa có dữ liệu chuyển đổi
            </div>
          )}
        </div>
      </div>

      {topByWatchTime.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <h2 className="text-lg font-semibold text-slate-950 mb-4">
            Thời lượng xem Video tốt nhất
          </h2>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={topByWatchTime}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Legend />
                <Bar yAxisId="left" dataKey="Watch Time (s)" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="Avg Watch Time (s)"
                  stroke="#ef4444"
                  strokeWidth={2}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {platformComparisonData.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          <h2 className="text-lg font-semibold text-slate-950 mb-4">
            So sánh Chỉ số giữa các Nền tảng
          </h2>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={platformComparisonData}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Legend />
                <Bar dataKey="Views" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Engagement" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Comments" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {platformPieData.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950 mb-4">
            Tỷ trọng Lượt xem theo Nền tảng
          </h2>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
                <Pie
                  data={platformPieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  fill="#8884d8"
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {platformPieData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {dailyViewsData.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950 mb-4">
            Lượt xem theo thời gian (Ngày xuất bản)
          </h2>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={dailyViewsData}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="Views"
                  stroke="#0ea5e9"
                  strokeWidth={3}
                  activeDot={{ r: 8 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}
