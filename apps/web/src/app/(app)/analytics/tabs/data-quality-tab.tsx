import type { BackgroundJobView, AnalyticsDashboardView } from '@/lib/types';

const TERMINAL_JOB_STATUSES = new Set<BackgroundJobView['status']>(['COMPLETED', 'FAILED', 'DEAD']);

export interface SyncProgressState {
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

export interface ExternalSyncProgressState {
  active: boolean;
  total: number;
  jobIds: string[];
  items: BackgroundJobView[];
  startedAt: string;
  lastUpdatedAt: string | null;
  error: string | null;
}

export function DataQualityTab({
  dashboard,
  syncProgress,
  externalSyncProgress,
}: {
  dashboard: AnalyticsDashboardView;
  syncProgress: SyncProgressState | null;
  externalSyncProgress: ExternalSyncProgressState | null;
}) {
  return (
    <div className="space-y-6">
      <section className="grid gap-4 md:grid-cols-4">
        <SummaryCard label="Targets đã publish" value={dashboard.summary.publishedTargets} />
        <SummaryCard label="Đã sync metrics" value={dashboard.summary.syncedTargets} />
        <SummaryCard label="Chưa sync" value={dashboard.summary.notSyncedTargets} />
        <SummaryCard label="Không hỗ trợ" value={dashboard.summary.unsupportedTargets} />
      </section>

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
    </div>
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
                      {countLabel(key)}: {value as number}
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
