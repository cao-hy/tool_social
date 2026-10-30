'use client';

import {
  PLATFORM_LABELS,
  STORE_PROXY_TARGETS,
  STORE_PROXY_TARGET_LABELS,
  type StoreProxyTarget,
} from '@socialhub/shared';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Globe2,
  HelpCircle,
  Link2,
  RefreshCw,
  Shield,
  ShoppingBag,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { storesApi } from '@/lib/api-client';
import { getErrorMessage } from '@/lib/errors';
import type {
  SocialAccountView,
  StoreProxySummaryView,
  StoreShopifySummaryView,
  StoreView,
} from '@/lib/types';

export type StoreSettingsTab = 'general' | 'shopify' | 'proxy';

export const STORE_COLOR_SWATCHES = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#059669',
  '#0891b2',
  '#4f46e5',
  '#b45309',
] as const;

const DIRECT_RECOMMENDED_TARGETS = new Set<StoreProxyTarget>([
  'YOUTUBE',
  'FACEBOOK',
  'INSTAGRAM',
  'SHOPIFY',
]);

interface StoreSettingsModalProps {
  workspaceId: string;
  store: StoreView | null;
  accounts?: SocialAccountView[];
  defaultColorIndex?: number;
  isFirstStore?: boolean;
  initialTab?: StoreSettingsTab;
  onClose: () => void;
  onSaved?: (updatedStore?: StoreView) => void | Promise<void>;
}

