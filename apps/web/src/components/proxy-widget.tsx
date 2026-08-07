'use client';

import { useEffect, useState } from 'react';
import { Globe, ShieldCheck } from 'lucide-react';
import { systemApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';
import { PrimaryButton } from './form-controls';

type NetworkStatus = {
  ip: string;
  countryCode: string | null;
  country: string;
  city: string;
  isp: string;
  provider: string | null;
  checkOk: boolean;
  checkError: string | null;
  checkErrors?: string[];
  proxyConfig: {
    enabled: boolean;
    countryLock: string | null;
    proxyUrlMasked?: string | null;
    source?: 'WORKSPACE' | 'ENV' | 'DIRECT';
    version?: number;
    configVersion?: number;
  };
  proxyAvailable: boolean;
  proxyActive: boolean;
  countryLockSatisfied: boolean;
};

const COUNTRY_LOCK_OPTIONS = [
  { code: 'US', label: 'Mỹ / United States' },
  { code: 'VN', label: 'Việt Nam / Vietnam' },
  { code: 'SG', label: 'Singapore' },
  { code: 'TH', label: 'Thái Lan / Thailand' },
  { code: 'ID', label: 'Indonesia' },
  { code: 'PH', label: 'Philippines' },
  { code: 'MY', label: 'Malaysia' },
  { code: 'JP', label: 'Nhật Bản / Japan' },
  { code: 'KR', label: 'Hàn Quốc / South Korea' },
  { code: 'GB', label: 'Anh / United Kingdom' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Úc / Australia' },
  { code: 'DE', label: 'Đức / Germany' },
  { code: 'FR', label: 'Pháp / France' },
] as const;

export function ProxyWidget({
  workspaceId,
  isCollapsed = false,
}: {
  workspaceId: string;
  isCollapsed?: boolean;
}) {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pendingConfig, setPendingConfig] = useState<{
    enabled: boolean;
    countryLock: string | null;
    proxyUrl?: string | null;
    version?: number;
    configVersion?: number;
  } | null>(null);
  const [proxyUrlDraft, setProxyUrlDraft] = useState('');
  const [clearProxyUrl, setClearProxyUrl] = useState(false);

  async function fetchStatus(options: { syncDraft?: boolean; silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    try {
      const data = await systemApi.getNetworkStatus(workspaceId);
      setStatus(data);
      setLoadError(null);
      if (options.syncDraft) {
        setPendingConfig(data.proxyConfig);
        setProxyUrlDraft('');
        setClearProxyUrl(false);
      }
    } catch (e) {
      setLoadError(getErrorMessage(e));
    }
    if (!options.silent) setLoading(false);
  }

  useEffect(() => {
    void fetchStatus({ syncDraft: true });
    // Refresh periodically just in case
    const interval = setInterval(() => void fetchStatus({ silent: true }), 30000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  function toggleOpen() {
    setOpen((previous) => {
      const next = !previous;
      if (next && status) {
        setPendingConfig(status.proxyConfig);
        setProxyUrlDraft('');
        setClearProxyUrl(false);
      }
      return next;
    });
  }

  function resetDraftFromStatus() {
    if (status) {
      setPendingConfig(status.proxyConfig);
      setProxyUrlDraft('');
      setClearProxyUrl(false);
    }
  }

  async function handleSaveConfig() {
    if (!pendingConfig) return;
    setLoading(true);
    const configVer = pendingConfig.configVersion ?? pendingConfig.version;
    try {
      await systemApi.toggleProxy(workspaceId, {
        enabled: pendingConfig.enabled,
        countryLock: pendingConfig.countryLock,
        ...(clearProxyUrl
          ? { proxyUrl: null }
          : proxyUrlDraft.trim()
            ? { proxyUrl: proxyUrlDraft.trim() }
            : {}),
        configVersion: configVer,
        version: configVer,
      });
      await fetchStatus({ syncDraft: true });
      setOpen(false);
    } catch (e) {
      setLoadError(getErrorMessage(e));
      setLoading(false);
    }
  }

  function setPendingProxyEnabled(enabled: boolean) {
    setPendingConfig((previous) => (previous ? { ...previous, enabled } : null));
  }

  function setPendingCountryLock(countryLock: string | null) {
    setPendingConfig((previous) => (previous ? { ...previous, countryLock } : null));
    setCountryMenuOpen(false);
  }

  function togglePendingCountryLock(enabled: boolean) {
    setPendingConfig((previous) => {
      if (!previous) return null;
      if (!enabled) return { ...previous, countryLock: null };
      return {
        ...previous,
        countryLock: previous.countryLock ?? status?.countryCode ?? 'US',
      };
    });
  }

  if (!status) {
    return (
      <div
        className={`flex h-10 items-center justify-center rounded-md border px-3 text-sm ${
          loadError
            ? 'border-rose-200 bg-rose-50 text-rose-700'
            : 'border-slate-200 bg-white text-slate-400'
        }`}
        title={loadError ?? undefined}
      >
        {loadError ? 'Không tải được mạng' : 'Đang tải mạng...'}
      </div>
    );
  }

  const isProxyEnabled = status.proxyConfig.enabled;
  const isProxyActive = status.proxyActive;
  const isProxyMissing = isProxyEnabled && !status.proxyAvailable;
  const isNetworkUnknown = !status.checkOk;
  const isActiveLocked = isProxyEnabled && !!status.proxyConfig.countryLock;
  const savedCountryLock = status.proxyConfig.countryLock;
  const pendingCountryLockEnabled = !!pendingConfig?.enabled && !!pendingConfig.countryLock;
  const pendingCountryLock =
    pendingConfig?.countryLock ?? savedCountryLock ?? status.countryCode ?? 'US';
  const selectedCountry = getCountryOption(pendingCountryLock);
  const hasPendingChanges =
    pendingConfig?.enabled !== status.proxyConfig.enabled ||
    pendingConfig?.countryLock !== status.proxyConfig.countryLock ||
    proxyUrlDraft.trim().length > 0 ||
    clearProxyUrl;
  const buttonStateClass = isProxyActive
    ? isNetworkUnknown
      ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
    : isProxyMissing
      ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
      : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100';
  const statusLabel = isProxyActive
    ? isNetworkUnknown
      ? 'PROXY CHƯA XÁC MINH'
      : 'PROXY'
    : isProxyMissing
      ? 'THIẾU PROXY URL'
      : 'DIRECT';

  return (
    <div className="relative">
      <button
        onClick={toggleOpen}
        className={`flex w-full items-center rounded-md border px-3 py-2 text-sm transition ${buttonStateClass} ${isCollapsed ? 'justify-center' : 'justify-between'}`}
        title={isCollapsed ? `Proxy: ${statusLabel} (${status.countryCode ?? '??'})` : undefined}
      >
        {isCollapsed ? (
          <div className="flex items-center justify-center">
            {isProxyActive ? <ShieldCheck className="h-5 w-5" /> : <Globe className="h-5 w-5" />}
          </div>
        ) : (
          <>
            <div className="flex flex-1 min-w-0 items-center gap-2 pr-2">
              {isProxyActive ? (
                <ShieldCheck className="h-4 w-4 shrink-0" />
              ) : (
                <Globe className="h-4 w-4 shrink-0" />
              )}
              <span className="flex shrink-0 items-center gap-1 font-medium">
                <FlagIcon countryCode={status.countryCode} />
                {status.countryCode ?? '??'}
              </span>
              <span className="truncate text-left" title={status.ip}>
                {status.ip}
              </span>
            </div>
            <span className="shrink-0 text-xs uppercase opacity-70">{statusLabel}</span>
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute z-50 rounded-md border border-slate-200 bg-white p-3 shadow-lg ${isCollapsed ? 'left-full top-0 ml-4 w-72 mt-0' : 'top-full mt-1 w-full'}`}
        >
          <div className="mb-2 text-xs font-semibold text-slate-500">THÔNG TIN MẠNG</div>
          {loadError ? (
            <div className="mb-3 rounded-md bg-rose-50 px-2 py-2 text-xs text-rose-700">
              {loadError}
            </div>
          ) : null}
          <div className="mb-3 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <span className="shrink-0 text-slate-500">IP:</span>
              <span className="truncate font-medium text-slate-900" title={status.ip}>
                {status.ip}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Vị trí:</span>
              <span className="text-slate-900">
                {status.city}, {status.country}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">ISP:</span>
              <span className="truncate pl-2 text-right text-slate-900">{status.isp}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Kiểm tra:</span>
              <span className="truncate pl-2 text-right text-slate-900">
                {status.checkOk ? status.provider : 'Không thành công'}
              </span>
            </div>
          </div>

          <div className="mb-2 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-500">
            CẤU HÌNH PROXY
          </div>
          <div className="space-y-2">
            <label className="flex items-center justify-between cursor-pointer text-sm">
              <span className="text-slate-700">Kích hoạt Proxy</span>
              <input
                type="checkbox"
                checked={pendingConfig?.enabled ?? false}
                onChange={(event) => setPendingProxyEnabled(event.target.checked)}
                disabled={loading}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">Proxy URL workspace</span>
              <input
                value={proxyUrlDraft}
                onChange={(event) => {
                  setProxyUrlDraft(event.target.value);
                  setClearProxyUrl(false);
                }}
                disabled={loading || clearProxyUrl}
                placeholder={status.proxyConfig.proxyUrlMasked ?? 'http://user:pass@host:port'}
                className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
              />
              <span className="mt-1 block text-xs text-slate-500">
                {status.proxyConfig.source === 'WORKSPACE'
                  ? `Đang dùng proxy riêng của workspace: ${status.proxyConfig.proxyUrlMasked}`
                  : status.proxyConfig.source === 'ENV'
                    ? 'Workspace chưa có proxy riêng; bật proxy sẽ dùng proxy fallback trong env.'
                    : 'Chưa cấu hình proxy cho workspace này.'}
              </span>
            </label>
            {status.proxyConfig.source === 'WORKSPACE' ? (
              <button
                type="button"
                onClick={() => {
                  setClearProxyUrl((value) => !value);
                  setProxyUrlDraft('');
                }}
                disabled={loading}
                className={`w-full rounded-md border px-2 py-2 text-sm font-medium ${
                  clearProxyUrl
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {clearProxyUrl ? 'Sẽ xóa proxy workspace khi lưu' : 'Xóa proxy workspace'}
              </button>
            ) : null}
            <label className="flex cursor-pointer items-center justify-between text-sm">
              <span className="text-slate-700">Bật khóa quốc gia</span>
              <input
                type="checkbox"
                checked={pendingCountryLockEnabled}
                onChange={(event) => togglePendingCountryLock(event.target.checked)}
                disabled={loading || !pendingConfig?.enabled}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600 disabled:opacity-50"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-700">
                {pendingConfig?.enabled ? 'Quốc gia cần khóa' : 'Quốc gia đã lưu'}
              </span>
              <button
                type="button"
                onClick={() => setCountryMenuOpen((value) => !value)}
                disabled={loading || !pendingConfig?.enabled || !pendingCountryLockEnabled}
                className="flex w-full items-center justify-between rounded-md border border-slate-300 bg-white px-2 py-2 text-left text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              >
                <span className="flex items-center gap-2">
                  <FlagIcon countryCode={selectedCountry.code} />
                  <span>
                    {selectedCountry.code} - {selectedCountry.label}
                  </span>
                </span>
                <span className="text-xs text-slate-400">▾</span>
              </button>
            </label>
            {countryMenuOpen && pendingConfig?.enabled && pendingCountryLockEnabled ? (
              <div className="max-h-44 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-sm">
                {COUNTRY_LOCK_OPTIONS.map((country) => (
                  <button
                    key={country.code}
                    type="button"
                    onClick={() => setPendingCountryLock(country.code)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-slate-50 ${
                      country.code === pendingCountryLock
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-slate-700'
                    }`}
                  >
                    <FlagIcon countryCode={country.code} />
                    <span className="font-medium">{country.code}</span>
                    <span>{country.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="mt-3 text-xs text-slate-500">
            {isProxyMissing
              ? 'Đã bật proxy nhưng chưa có Proxy URL. Các request tới mạng xã hội sẽ bị chặn để tránh lộ IP máy chủ.'
              : isNetworkUnknown
                ? `Không kiểm tra được IP hiện tại${
                    status.checkError ? `: ${status.checkError}` : ''
                  }. Nếu đang bật khóa quốc gia, worker sẽ từ chối publish khi không xác minh được IP.`
                : isActiveLocked && !status.countryLockSatisfied
                  ? `IP hiện tại không khớp khóa ${status.proxyConfig.countryLock}; worker sẽ từ chối đăng bài.`
                  : isActiveLocked
                    ? `Nếu IP bị đổi khỏi ${status.proxyConfig.countryLock}, hệ thống sẽ từ chối đăng bài.`
                    : savedCountryLock
                      ? `Proxy đang tắt; ${savedCountryLock} chỉ là target đã lưu cho lần bật sau.`
                      : 'Khóa quốc gia chỉ kiểm tra IP hiện tại; nó không tự đổi vị trí proxy.'}
          </div>
          {isNetworkUnknown && (status.checkErrors?.length ?? 0) > 0 ? (
            <div className="mt-2 rounded-md bg-amber-50 px-2 py-2 text-[11px] text-amber-800">
              {status.checkErrors?.map((error) => (
                <div key={error} className="break-words">
                  {error}
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-4 border-t border-slate-100 pt-3">
            {hasPendingChanges ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={resetDraftFromStatus}
                  disabled={loading}
                  className="rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  Hoàn tác
                </button>
                <PrimaryButton
                  type="button"
                  className="w-full"
                  busy={loading}
                  onClick={handleSaveConfig}
                >
                  Lưu cấu hình
                </PrimaryButton>
              </div>
            ) : (
              <div className="rounded-md bg-slate-50 px-3 py-2 text-center text-xs font-medium text-slate-500">
                Cấu hình đã lưu.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getCountryOption(countryCode: string) {
  return (
    COUNTRY_LOCK_OPTIONS.find((country) => country.code === countryCode) ?? COUNTRY_LOCK_OPTIONS[0]
  );
}

function FlagIcon({ countryCode }: { countryCode: string | null | undefined }) {
  if (!countryCode) return <span className="h-3 w-5 rounded-sm bg-slate-200" aria-hidden="true" />;
  return (
    <img
      src={`https://flagcdn.com/w40/${countryCode.toLowerCase()}.png`}
      alt=""
      className="h-3 w-5 rounded-sm object-cover"
      loading="lazy"
    />
  );
}
