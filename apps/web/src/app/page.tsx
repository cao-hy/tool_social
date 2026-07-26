import { CURRENT_PHASE, isAvailable, NAV_ITEMS } from '@/lib/navigation';

/**
 * Trang shell của Phase 1.
 *
 * Cố ý KHÔNG dựng UI giả với dữ liệu bịa (prompt §19: "không để mock data trong
 * production flow"). Một dashboard đẹp đầy số liệu giả sẽ tạo cảm giác sai rằng
 * hệ thống đã chạy. Trang này nói đúng những gì đang có và những gì chưa có.
 */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="mb-12">
        <p className="mb-2 text-sm font-medium tracking-wide text-brand-600 uppercase">
          Phase {CURRENT_PHASE} · Project Foundation
        </p>
        <h1 className="mb-3 text-3xl font-semibold text-slate-900">SocialHub Manager</h1>
        <p className="max-w-2xl text-slate-600">
          Quản lý tập trung Facebook Page, Instagram Business, Pinterest Business, YouTube và TikTok
          Business — bài đăng, lịch đăng, comment và phân tích hiệu suất.
        </p>
      </header>

      <section className="mb-10 rounded-lg border border-amber-200 bg-amber-50 p-5">
        <h2 className="mb-2 font-semibold text-amber-900">Trạng thái hiện tại</h2>
        <p className="text-sm leading-relaxed text-amber-800">
          Nền tảng dự án đã dựng xong: monorepo, TypeScript strict, database schema, hàng đợi job,
          mã hóa token và CI. <strong>Chưa có kết nối tới nền tảng mạng xã hội nào</strong>, vì
          capability matrix chưa được xác minh với tài liệu API chính thức. Hệ thống không hiển thị
          tính năng mà nó chưa thực sự làm được.
        </p>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Lộ trình các trang</h2>
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {NAV_ITEMS.map((item) => {
            const available = isAvailable(item);
            return (
              <li key={item.href} className="flex items-center justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <p className={`font-medium ${available ? 'text-slate-900' : 'text-slate-400'}`}>
                    {item.label}
                  </p>
                  <p className="truncate text-sm text-slate-500">{item.description}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                    available ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {available ? 'Sẵn sàng' : `Phase ${item.phase}`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <p>
          Tài liệu: <code className="text-slate-700">docs/PROJECT_PLAN.md</code> ·{' '}
          <code className="text-slate-700">docs/ARCHITECTURE.md</code> ·{' '}
          <code className="text-slate-700">docs/SOCIAL_API_CAPABILITIES.md</code>
        </p>
      </footer>
    </main>
  );
}
