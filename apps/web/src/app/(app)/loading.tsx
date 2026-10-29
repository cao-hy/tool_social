export default function AuthenticatedRouteLoading() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Đang tải trang">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-48 rounded-md bg-slate-200" />
          <div className="h-4 w-72 rounded-md bg-slate-100" />
        </div>
        <div className="flex gap-2">
          <div className="h-10 w-24 rounded-md bg-slate-200" />
          <div className="h-10 w-28 rounded-md bg-slate-200" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="h-24 rounded-xl border border-slate-200 bg-white" />
        <div className="h-24 rounded-xl border border-slate-200 bg-white" />
        <div className="h-24 rounded-xl border border-slate-200 bg-white" />
        <div className="h-24 rounded-xl border border-slate-200 bg-white" />
      </div>

      <div className="h-96 rounded-xl border border-slate-200 bg-white" />
    </div>
  );
}
