import type { AnalyticsDashboardView } from '@/lib/types';

export function ContentTab({ dashboard: _ }: { dashboard: AnalyticsDashboardView }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
        <h2 className="text-lg font-semibold text-slate-950">Nội dung</h2>
        <p className="mt-2">
          Phân tích loại nội dung, bản đồ phân tán và chi tiết bài đăng sẽ được hiển thị tại đây.
        </p>
      </div>
    </div>
  );
}
