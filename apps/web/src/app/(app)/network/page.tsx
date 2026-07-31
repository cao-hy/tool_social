'use client';

import type { NetworkPolicyCategory, NetworkProxyPolicyItem } from '@socialhub/shared';
import { Globe2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InlineError, SecondaryButton } from '@/components/form-controls';
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
  SOCIAL_ADAPTER: 'Social adapter',
  SYSTEM_CHECK: 'System check',
  WEB_API: 'Web/API',
  STORAGE: 'Storage',
  INFRASTRUCTURE: 'Infrastructure',
};

export default function NetworkPolicyPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [policy, setPolicy] = useState<ProxyPolicyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPolicy() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      setPolicy(await systemApi.getProxyPolicy(workspace.id));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
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

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Network Policy</h1>
          <p className="mt-1 text-sm text-slate-600">
            Kiểm soát request nào đi qua proxy và request nào đi direct.
          </p>
        </div>
        <SecondaryButton disabled={loading} onClick={() => void loadPolicy()} type="button">
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </SecondaryButton>
      </header>

      <InlineError message={error} />

      <section className="grid gap-3 md:grid-cols-4">
        <MetricBlock
          label="Tổng policy"
          value={policy ? String(policy.summary.total) : '-'}
          detail={
            policy?.generatedAt ? `Cập nhật ${formatDateTime(policy.generatedAt)}` : 'Chưa tải'
          }
        />
        <MetricBlock
          label="Dùng proxy"
          value={policy ? String(policy.summary.proxied) : '-'}
          detail={policy?.proxyConfig.enabled ? 'Proxy config đang bật' : 'Proxy config đang tắt'}
          tone="proxy"
        />
        <MetricBlock
          label="Đi direct"
          value={policy ? String(policy.summary.direct) : '-'}
          detail="Không qua social proxy"
        />
        <MetricBlock
          label="Proxy URL"
          value={policy?.proxyAvailable ? 'Có' : 'Thiếu'}
          detail={
            policy?.proxyConfig.countryLock
              ? `Lock ${policy.proxyConfig.countryLock}`
              : 'Không khóa'
          }
          tone={policy?.proxyAvailable ? 'proxy' : 'warn'}
        />
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-950">Policy registry</h2>
        </div>

        {grouped.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-600">
            {loading ? 'Đang tải policy...' : 'Chưa có policy.'}
          </p>
        ) : (
          <div className="divide-y divide-slate-200">
            {grouped.map(([category, items]) => (
              <div key={category} className="px-5 py-4">
                <h3 className="text-sm font-semibold text-slate-950">
                  {CATEGORY_LABELS[category]}
                </h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[880px] text-left text-sm">
                    <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="w-64 py-2 pr-4">API surface</th>
                        <th className="w-32 py-2 pr-4">Route</th>
                        <th className="py-2 pr-4">Operations</th>
                        <th className="w-64 py-2 pr-4">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {items.map((item) => (
                        <tr key={item.id} className="align-top">
                          <td className="py-3 pr-4">
                            <p className="font-semibold text-slate-950">{item.label}</p>
                            <p className="mt-1 text-xs text-slate-500">{item.owner}</p>
                            <p className="mt-2 text-xs text-slate-500">{item.note}</p>
                          </td>
                          <td className="py-3 pr-4">
                            <ProxyModeBadge mode={item.proxyMode} />
                          </td>
                          <td className="py-3 pr-4">
                            <ul className="space-y-1 text-slate-700">
                              {item.operations.map((operation) => (
                                <li key={operation}>{operation}</li>
                              ))}
                            </ul>
                          </td>
                          <td className="py-3 pr-4">
                            <code className="break-all rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                              {item.source}
                            </code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
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
  const toneClass =
    tone === 'proxy'
      ? 'border-emerald-200 bg-emerald-50'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50'
        : 'border-slate-200 bg-white';
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
      <p className="mt-1 text-sm text-slate-600">{detail}</p>
    </div>
  );
}

function ProxyModeBadge({ mode }: { mode: NetworkProxyPolicyItem['proxyMode'] }) {
  const isProxy = mode === 'PROXY';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        isProxy ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
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
