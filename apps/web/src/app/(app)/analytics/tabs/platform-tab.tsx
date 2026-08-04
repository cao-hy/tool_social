import type { AnalyticsDashboardView } from '@/lib/types';

export function PlatformTab({ dashboard: _ }: { dashboard: AnalyticsDashboardView }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
        <h2 className="text-lg font-semibold text-slate-950">Nền tảng</h2>
        <p className="mt-2">
          Chi tiết các chỉ số đặc thù cho từng mạng xã hội sẽ hiển thị tại đây.
        </p>
      </div>
    </div>
  );
}