export function StoreSettingsModal({
  workspaceId,
  store,
  accounts = [],
  defaultColorIndex = 0,
  isFirstStore = false,
  initialTab = 'general',
  onClose,
  onSaved,
}: StoreSettingsModalProps) {
  const toast = useToast();
  const [currentStore, setCurrentStore] = useState<StoreView | null>(store);
  const [activeTab, setActiveTab] = useState<StoreSettingsTab>(store ? initialTab : 'general');

  // Tab 1: General & Accounts
  const [name, setName] = useState(store?.name ?? '');
  const [description, setDescription] = useState(store?.description ?? '');
  const [color, setColor] = useState(
    store?.color ??
      STORE_COLOR_SWATCHES[defaultColorIndex % STORE_COLOR_SWATCHES.length] ??
      '#2563eb',
  );
  const [isDefault, setIsDefault] = useState(store?.isDefault ?? isFirstStore);
  const [socialAccountIds, setSocialAccountIds] = useState<string[]>(() => {
    if (!store) return [];
    const fromAccounts = accounts
      .filter((item) => item.storeId === store.id)
      .map((item) => item.id);
    if (fromAccounts.length > 0) return fromAccounts;
    return store.accounts.map((item) => item.id);
  });
  const [savingGeneral, setSavingGeneral] = useState(false);

  // Tab 2: Shopify & Short Link (/s/...)
  const [shopifySummary, setShopifySummary] = useState<StoreShopifySummaryView | null>(
    store?.shopify ?? null,
  );
  const [shopifyEnabled, setShopifyEnabled] = useState(store?.shopify?.enabled ?? true);
  const [shopDomain, setShopDomain] = useState(store?.shopify?.shopDomain ?? '');
  const [publicDomain, setPublicDomain] = useState(store?.shopify?.publicDomain ?? '');
  const [shortPathPrefix, setShortPathPrefix] = useState(store?.shopify?.shortPathPrefix ?? '/s/');
  const [shopifyClientId, setShopifyClientId] = useState(store?.shopify?.clientId ?? '');
  const [shopifyClientSecret, setShopifyClientSecret] = useState('');
  const [showShopifyGuide, setShowShopifyGuide] = useState(!store?.shopify?.connected);
  const [savingShopify, setSavingShopify] = useState(false);
  const [testingShopify, setTestingShopify] = useState(false);
  const [deletingShopify, setDeletingShopify] = useState(false);
  const [sampleLongUrl, setSampleLongUrl] = useState('');
  const [sampleShortResult, setSampleShortResult] = useState<string | null>(null);
  const [shorteningSample, setShorteningSample] = useState(false);

  // Tab 3: Store Proxy
  const [proxySummary, setProxySummary] = useState<StoreProxySummaryView | null>(
    store?.proxy ?? null,
  );
  const [proxyEnabled, setProxyEnabled] = useState(store?.proxy?.enabled ?? false);
  const [proxyUrlInput, setProxyUrlInput] = useState('');
  const [countryLock, setCountryLock] = useState(store?.proxy?.countryLock ?? '');
  const [proxyTargets, setProxyTargets] = useState<StoreProxyTarget[]>(store?.proxy?.targets ?? []);
  const [savingProxy, setSavingProxy] = useState(false);
  const [testingProxy, setTestingProxy] = useState(false);
  const [lastLiveProxyTest, setLastLiveProxyTest] = useState<{
    checkOk: boolean;
    ip: string | null;
    countryCode: string | null;
    country: string | null;
    city: string | null;
    isp: string | null;
    checkError: string | null;
  } | null>(null);

  useEffect(() => {
    if (!store) return;
    setCurrentStore(store);
    if (store.shopify) {
      setShopifySummary(store.shopify);
      setShopifyEnabled(store.shopify.enabled);
      setShopDomain((prev) => prev || store.shopify?.shopDomain || '');
      setPublicDomain((prev) => prev || store.shopify?.publicDomain || '');
      setShortPathPrefix((prev) => prev || store.shopify?.shortPathPrefix || '/s/');
      setShopifyClientId((prev) => prev || store.shopify?.clientId || '');
    }
    if (store.proxy) {
      setProxySummary(store.proxy);
      setProxyEnabled(store.proxy.enabled);
      setCountryLock(store.proxy.countryLock ?? '');
      setProxyTargets(store.proxy.targets ?? []);
    }
  }, [store]);

  async function handleSaveGeneral(closeAfterSave: boolean) {
    if (!name.trim()) {
      toast.warning('Vui lòng nhập tên Store.');
      return;
    }
    setSavingGeneral(true);
    try {
      if (currentStore) {
        const updated = await storesApi.update(workspaceId, currentStore.id, {
          name: name.trim(),
          description: description.trim() || null,
          color,
          isDefault,
          ...(accounts.length > 0 ? { socialAccountIds } : {}),
        });
        setCurrentStore(updated);
        toast.success(`Đã cập nhật Store "${updated.name}".`);
        await onSaved?.(updated);
        if (closeAfterSave) onClose();
      } else {
        const created = await storesApi.create(workspaceId, {
          name: name.trim(),
          description: description.trim() || null,
          color,
          isDefault,
          socialAccountIds,
        });
        setCurrentStore(created);
        setShopifySummary(created.shopify ?? null);
        setProxySummary(created.proxy ?? null);
        toast.success(`Đã tạo Store "${created.name}".`);
        await onSaved?.(created);
        if (closeAfterSave) {
          onClose();
        } else if (initialTab !== 'general') {
          setActiveTab(initialTab);
        }
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingGeneral(false);
    }
  }

  async function handleSaveShopify() {
    if (!currentStore) return;
    if (!shopDomain.trim()) {
      toast.warning('Vui lòng nhập Shop Admin Domain (ví dụ: preaureum.myshopify.com).');
      return;
    }
    if (!shopifyClientId.trim()) {
      toast.warning('Vui lòng nhập Client ID từ trang $ shopify dev.');
      return;
    }
    if (!shopifySummary?.connected && !shopifyClientSecret.trim()) {
      toast.warning('Vui lòng nhập Client Secret (shpss_...) từ trang $ shopify dev.');
      return;
    }

    setSavingShopify(true);
    try {
      const saved = await storesApi.updateShopify(workspaceId, currentStore.id, {
        enabled: shopifyEnabled,
        shopDomain: shopDomain.trim(),
        publicDomain: publicDomain.trim() || null,
        shortPathPrefix: shortPathPrefix.trim() || '/s/',
        clientId: shopifyClientId.trim(),
        clientSecret: shopifyClientSecret.trim() || undefined,
      });
      setShopifySummary(saved);
      setShopDomain(saved.shopDomain ?? shopDomain.trim());
      setPublicDomain(saved.publicDomain ?? '');
      setShortPathPrefix(saved.shortPathPrefix);
      setShopifyClientId(saved.clientId ?? shopifyClientId.trim());
      setShopifyClientSecret('');
      setShowShopifyGuide(false);
      toast.success(
        `Đã kết nối Shopify "${saved.shopName ?? saved.publicDomain}" (tự xoay token 24h)! Sẵn sàng tạo link ${saved.publicDomain}${saved.shortPathPrefix}...`,
      );
      await onSaved?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingShopify(false);
    }
  }

  async function handleTestShopify() {
    if (!currentStore) return;
    setTestingShopify(true);
    try {
      const res = await storesApi.testShopify(workspaceId, currentStore.id);
      setShopifySummary(res.shopify);
      if (res.checkOk) {
        toast.success(
          `Kết nối Shopify OK: ${res.shopName} (${res.primaryDomainHost ?? res.myshopifyDomain})`,
        );
      } else {
        toast.error(res.checkError ?? 'Kiểm tra kết nối Shopify thất bại.');
      }
      await onSaved?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setTestingShopify(false);
    }
  }

  async function handleDeleteShopify() {
    if (!currentStore || !shopifySummary?.connected) return;
    if (
      !window.confirm(
        `Ngắt kết nối Shopify khỏi Store "${currentStore.name}"? Các link /s/... đã tạo trước đó trên Shopify vẫn hoạt động bình thường.`,
      )
    ) {
      return;
    }
    setDeletingShopify(true);
    try {
      const res = await storesApi.deleteShopify(workspaceId, currentStore.id);
      setShopifySummary(res.shopify);
      setShopifyClientId('');
      setShopifyClientSecret('');
      toast.success('Đã gỡ cấu hình Shopify khỏi Store.');
      await onSaved?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDeletingShopify(false);
    }
  }

  async function handleTestShortenUrl() {
    if (!currentStore || !sampleLongUrl.trim()) return;
    setShorteningSample(true);
    setSampleShortResult(null);
    try {
      const res = await storesApi.shortenLinks(workspaceId, currentStore.id, {
        urls: [sampleLongUrl.trim()],
        cleanTracking: true,
      });
      const first = res.items[0];
      if (!first || first.error || !first.shortUrl) {
        toast.error(first?.error ?? 'Không tạo được link rút gọn.');
        return;
      }
      setSampleShortResult(first.shortUrl);
      toast.success(
        first.reused
          ? `Đã lấy lại link rút gọn sẵn có: ${first.shortUrl}`
          : `Đã tạo Redirect mới trên Shopify: ${first.shortUrl}`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setShorteningSample(false);
    }
  }

  function toggleProxyTarget(target: StoreProxyTarget) {
    setProxyTargets((prev) =>
      prev.includes(target) ? prev.filter((item) => item !== target) : [...prev, target],
    );
  }

  async function handleSaveProxy(runTestAfterSave = false) {
    if (!currentStore) return;
    if (proxyEnabled && !proxySummary?.hasProxyUrl && !proxyUrlInput.trim()) {
      toast.warning('Vui lòng nhập Proxy URL trước khi bật Proxy cho Store.');
      return;
    }

    setSavingProxy(true);
    try {
      const saved = await storesApi.updateProxy(workspaceId, currentStore.id, {
        enabled: proxyEnabled,
        ...(proxyUrlInput.trim() ? { proxyUrl: proxyUrlInput.trim() } : {}),
        countryLock: countryLock.trim() ? countryLock.trim().toUpperCase() : null,
        targets: proxyTargets,
      });
      setProxySummary(saved);
      setProxyUrlInput('');

      if (runTestAfterSave) {
        setTestingProxy(true);
        const testRes = await storesApi.testProxy(workspaceId, currentStore.id);
        setProxySummary(testRes.proxy);
        setLastLiveProxyTest({
          checkOk: testRes.checkOk,
          ip: testRes.ip,
          countryCode: testRes.countryCode,
          country: testRes.country,
          city: testRes.city,
          isp: testRes.isp,
          checkError: testRes.checkError,
        });
        if (testRes.checkOk) {
          toast.success(
            `Proxy OK: IP ${testRes.ip} (${testRes.countryCode ?? 'Unknown'}${testRes.isp ? ` · ${testRes.isp}` : ''})`,
          );
        } else {
          toast.error(`Proxy lỗi: ${testRes.checkError ?? 'Không thể kết nối'}`);
        }
      } else {
        toast.success(
          saved.enabled && saved.targets.length > 0
            ? `Đã lưu Proxy Store (${saved.targets.length} nền tảng bọc Proxy, còn lại đi Direct).`
            : 'Đã lưu cấu hình Proxy Store (hiện đang đi Direct 100%).',
        );
      }

      await onSaved?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingProxy(false);
      setTestingProxy(false);
    }
  }

  async function handleClearProxyUrl() {
    if (!currentStore) return;
    if (!window.confirm('Xóa Proxy URL đã lưu và chuyển Store này về Direct 100%?')) return;
    setSavingProxy(true);
    try {
      const saved = await storesApi.updateProxy(workspaceId, currentStore.id, {
        enabled: false,
        clearProxyUrl: true,
        targets: [],
      });
      setProxySummary(saved);
      setProxyEnabled(false);
      setProxyTargets([]);
      setProxyUrlInput('');
      setLastLiveProxyTest(null);
      toast.success('Đã xóa Proxy URL và chuyển Store về chế độ Direct.');
      await onSaved?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingProxy(false);
    }
  }

  async function handleOnlyTestProxy() {
    if (!currentStore) return;
    if (proxyUrlInput.trim()) {
      await handleSaveProxy(true);
      return;
    }
    setTestingProxy(true);
    try {
      const testRes = await storesApi.testProxy(workspaceId, currentStore.id);
      setProxySummary(testRes.proxy);
      setLastLiveProxyTest({
        checkOk: testRes.checkOk,
        ip: testRes.ip,
        countryCode: testRes.countryCode,
        country: testRes.country,
        city: testRes.city,
        isp: testRes.isp,
        checkError: testRes.checkError,
      });
      if (testRes.checkOk) {
        toast.success(
          `Proxy OK: IP ${testRes.ip} (${testRes.countryCode ?? 'Unknown'}${testRes.isp ? ` · ${testRes.isp}` : ''})`,
        );
      } else {
        toast.error(`Proxy lỗi: ${testRes.checkError ?? 'Không thể kết nối'}`);
      }
      await onSaved?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setTestingProxy(false);
    }
  }

  const previewDomain =
    publicDomain
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '') ||
    shopifySummary?.publicDomain ||
    'preaureum.com';
  const previewPrefix = `/${shortPathPrefix.trim().replace(/^\/+|\/+$/g, '') || 's'}/`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-[1px] sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* HEADER */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <div className="min-w-0">
              <h2 className="truncate text-base font-bold text-slate-950 sm:text-lg">
                {currentStore ? `Cài đặt Store: ${currentStore.name}` : 'Tạo Store / Brand mới'}
              </h2>
              <p className="text-xs text-slate-500">
                Quản lý kênh mạng xã hội, rút gọn link Shopify chính chủ (/s/...) và Proxy độc lập
              </p>
            </div>
          </div>
          <button
            aria-label="Đóng"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* TABS */}
        <div className="flex shrink-0 border-b border-slate-200 bg-slate-50/70 px-5">
          <button
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition ${
              activeTab === 'general'
                ? 'border-slate-900 text-slate-950'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
            onClick={() => setActiveTab('general')}
            type="button"
          >
            <span>Thông tin &amp; Kênh</span>
          </button>
          <button
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition ${
              activeTab === 'shopify'
                ? 'border-emerald-600 text-emerald-800'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            } ${!currentStore ? 'cursor-not-allowed opacity-45' : ''}`}
            disabled={!currentStore}
            onClick={() => setActiveTab('shopify')}
            title={!currentStore ? 'Hãy lưu tạo Store trước khi cấu hình Shopify' : undefined}
            type="button"
          >
            <ShoppingBag className="h-3.5 w-3.5" />
            <span>Shopify &amp; Link /s/</span>
            {shopifySummary?.connected ? (
              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                ON
              </span>
            ) : null}
          </button>
          <button
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition ${
              activeTab === 'proxy'
                ? 'border-indigo-600 text-indigo-800'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            } ${!currentStore ? 'cursor-not-allowed opacity-45' : ''}`}
            disabled={!currentStore}
            onClick={() => setActiveTab('proxy')}
            title={!currentStore ? 'Hãy lưu tạo Store trước khi cấu hình Proxy' : undefined}
            type="button"
          >
            <Globe2 className="h-3.5 w-3.5" />
            <span>Proxy riêng Store</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                proxySummary?.enabled && (proxySummary.targets?.length ?? 0) > 0
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'bg-slate-200 text-slate-600'
              }`}
            >
              {proxySummary?.enabled && (proxySummary.targets?.length ?? 0) > 0
                ? `${proxySummary.targets.length} đích`
                : 'Direct'}
            </span>
          </button>
        </div>

        {/* BODY */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {activeTab === 'general' ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Tên Store / Thương hiệu *
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setName(e.target.value)}
                    placeholder="VD: PreAureum, Wrydeco, ChillGen Rugs..."
                    type="text"
                    value={name}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Mô tả ngắn (tùy chọn)
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="VD: Trang sức bạc PreAureum US"
                    type="text"
                    value={description}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Màu nhận diện Store
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {STORE_COLOR_SWATCHES.map((swatch) => (
                      <button
                        key={swatch}
                        aria-label={`Chọn màu ${swatch}`}
                        className={`h-6 w-6 rounded-full border-2 transition ${
                          color === swatch
                            ? 'scale-110 border-slate-950 ring-2 ring-slate-300'
                            : 'border-transparent hover:scale-105'
                        }`}
                        onClick={() => setColor(swatch)}
                        style={{ backgroundColor: swatch }}
                        type="button"
                      />
                    ))}
                  </div>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
                  <input
                    checked={isDefault}
                    className="rounded border-slate-300"
                    onChange={(e) => setIsDefault(e.target.checked)}
                    type="checkbox"
                  />
                  Đặt làm Store mặc định khi tạo bài mới
                </label>
              </div>

              {accounts.length > 0 ? (
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Các kênh thuộc Store này ({socialAccountIds.length} đã chọn)
                  </label>
                  <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 p-2.5">
                    {accounts.map((account) => {
                      const checked = socialAccountIds.includes(account.id);
                      const otherStore =
                        account.store && account.store.id !== currentStore?.id
                          ? account.store
                          : null;
                      return (
                        <label
                          key={account.id}
                          className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs transition ${
                            checked
                              ? 'border-brand-300 bg-brand-50'
                              : 'border-slate-100 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <input
                              checked={checked}
                              onChange={() =>
                                setSocialAccountIds((prev) =>
                                  prev.includes(account.id)
                                    ? prev.filter((id) => id !== account.id)
                                    : [...prev, account.id],
                                )
                              }
                              type="checkbox"
                            />
                            <span className="font-semibold text-slate-700">
                              [{PLATFORM_LABELS[account.platform]}]
                            </span>
                            <span className="truncate font-medium text-slate-900">
                              {account.name}
                            </span>
                          </div>
                          {otherStore ? (
                            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                              Đang ở: {otherStore.name}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === 'shopify' && currentStore ? (
            <div className="space-y-4">
              {shopifySummary?.connected ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-xs text-emerald-900">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>
                        Đã kết nối Shopify: {shopifySummary.shopName || shopifySummary.shopDomain}
                      </span>
                    </div>
                    <p className="text-emerald-800">
                      Link rút gọn chính chủ:{' '}
                      <code className="rounded bg-white/90 px-1.5 py-0.5 font-mono font-semibold">
                        https://{shopifySummary.publicDomain}
                        {shopifySummary.shortPathPrefix}xxxxxx
                      </code>{' '}
                      · Secret: <code>{shopifySummary.clientSecretMasked}</code> (tự xoay token 24h)
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      disabled={testingShopify}
                      onClick={() => void handleTestShopify()}
                      type="button"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${testingShopify ? 'animate-spin' : ''}`}
                      />
                      {testingShopify ? 'Đang kiểm tra...' : 'Test kết nối'}
                    </button>
                    <button
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                      disabled={deletingShopify}
                      onClick={() => void handleDeleteShopify()}
                      title="Gỡ cấu hình Shopify"
                      type="button"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 text-xs text-slate-700">
                <button
                  className="flex w-full items-center justify-between text-left font-semibold text-slate-900"
                  onClick={() => setShowShopifyGuide((v) => !v)}
                  type="button"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <HelpCircle className="h-4 w-4 text-brand-600" />
                    Hướng dẫn kết nối chuẩn mới Shopify Dev Dashboard ($ shopify dev · 1 phút)
                  </span>
                  <span className="text-[11px] text-brand-600">
                    {showShopifyGuide ? 'Thu gọn' : 'Xem hướng dẫn'}
                  </span>
                </button>
                {showShopifyGuide ? (
                  <ol className="mt-2.5 list-decimal space-y-1.5 pl-5 text-[11px] leading-relaxed text-slate-600">
                    <li>
                      Trong Shopify Admin → <strong>Settings → Apps → Develop apps</strong> (góc
                      trên phải) để mở trang <code>$ shopify dev</code>.
                    </li>
                    <li>
                      Cột trái chọn <strong>Apps → Create app</strong> → đặt tên (VD:{' '}
                      <code>SocialHub Link</code>).
                    </li>
                    <li>
                      Tại ô <strong>Scopes</strong>, dán cụm quyền sau rồi bấm{' '}
                      <strong>Release</strong>:{' '}
                      <button
                        className="inline-flex items-center gap-1 rounded border border-brand-200 bg-white px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-brand-700 hover:bg-brand-50"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            'read_online_store_navigation,write_online_store_navigation',
                          );
                          toast.success(
                            'Đã copy 2 quyền Scopes: read_online_store_navigation,write_online_store_navigation',
                          );
                        }}
                        title="Bấm để copy nhanh Scopes"
                        type="button"
                      >
                        <Copy className="h-3 w-3" />
                        read_online_store_navigation,write_online_store_navigation
                      </button>
                    </li>
                    <li>
                      Vào tab <strong>Home</strong> của App → mục <strong>Install app</strong> → cài
                      đặt lên đúng Store này.
                    </li>
                    <li>
                      Vào tab <strong>Settings</strong> của App → copy <strong>Client ID</strong> và{' '}
                      <strong>Secret</strong> (<code>shpss_...</code>) dán vào bên dưới (hệ thống tự
                      xoay Access Token mỗi 24h).
                    </li>
                  </ol>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Shop Admin Domain (*.myshopify.com) *
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setShopDomain(e.target.value)}
                    placeholder="VD: preaureum.myshopify.com hoặc admin.shopify.com/store/preaureum"
                    type="text"
                    value={shopDomain}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Có thể dán nguyên link <code>admin.shopify.com/store/...</code> hoặc mã handle.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Public Domain (Tên miền thương hiệu hiển thị)
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setPublicDomain(e.target.value)}
                    placeholder="Để trống sẽ tự động lấy từ Shopify (VD: preaureum.com)"
                    type="text"
                    value={publicDomain}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Tên miền chính dùng cho link rút gọn công khai.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Client ID ($ shopify dev → Settings) *
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setShopifyClientId(e.target.value)}
                    placeholder="VD: 8f9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c"
                    type="text"
                    value={shopifyClientId}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Client Secret (shpss_...){shopifySummary?.connected ? '' : ' *'}
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setShopifyClientSecret(e.target.value)}
                    placeholder={
                      shopifySummary?.connected
                        ? `Đang dùng ${shopifySummary.clientSecretMasked} (để trống nếu giữ nguyên)`
                        : 'shpss_xxxxxxxxxxxxxxxxxxxxxxxx'
                    }
                    type="password"
                    value={shopifyClientSecret}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Mã hóa AES-256-GCM trong CSDL &amp; tự động xoay mới Access Token 24h.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Tiền tố đường dẫn rút gọn
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setShortPathPrefix(e.target.value)}
                    placeholder="/s/"
                    type="text"
                    value={shortPathPrefix}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Xem trước:{' '}
                    <code>
                      https://{previewDomain}
                      {previewPrefix}k9x4m2
                    </code>
                  </p>
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  checked={shopifyEnabled}
                  className="rounded border-slate-300"
                  onChange={(e) => setShopifyEnabled(e.target.checked)}
                  type="checkbox"
                />
                Bật tính năng rút gọn link chính chủ cho Store này
              </label>

              {shopifySummary?.connected && shopifySummary.enabled ? (
                <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3.5 space-y-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-800">
                    <Sparkles className="h-3.5 w-3.5 text-brand-600" />
                    Tạo thử nhanh 1 link rút gọn {shopifySummary.publicDomain}
                    {shopifySummary.shortPathPrefix}...
                  </span>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      className="h-9 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 focus:border-brand-500 focus:outline-none"
                      onChange={(e) => setSampleLongUrl(e.target.value)}
                      placeholder={`https://${shopifySummary.publicDomain}/products/...`}
                      type="url"
                      value={sampleLongUrl}
                    />
                    <SecondaryButton
                      className="h-9 shrink-0"
                      disabled={!sampleLongUrl.trim() || shorteningSample}
                      onClick={() => void handleTestShortenUrl()}
                      type="button"
                    >
                      <Link2 className="mr-1.5 h-3.5 w-3.5 text-brand-600" />
                      {shorteningSample ? 'Đang rút gọn...' : 'Rút gọn thử'}
                    </SecondaryButton>
                  </div>
                  {sampleShortResult ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs">
                      <a
                        className="truncate font-mono font-semibold text-emerald-700 hover:underline"
                        href={sampleShortResult}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {sampleShortResult}
                      </a>
                      <button
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          void navigator.clipboard.writeText(sampleShortResult);
                          toast.success('Đã copy link rút gọn!');
                        }}
                        type="button"
                      >
                        <Copy className="h-3 w-3" />
                        Copy
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === 'proxy' && currentStore ? (
            <div className="space-y-4">
              {/* Consistency Rule Banner */}
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3.5 text-xs text-indigo-950 space-y-1">
                <div className="flex items-center gap-1.5 font-bold">
                  <Shield className="h-4 w-4 text-indigo-600" />
                  <span>Quy tắc Nhất Quán 1 IP / Nền Tảng (Zero Dual-IP &amp; Fail-Closed)</span>
                </div>
                <p className="text-[11px] leading-relaxed text-indigo-900">
                  • Nền tảng <strong>KHÔNG tích chọn</strong> (hoặc khi tắt công tắc tổng) → Đi
                  thẳng <strong>Direct 0ms</strong> từ máy chủ (khuyên dùng cho YouTube, Facebook,
                  Instagram, Shopify).
                  <br />• Nền tảng <strong>ĐƯỢC tích chọn</strong> → <strong>100% lệnh</strong> của
                  nền tảng đó trên Store này (OAuth Callback, Refresh Token, Đăng bài, Bình luận,
                  Đồng bộ) đi xuyên suốt qua Proxy bên dưới. Nếu Proxy mất mạng hoặc lệch Country
                  Lock, hệ thống <strong>tự ngắt an toàn (Fail-Closed)</strong>, tuyệt đối không rớt
                  về IP thật.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                <div>
                  <p className="text-xs font-bold text-slate-900">
                    Bật định tuyến Proxy riêng cho Store &ldquo;{currentStore.name}&rdquo;
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {proxyEnabled
                      ? `Đang bật cho ${proxyTargets.length} nền tảng đã tích bên dưới.`
                      : 'Đang tắt — Toàn bộ kết nối của Store đi thẳng Direct (tốc độ tối đa).'}
                  </p>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    checked={proxyEnabled}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                    onChange={(e) => setProxyEnabled(e.target.checked)}
                    type="checkbox"
                  />
                  <span className="text-xs font-bold text-slate-800">
                    {proxyEnabled ? 'BẬT' : 'TẮT (Direct)'}
                  </span>
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-700">
                      Proxy URL (HTTP / HTTPS)
                    </label>
                    {proxySummary?.hasProxyUrl ? (
                      <button
                        className="text-[11px] font-medium text-rose-600 hover:underline"
                        onClick={() => void handleClearProxyUrl()}
                        type="button"
                      >
                        Xóa Proxy đã lưu
                      </button>
                    ) : null}
                  </div>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                    onChange={(e) => setProxyUrlInput(e.target.value)}
                    placeholder={
                      proxySummary?.proxyUrlMasked
                        ? `Đang lưu: ${proxySummary.proxyUrlMasked} (để trống nếu giữ nguyên)`
                        : 'http://user:pass@ip:port hoặc ip:port:user:pass'
                    }
                    type="text"
                    value={proxyUrlInput}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Hỗ trợ dán cả dạng <code>ip:port:user:pass</code> lẫn{' '}
                    <code>http://user:pass@ip:port</code>.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Country Lock (tùy chọn)
                  </label>
                  <input
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs uppercase text-slate-900 focus:border-slate-900 focus:outline-none"
                    maxLength={2}
                    onChange={(e) => setCountryLock(e.target.value.toUpperCase())}
                    placeholder="VD: US"
                    type="text"
                    value={countryLock}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Mã ISO 2 ký tự (US, GB, VN...). Để trống nếu không khóa quốc gia.
                  </p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-700">
                    Chọn nền tảng đi qua Proxy của Store ({proxyTargets.length}/6 được bọc Proxy)
                  </label>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      className="font-semibold text-indigo-600 hover:underline"
                      onClick={() => {
                        setProxyEnabled(true);
                        setProxyTargets(['TIKTOK', 'PINTEREST']);
                      }}
                      type="button"
                    >
                      Gợi ý: Chỉ TikTok &amp; Pinterest
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      className="font-medium text-slate-500 hover:underline"
                      onClick={() => setProxyTargets([])}
                      type="button"
                    >
                      Bỏ tích hết (Direct)
                    </button>
                  </div>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {STORE_PROXY_TARGETS.map((target) => {
                    const checked = proxyTargets.includes(target);
                    const isDirectRecommended = DIRECT_RECOMMENDED_TARGETS.has(target);
                    return (
                      <label
                        key={target}
                        className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-xs transition ${
                          checked && proxyEnabled
                            ? 'border-indigo-400 bg-indigo-50/70'
                            : checked && !proxyEnabled
                              ? 'border-amber-300 bg-amber-50/40'
                              : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <input
                          checked={checked}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                          onChange={() => toggleProxyTarget(target)}
                          type="checkbox"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="font-bold text-slate-900">
                              {STORE_PROXY_TARGET_LABELS[target]}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                checked && proxyEnabled
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {checked && proxyEnabled ? 'Qua Proxy' : 'Direct 0ms'}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            {isDirectRecommended
                              ? 'App OAuth chính thức — khuyên để Direct 0ms'
                              : 'Tùy chọn bật nếu muốn đồng nhất IP US nuôi kênh'}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {proxyEnabled && proxyTargets.length === 0 ? (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Công tắc Proxy đang BẬT nhưng chưa tích nền tảng nào → Mọi nền tảng vẫn đang đi
                    Direct.
                  </p>
                ) : null}
              </div>

              {/* Last Check Status Card */}
              {lastLiveProxyTest || proxySummary?.lastCheckedAt ? (
                <div
                  className={`rounded-xl border px-4 py-3 text-xs ${
                    (lastLiveProxyTest?.checkOk ?? proxySummary?.lastCheckStatus === 'OK')
                      ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                      : 'border-rose-200 bg-rose-50/70 text-rose-900'
                  }`}
                >
                  {(lastLiveProxyTest?.checkOk ?? proxySummary?.lastCheckStatus === 'OK') ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-semibold">
                        <Check className="h-4 w-4 text-emerald-600" />
                        IP ra ngoài qua Proxy:{' '}
                        <code className="rounded bg-white px-1.5 py-0.5 font-mono font-bold">
                          {lastLiveProxyTest?.ip ?? proxySummary?.lastIp ?? '-'}
                        </code>{' '}
                        ({lastLiveProxyTest?.countryCode ?? proxySummary?.lastCountryCode ?? '?'})
                        {lastLiveProxyTest?.city ? ` · ${lastLiveProxyTest.city}` : ''}
                        {lastLiveProxyTest?.isp ? ` · ${lastLiveProxyTest.isp}` : ''}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                      <span>
                        <strong>Kiểm tra Proxy thất bại:</strong>{' '}
                        {lastLiveProxyTest?.checkError ??
                          proxySummary?.lastCheckError ??
                          'Không kết nối được tới cổng Proxy.'}
                      </span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* FOOTER */}
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/80 px-5 py-3.5">
          <div className="text-[11px] text-slate-500">
            {activeTab === 'general' && !currentStore
              ? 'Sau khi tạo Store, bạn có thể chuyển sang tab Shopify hoặc Proxy ngay.'
              : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={onClose} type="button">
              Đóng
            </SecondaryButton>

            {activeTab === 'general' ? (
              <>
                {!currentStore ? (
                  <SecondaryButton
                    disabled={!name.trim() || savingGeneral}
                    onClick={() => void handleSaveGeneral(false)}
                    type="button"
                  >
                    Tạo &amp; Cấu hình tiếp →
                  </SecondaryButton>
                ) : null}
                <PrimaryButton
                  busy={savingGeneral}
                  disabled={!name.trim() || savingGeneral}
                  onClick={() => void handleSaveGeneral(true)}
                  type="button"
                >
                  {currentStore ? 'Lưu thông tin Store' : 'Tạo Store'}
                </PrimaryButton>
              </>
            ) : null}

            {activeTab === 'shopify' && currentStore ? (
              <PrimaryButton
                busy={savingShopify}
                disabled={
                  savingShopify ||
                  !shopDomain.trim() ||
                  !shopifyClientId.trim() ||
                  (!shopifySummary?.connected && !shopifyClientSecret.trim())
                }
                onClick={() => void handleSaveShopify()}
                type="button"
              >
                <ShoppingBag className="mr-1.5 h-3.5 w-3.5" />
                {shopifySummary?.connected
                  ? 'Cập nhật cấu hình Shopify'
                  : 'Kết nối & Xác thực Shopify'}
              </PrimaryButton>
            ) : null}

            {activeTab === 'proxy' && currentStore ? (
              <>
                <SecondaryButton
                  disabled={
                    testingProxy ||
                    savingProxy ||
                    (!proxySummary?.hasProxyUrl && !proxyUrlInput.trim())
                  }
                  onClick={() => void handleOnlyTestProxy()}
                  type="button"
                >
                  <RefreshCw
                    className={`mr-1.5 h-3.5 w-3.5 ${testingProxy ? 'animate-spin' : ''}`}
                  />
                  {testingProxy ? 'Đang kiểm tra IP...' : 'Test IP Proxy'}
                </SecondaryButton>
                <PrimaryButton
                  busy={savingProxy}
                  disabled={savingProxy || testingProxy}
                  onClick={() => void handleSaveProxy(false)}
                  type="button"
                >
                  Lưu cấu hình Proxy
                </PrimaryButton>
              </>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
