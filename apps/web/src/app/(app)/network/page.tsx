'use client';

import type { NetworkPolicyCategory, NetworkProxyPolicyItem } from '@socialhub/shared';
import { ChevronDown, Globe2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InlineError, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { systemApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';

type ProxyPolicyView = {
  generatedAt: string;
  proxyConfig: { enabled: boolean; countryLock: string | null };
  proxyAvailable: boolean;
  summary: { total: number; proxied: number; direct: number };
  items: NetworkProxyPolicyItem[];
};

const CATEGORY_LABELS: Record<NetworkPolicyCategory, string> = {
  SOCIAL_ADAPTER: 'Social Adapter',
  SYSTEM_CHECK: 'System Check',
  WEB_API: 'Web / API',
  STORAGE: 'Storage',
  INFRASTRUCTURE: 'Infrastructure',
};

export default function NetworkPolicyPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [policy, setPolicy] = useState<ProxyPolicyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPolicy(showToast = false) {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      setPolicy(await systemApi.getProxyPolicy(workspace.id));
      if (showToast) toast.success('Đã làm mới network policy.');
    } catch (loadError) {
      const message = getErrorMessage(loadError);
      setError(message);
      if (showToast) toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPolicy();
  }, [workspace?.id]);

  const grouped = useMemo(() => {
    const map = new Map<NetworkPolicyCategory, NetworkProxyPolicyItem[]>();
    for (const item of policy?.items ?? []) {
      map.set(item.category, [...(map.get(item.category) ?? []), item]);
    }
    return [...map.entries()];
  }, [policy]);

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const isProxyEnabled = policy?.proxyConfig.enabled ?? false;

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">Network Policy</h1>
          <p className="mt-1 text-sm text-slate-500">
            Kiểm soát và phân luồng traffic: Request nào đi qua proxy ẩn danh, request nào đi
            direct.
          </p>
        </div>
        <SecondaryButton disabled={loading} onClick={() => void loadPolicy(true)} type="button">
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </SecondaryButton>
      </header>

      <InlineError message={error} />

      <section className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:flex-row sm:divide-x sm:divide-slate-200">
        <div className="flex-1">
          <MetricBlock
            label="Tổng quy tắc"
            value={policy ? String(policy.summary.total) : '-'}
            detail={
              policy?.generatedAt ? `Cập nhật ${formatDateTime(policy.generatedAt)}` : 'Đang tải...'
            }
          />
        </div>
        <div className="flex-1">
          <MetricBlock
            label="Dùng Proxy"
            value={policy ? String(policy.summary.proxied) : '-'}
            detail={isProxyEnabled ? 'Cấu hình proxy đang BẬT' : 'Cấu hình proxy đang TẮT'}
            tone={isProxyEnabled ? 'proxy' : 'warn'}
          />
        </div>
        <div className="flex-1">
          <MetricBlock
            label="Đi Direct"
            value={policy ? String(policy.summary.direct) : '-'}
            detail="Truy cập trực tiếp, không bọc IP"
          />
        </div>
        <div className="flex-1">
          <MetricBlock
            label="Proxy Server"
            value={
              !isProxyEnabled ? 'Đang tắt' : policy?.proxyAvailable ? 'Kết nối tốt' : 'Mất kết nối'
            }
            detail={
              !isProxyEnabled
                ? 'Hệ thống đang bỏ qua Proxy'
                : policy?.proxyConfig.countryLock
                  ? `Đang lock IP: ${policy.proxyConfig.countryLock}`
                  : 'IP linh hoạt toàn cầu'
            }
            tone={!isProxyEnabled ? 'direct' : policy?.proxyAvailable ? 'proxy' : 'warn'}
          />
        </div>
      </section>

      <section>
        {grouped.length === 0 ? (
          <div className="flex min-h-[200px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50">
            <p className="text-sm font-medium text-slate-500">
              {loading ? 'Đang phân tích chính sách mạng...' : 'Chưa có quy tắc mạng nào.'}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([category, items]) => (
              <details
                key={category}
                className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all open:ring-1 open:ring-slate-900/5"
                defaultOpen
              >
                <summary className="list-none [&::-webkit-details-marker]:hidden flex cursor-pointer select-none items-center justify-between bg-white px-6 py-5 text-slate-900 transition-colors hover:bg-slate-50 group-open:border-b group-open:border-slate-100">
                  <div className="flex items-center gap-4">
                    <h2 className="text-lg font-bold tracking-tight">
                      {CATEGORY_LABELS[category]}
                    </h2>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                      {items.length} rules
                    </span>
                  </div>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 transition-transform duration-200 group-open:rotate-180">
                    <ChevronDown className="h-5 w-5 text-slate-500" />
                  </span>
                </summary>
                <div className="grid grid-cols-1 gap-5 bg-slate-50/50 p-6 md:grid-cols-2 lg:grid-cols-3">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="font-bold text-slate-900">{item.label}</h3>
                          <ProxyModeBadge mode={item.proxyMode} />
                        </div>
                        <p className="mt-1 text-xs font-medium text-slate-500">{item.owner}</p>
                        <p className="mt-3 text-sm leading-relaxed text-slate-600 line-clamp-3">
                          {item.note}
                        </p>
                      </div>

                      <div className="mt-6 border-t border-slate-100 pt-5">
                        <div className="flex flex-wrap gap-2">
                          {item.operations.map((op) => (
                            <span
                              key={op}
                              className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-500/10"
                            >
                              {op}
                            </span>
                          ))}
                        </div>
                        <div className="mt-4 truncate rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-inset ring-slate-200">
                          <code className="font-mono">{item.source}</code>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function MetricBlock({
  label,
  value,
  detail,
  tone = 'direct',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'direct' | 'proxy' | 'warn';
}) {
  const toneStyles =
    tone === 'proxy'
      ? 'bg-emerald-50/50 text-emerald-900'
      : tone === 'warn'
        ? 'bg-amber-50/50 text-amber-900'
        : 'hover:bg-slate-50/50 text-slate-900';

  const labelColor =
    tone === 'proxy' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-500';

  return (
    <div className={`flex flex-col justify-center px-5 py-3 transition-colors ${toneStyles}`}>
      <p className={`text-[10px] font-bold uppercase tracking-wider ${labelColor}`}>{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-bold tracking-tight">{value}</span>
        <span className="truncate text-xs font-medium opacity-70">{detail}</span>
      </div>
    </div>
  );
}

function ProxyModeBadge({ mode }: { mode: NetworkProxyPolicyItem['proxyMode'] }) {
  const isProxy = mode === 'PROXY';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ring-inset ${
        isProxy
          ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
          : 'bg-slate-50 text-slate-600 ring-slate-500/20'
      }`}
    >
      {isProxy ? <ShieldCheck className="h-3.5 w-3.5" /> : <Globe2 className="h-3.5 w-3.5" />}
      {mode}
    </span>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value));
}
