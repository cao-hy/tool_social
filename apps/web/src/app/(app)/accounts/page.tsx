'use client';

import {
  hasPermission,
  PLATFORM_LABELS,
  PLATFORMS,
  type Platform,
  type SocialAccountStatus,
} from '@socialhub/shared';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  Link2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import type { StoreSettingsTab } from '@/components/store-settings-modal';
import { useToast } from '@/components/toast-provider';
import { socialAccountsApi, storesApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import { useActiveStore } from '@/lib/store-context';
import type { SocialAccountView, StoreView } from '@/lib/types';

const PLATFORM_BADGE_STYLES: Record<Platform, string> = {
  FACEBOOK: 'bg-blue-50 text-blue-700 border-blue-200',
  INSTAGRAM: 'bg-pink-50 text-pink-700 border-pink-200',
  YOUTUBE: 'bg-red-50 text-red-700 border-red-200',
  TIKTOK: 'bg-slate-900 text-white border-slate-800',
  PINTEREST: 'bg-rose-50 text-rose-700 border-rose-200',
};

const PLATFORM_SHORT_CODES: Record<Platform, string> = {
  FACEBOOK: 'FB',
  INSTAGRAM: 'IG',
  YOUTUBE: 'YT',
  TIKTOK: 'TT',
  PINTEREST: 'PIN',
};

function hasAccountIssue(account: SocialAccountView): boolean {
  return account.status !== 'CONNECTED' || Boolean(account.lastErrorMessage);
}

function formatAccountStatusLabel(status: SocialAccountStatus): string {
  switch (status) {
    case 'CONNECTED':
      return 'Đang kết nối';
    case 'NEEDS_RECONNECT':
      return 'Cần kết nối lại';
    case 'ERROR':
      return 'Lỗi kết nối';
    case 'DISCONNECTED':
      return 'Đã ngắt kết nối';
    default:
      return status;
  }
}

function formatAccountHandle(account: SocialAccountView): string {
  const cleaned = account.username?.trim().replace(/^@+/, '');
  if (cleaned) {
    return `@${cleaned}`;
  }
  return PLATFORM_LABELS[account.platform];
}

function formatRelativeSyncTime(iso: string | null): string {
  if (!iso) return 'Chưa đồng bộ';
  const date = new Date(iso);
  const ts = date.getTime();
  if (Number.isNaN(ts)) return 'Chưa đồng bộ';

  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Vừa xong';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} giờ trước`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} ngày trước`;
  return date.toLocaleDateString('vi-VN');
}

export default function AccountsPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const storeCtx = useActiveStore();
  const { activeStore, activeStoreId, stores, accounts, loading } = storeCtx;

  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedStoreIds, setCollapsedStoreIds] = useState<Record<string, boolean>>({});

  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [copyingKey, setCopyingKey] = useState<string | null>(null);
  const [hasCopiedOAuthLink, setHasCopiedOAuthLink] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncingStoreId, setSyncingStoreId] = useState<string | null>(null);
  const [autoGrouping, setAutoGrouping] = useState(false);
  const [assigningAccountId, setAssigningAccountId] = useState<string | null>(null);

  // Dropdown menu states (mutually exclusive)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [openAddChannelMenuStoreId, setOpenAddChannelMenuStoreId] = useState<string | null>(null);
  const [openStoreMenuId, setOpenStoreMenuId] = useState<string | null>(null);
  const [openAccountMenuId, setOpenAccountMenuId] = useState<string | null>(null);

  // Reassign channel modal state
  const [reassignModalAccount, setReassignModalAccount] = useState<SocialAccountView | null>(null);
  const [reassignTargetStoreId, setReassignTargetStoreId] = useState<string>('');

  const [metaModalOpen, setMetaModalOpen] = useState(false);
  const [metaToken, setMetaToken] = useState('');
  const [metaPageIds, setMetaPageIds] = useState('');
  const [metaTargetStoreId, setMetaTargetStoreId] = useState<string>('AUTO');
  const [syncingMetaToken, setSyncingMetaToken] = useState(false);

  const [callbackModalOpen, setCallbackModalOpen] = useState(false);
  const [callbackUrlInput, setCallbackUrlInput] = useState('');
  const [completingCallback, setCompletingCallback] = useState(false);

  const [error, setError] = useState<string | null>(null);

  function closeAllMenus() {
    setToolsMenuOpen(false);
    setOpenAddChannelMenuStoreId(null);
    setOpenStoreMenuId(null);
    setOpenAccountMenuId(null);
  }

  useEffect(() => {
    closeAllMenus();
  }, [activeStoreId]);

  useEffect(() => {
    function handleDocumentMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-dropdown-root]')) {
        return;
      }
      closeAllMenus();
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeAllMenus();
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!workspace || !hasCopiedOAuthLink) return;
    function handleWindowFocus() {
      void storeCtx.refreshStores();
    }
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [hasCopiedOAuthLink, storeCtx, workspace]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const oauth = params.get('oauth');
    const reason = params.get('reason');

    if (connected) {
      toast.success(`Đã kết nối ${connected}.`);
    } else if (oauth === 'cancelled') {
      toast.warning(oauthReasonMessage(reason) ?? 'Bạn đã hủy luồng kết nối.');
    } else if (oauth === 'timeout') {
      toast.error('Kết nối quá thời gian chờ. Kiểm tra log API rồi thử lại.');
    } else if (oauth === 'missing-code' || oauth === 'failed') {
      toast.error(
        oauthReasonMessage(reason) ??
          'Kết nối chưa hoàn tất. Kiểm tra quyền app nền tảng và thử lại.',
      );
    }

    if (connected || oauth) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }
  }, [toast]);

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const matchesAccountSearch = useMemo(() => {
    return (account: SocialAccountView, storeName?: string | null) => {
      if (!normalizedSearch) return true;
      return (
        account.name.toLowerCase().includes(normalizedSearch) ||
        (account.username?.toLowerCase().includes(normalizedSearch) ?? false) ||
        account.platform.toLowerCase().includes(normalizedSearch) ||
        (storeName?.toLowerCase().includes(normalizedSearch) ?? false)
      );
    };
  }, [normalizedSearch]);

  const unassignedAccounts = useMemo(
    () => accounts.filter((account) => !account.storeId && matchesAccountSearch(account)),
    [accounts, matchesAccountSearch],
  );

  const visibleStores = useMemo(() => {
    return stores.filter((store) => {
      if (selectedStoreFilter !== 'ALL' && selectedStoreFilter !== store.id) {
        return false;
      }
      if (!normalizedSearch) return true;
      const storeAccounts = accounts.filter((item) => item.storeId === store.id);
      return (
        store.name.toLowerCase().includes(normalizedSearch) ||
        storeAccounts.some((acc) => matchesAccountSearch(acc, store.name))
      );
    });
  }, [accounts, matchesAccountSearch, normalizedSearch, selectedStoreFilter, stores]);

  const issueAccountCount = useMemo(
    () => accounts.filter((item) => hasAccountIssue(item)).length,
    [accounts],
  );

  if (!workspace) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-950">Stores &amp; Social Accounts</h1>
        <p className="mt-2 text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>
      </section>
    );
  }

  const canConnect = hasPermission(workspace.role, 'social_account:connect');
  const canDisconnect = hasPermission(workspace.role, 'social_account:disconnect');
  const totalUnassignedCount = accounts.filter((item) => !item.storeId).length;

  const allVisibleCollapsed =
    visibleStores.length > 0 &&
    visibleStores.every((store) => Boolean(collapsedStoreIds[store.id]));

  function toggleStoreCollapsed(storeId: string) {
    setCollapsedStoreIds((prev) => ({
      ...prev,
      [storeId]: !prev[storeId],
    }));
  }

  function toggleCollapseAllStores() {
    if (allVisibleCollapsed) {
      setCollapsedStoreIds({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const store of visibleStores) {
      next[store.id] = true;
    }
    setCollapsedStoreIds(next);
  }

  async function connectOAuth(platform: Platform, storeId?: string) {
    if (!workspace) return;
    const key = `${storeId ?? 'GLOBAL'}:${platform}`;
    setConnectingKey(key);
    closeAllMenus();
    setError(null);
    try {
      const result = await socialAccountsApi.startOAuth(workspace.id, platform, storeId);
      window.location.href = result.authorizationUrl;
    } catch (connectError) {
      toast.error(getErrorMessage(connectError));
      setConnectingKey(null);
    }
  }

  async function copyOAuthLink(platform: Platform, storeId?: string) {
    if (!workspace) return;
    const key = `${storeId ?? 'GLOBAL'}:${platform}`;
    setCopyingKey(key);
    setError(null);
    try {
      const result = await socialAccountsApi.startOAuth(workspace.id, platform, storeId);
      await navigator.clipboard.writeText(result.authorizationUrl);
      setHasCopiedOAuthLink(true);
      closeAllMenus();
      toast.success(
        `Đã copy link OAuth ${PLATFORM_LABELS[platform]}! Sau khi cấp quyền trên Multilogin và trang nhảy về localhost:4000, hãy copy URL đó rồi bấm "Dán Callback Multilogin".`,
      );
    } catch (copyError) {
      toast.error(getErrorMessage(copyError));
    } finally {
      setCopyingKey(null);
    }
  }

  async function openCallbackModal() {
    closeAllMenus();
    setCallbackModalOpen(true);
    try {
      const clipText = await navigator.clipboard.readText();
      if (clipText && clipText.includes('/oauth/') && clipText.includes('code=')) {
        setCallbackUrlInput(clipText.trim());
      }
    } catch {
      // Nếu trình duyệt chặn đọc clipboard tự động thì người dùng Ctrl+V vào ô input.
    }
  }

  async function submitCallbackUrl() {
    if (!workspace) return;
    if (!callbackUrlInput.trim()) {
      toast.warning('Vui lòng dán đường link Callback OAuth từ thanh địa chỉ Multilogin.');
      return;
    }
    setCompletingCallback(true);
    setError(null);
    try {
      const res = await socialAccountsApi.completeCallbackFromUrl(
        workspace.id,
        callbackUrlInput.trim(),
      );
      setCallbackModalOpen(false);
      setCallbackUrlInput('');
      setHasCopiedOAuthLink(false);
      await storeCtx.refreshStores();
      toast.success(
        `Đã kết nối thành công kênh ${res.accountName} (${PLATFORM_LABELS[res.platform]})!`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setCompletingCallback(false);
    }
  }

  async function disconnect(accountId: string) {
    if (!workspace) return;
    closeAllMenus();
    if (!window.confirm('Bạn có chắc muốn ngắt kết nối kênh này?')) return;
    setError(null);
    try {
      await socialAccountsApi.disconnect(workspace.id, accountId);
      await storeCtx.refreshStores();
      toast.success('Đã ngắt kết nối tài khoản.');
    } catch (disconnectError) {
      toast.error(getErrorMessage(disconnectError));
    }
  }

  async function testConnection(accountId: string) {
    if (!workspace) return;
    closeAllMenus();
    setTesting(accountId);
    setError(null);
    try {
      const result = await socialAccountsApi.testConnection(workspace.id, accountId);
      toast.success(`Kết nối OK: ${result.profile.name}`);
      await storeCtx.refreshStores();
    } catch (testError) {
      toast.error(getErrorMessage(testError));
    } finally {
      setTesting(null);
    }
  }

  async function syncPosts(accountId: string) {
    if (!workspace) return;
    closeAllMenus();
    setSyncing(accountId);
    setError(null);
    try {
      await socialAccountsApi.syncPosts(workspace.id, accountId);
      toast.success('Đã gửi yêu cầu đồng bộ bài viết vào queue.');
      await storeCtx.refreshStores();
    } catch (syncError) {
      toast.error(getErrorMessage(syncError));
    } finally {
      setSyncing(null);
    }
  }

  async function syncAllStorePosts(store: StoreView) {
    if (!workspace) return;
    closeAllMenus();
    const storeAccounts = accounts.filter(
      (item) => item.storeId === store.id && item.status === 'CONNECTED',
    );
    if (storeAccounts.length === 0) {
      toast.warning(`Store "${store.name}" chưa có kênh nào đang kết nối.`);
      return;
    }
    setSyncingStoreId(store.id);
    try {
      await Promise.allSettled(
        storeAccounts.map((acc) => socialAccountsApi.syncPosts(workspace.id, acc.id)),
      );
      await storeCtx.refreshStores();
      toast.success(
        `Đã gửi yêu cầu đồng bộ bài viết cho ${storeAccounts.length} kênh thuộc Store "${store.name}".`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSyncingStoreId(null);
    }
  }

  async function syncFromMetaToken() {
    if (!workspace) return;
    setSyncingMetaToken(true);
    setError(null);
    try {
      const pageIds = metaPageIds
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await socialAccountsApi.syncMetaToken(workspace.id, {
        accessToken: metaToken.trim() || undefined,
        pageIds: pageIds.length > 0 ? pageIds : undefined,
        storeId:
          metaTargetStoreId !== 'AUTO' && metaTargetStoreId !== 'NONE'
            ? metaTargetStoreId
            : undefined,
        autoCreateStores: metaTargetStoreId === 'AUTO',
      });
      setMetaToken('');
      setMetaPageIds('');
      setMetaModalOpen(false);
      await storeCtx.refreshStores();
      toast.success(`Đã đồng bộ ${result.syncedCount} tài khoản Facebook/Instagram từ Meta Token.`);
    } catch (syncError) {
      toast.error(getErrorMessage(syncError));
    } finally {
      setSyncingMetaToken(false);
    }
  }

  function openCreateStoreModal() {
    closeAllMenus();
    storeCtx.openCreateStoreModal();
  }

  function openStoreSettings(store: StoreView, initialTab: StoreSettingsTab = 'general') {
    closeAllMenus();
    storeCtx.openStoreSettingsModal(store, initialTab);
  }

  async function handleDeleteStore(store: StoreView) {
    if (!workspace) return;
    closeAllMenus();
    if (
      !window.confirm(
        `Xóa Store "${store.name}"? Các kênh và bài viết trong Store sẽ được giữ nguyên và chuyển về trạng thái Chưa gán Store.`,
      )
    ) {
      return;
    }
    try {
      await storesApi.delete(workspace.id, store.id);
      if (selectedStoreFilter === store.id) {
        setSelectedStoreFilter('ALL');
      }
      await storeCtx.refreshStores();
      toast.success(`Đã xóa Store "${store.name}".`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleAutoGroupStores() {
    if (!workspace) return;
    closeAllMenus();
    setAutoGrouping(true);
    try {
      const result = await storesApi.autoGroup(workspace.id);
      await storeCtx.refreshStores();
      toast.success(
        `Đã tự động tạo ${result.storesCreated} Store mới và gom nhóm ${result.groupedAccounts} kênh.`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAutoGrouping(false);
    }
  }

  async function handleAssignAccountStore(accountId: string, nextStoreId: string) {
    if (!workspace) return;
    setAssigningAccountId(accountId);
    try {
      await socialAccountsApi.assignStore(
        workspace.id,
        accountId,
        nextStoreId ? nextStoreId : null,
      );
      await storeCtx.refreshStores();
      toast.success('Đã cập nhật Store cho kênh.');
      setReassignModalAccount(null);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAssigningAccountId(null);
    }
  }

  function openReassignModal(account: SocialAccountView) {
    closeAllMenus();
    setReassignTargetStoreId(account.storeId ?? '');
    setReassignModalAccount(account);
  }

  function renderAccountCard(account: SocialAccountView, options?: { isUnassigned?: boolean }) {
    const isUnassigned = options?.isUnassigned ?? !account.storeId;
    const unhealthy = hasAccountIssue(account);
    const isAccountMenuOpen = openAccountMenuId === account.id;
    const handleText = formatAccountHandle(account);
    const relativeSync = formatRelativeSyncTime(account.lastSyncedAt);
    const fullSyncTitle = account.lastSyncedAt
      ? `Lần đồng bộ gần nhất: ${new Date(account.lastSyncedAt).toLocaleString('vi-VN')}`
      : 'Chưa đồng bộ bài viết lần nào';

    return (
      <div
        key={account.id}
        className={`group relative flex flex-col justify-between rounded-lg border p-3 transition ${
          unhealthy
            ? 'border-amber-300 bg-amber-50/40 hover:border-amber-400 hover:bg-amber-50/60'
            : 'border-slate-200 bg-slate-50/50 hover:border-slate-300 hover:bg-white'
        }`}
      >
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="relative shrink-0">
              {account.avatarUrl ? (
                <img
                  alt={account.name}
                  className="h-9 w-9 rounded-full border border-slate-200 object-cover"
                  src={account.avatarUrl}
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">
                  {account.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <span
                className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${
                  unhealthy ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                title={formatAccountStatusLabel(account.status)}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold text-slate-900" title={account.name}>
                  {account.name}
                </p>
                <span
                  className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                    PLATFORM_BADGE_STYLES[account.platform]
                  }`}
                  title={PLATFORM_LABELS[account.platform]}
                >
                  {PLATFORM_SHORT_CODES[account.platform]}
                </span>
                {account.profileUrl ? (
                  <a
                    className="shrink-0 text-slate-400 opacity-75 transition hover:text-slate-700 group-hover:opacity-100"
                    href={account.profileUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Mở trang kênh gốc"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>

              <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-500">
                <span className="truncate" title={handleText}>
                  {handleText}
                </span>
                <span className="text-slate-300">·</span>
                <span className="shrink-0 text-[11px] text-slate-400" title={fullSyncTitle}>
                  {account.lastSyncedAt ? `Sync ${relativeSync}` : relativeSync}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
              disabled={syncing !== null || testing === account.id}
              onClick={() => void syncPosts(account.id)}
              title="Đồng bộ bài viết từ nền tảng"
              type="button"
            >
              <RefreshCw className={`h-3 w-3 ${syncing === account.id ? 'animate-spin' : ''}`} />
              <span>Sync</span>
            </button>

            <div className="relative" data-dropdown-root="true">
              <button
                aria-label={`Tùy chọn kênh ${account.name}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-slate-500 transition hover:border-slate-200 hover:bg-white hover:text-slate-800"
                onClick={() => {
                  const next = isAccountMenuOpen ? null : account.id;
                  closeAllMenus();
                  setOpenAccountMenuId(next);
                }}
                title="Thêm thao tác"
                type="button"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>

              {isAccountMenuOpen ? (
                <div className="absolute right-0 z-30 mt-1 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={testing !== null || syncing === account.id}
                    onClick={() => void testConnection(account.id)}
                    type="button"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    <span>
                      {testing === account.id ? 'Đang kiểm tra...' : 'Kiểm tra kết nối (Test)'}
                    </span>
                  </button>

                  {canConnect ? (
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => openReassignModal(account)}
                      type="button"
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5 text-slate-500" />
                      <span>Chuyển sang Store khác...</span>
                    </button>
                  ) : null}

                  {account.profileUrl ? (
                    <a
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      href={account.profileUrl}
                      onClick={() => closeAllMenus()}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink className="h-3.5 w-3.5 text-slate-500" />
                      <span>Mở trang gốc</span>
                    </a>
                  ) : null}

                  {canDisconnect ? (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-rose-600 hover:bg-rose-50"
                        onClick={() => void disconnect(account.id)}
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Ngắt kết nối kênh</span>
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {unhealthy ? (
          <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-100/60 px-2.5 py-1.5 text-[11px] text-amber-900">
            <div className="flex min-w-0 items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="line-clamp-2" title={account.lastErrorMessage ?? undefined}>
                <strong>{formatAccountStatusLabel(account.status)}</strong>
                {account.lastErrorMessage ? ` — ${account.lastErrorMessage}` : ''}
              </span>
            </div>
            <button
              className="shrink-0 font-semibold text-amber-800 underline hover:text-amber-950"
              disabled={testing === account.id}
              onClick={() => void testConnection(account.id)}
              type="button"
            >
              {testing === account.id ? '...' : 'Kiểm tra'}
            </button>
          </div>
        ) : null}

        {isUnassigned ? (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-200/80 pt-2">
            {activeStore && canConnect ? (
              <button
                className="inline-flex items-center gap-1 rounded border border-brand-200 bg-brand-50 px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                disabled={assigningAccountId === account.id}
                onClick={() => void handleAssignAccountStore(account.id, activeStore.id)}
                title={`Gán nhanh kênh này vào Store ${activeStore.name}`}
                type="button"
              >
                + Gán vào {activeStore.name}
              </button>
            ) : null}
            <select
              aria-label={`Chọn Store cho ${account.name}`}
              className="min-w-[155px] flex-1 truncate rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-slate-900 focus:outline-none disabled:bg-slate-100"
              disabled={!canConnect || assigningAccountId === account.id}
              onChange={(e) => void handleAssignAccountStore(account.id, e.target.value)}
              value={account.storeId ?? ''}
            >
              <option value="">Gán vào Store...</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  Store: {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Stores &amp; Kênh Mạng Xã Hội</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-800">
              {stores.length} Stores
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
              {accounts.length} Kênh kết nối
            </span>
            {issueAccountCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-semibold text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                {issueAccountCount} kênh cần kiểm tra
              </span>
            ) : null}
            {totalUnassignedCount > 0 ? (
              <button
                className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100"
                onClick={() => setSelectedStoreFilter('UNASSIGNED')}
                type="button"
              >
                {totalUnassignedCount} chưa gán Store
              </button>
            ) : null}
          </div>
        </div>

        {canConnect ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative" data-dropdown-root="true">
              <SecondaryButton
                onClick={() => {
                  const next = !toolsMenuOpen;
                  closeAllMenus();
                  setToolsMenuOpen(next);
                }}
                type="button"
              >
                <Wrench className="mr-1.5 h-4 w-4 text-slate-500" />
                Nhập / Công cụ
                <ChevronDown className="ml-1.5 h-3.5 w-3.5 text-slate-500" />
              </SecondaryButton>

              {toolsMenuOpen ? (
                <div className="absolute right-0 z-30 mt-1.5 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                  <button
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      closeAllMenus();
                      setMetaTargetStoreId('AUTO');
                      setMetaModalOpen(true);
                    }}
                    type="button"
                  >
                    <ShieldCheck className="h-4 w-4 shrink-0 text-blue-600" />
                    <div>
                      <p className="font-semibold text-slate-900">Đồng bộ Meta Token</p>
                      <p className="text-[11px] text-slate-500">
                        Quét FB Pages &amp; IG từ Business Token
                      </p>
                    </div>
                  </button>

                  <button
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => void openCallbackModal()}
                    type="button"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <div>
                      <p className="font-semibold text-slate-900">Dán Callback Multilogin</p>
                      <p className="text-[11px] text-slate-500">
                        Hoàn tất OAuth cách ly qua trình duyệt phụ
                      </p>
                    </div>
                  </button>

                  <div className="my-1 border-t border-slate-100" />

                  <button
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={autoGrouping || accounts.length === 0}
                    onClick={() => void handleAutoGroupStores()}
                    type="button"
                  >
                    <Zap className="h-4 w-4 shrink-0 text-amber-500" />
                    <div>
                      <p className="font-semibold text-slate-900">
                        {autoGrouping ? 'Đang gom nhóm...' : 'Tự động gom Store'}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Ghép cặp FB + IG cùng tên thương hiệu
                      </p>
                    </div>
                  </button>
                </div>
              ) : null}
            </div>

            <PrimaryButton onClick={openCreateStoreModal} type="button">
              <Plus className="mr-1.5 h-4 w-4" />
              Tạo Store mới
            </PrimaryButton>
          </div>
        ) : null}
      </header>

      {hasCopiedOAuthLink && canConnect ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-xs text-emerald-900">
          <div>
            <strong>Đang chờ kết nối từ Multilogin:</strong> Sau khi bạn bấm{' '}
            <em>Allow / Give access</em> trên Multilogin và thấy trang báo{' '}
            <code>This site can&apos;t be reached</code> ở địa chỉ{' '}
            <code>localhost:4000/api/v1/oauth/.../callback?code=...</code>, hãy copy thanh địa chỉ
            đó rồi bấm nút bên phải.
          </div>
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            onClick={() => void openCallbackModal()}
            type="button"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Dán link Callback ngay
          </button>
        </div>
      ) : null}

      <InlineError message={error} />

      <section className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                selectedStoreFilter === 'ALL'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
              onClick={() => setSelectedStoreFilter('ALL')}
              type="button"
            >
              Tất cả Stores ({stores.length})
            </button>
            {stores.map((store) => {
              const active = selectedStoreFilter === store.id;
              const storeAllAccounts = accounts.filter((a) => a.storeId === store.id);
              const count = storeAllAccounts.length;
              const hasIssue = storeAllAccounts.some((a) => hasAccountIssue(a));
              return (
                <button
                  key={store.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedStoreFilter(store.id)}
                  type="button"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: store.color ?? '#2563eb' }}
                  />
                  <span>{store.name}</span>
                  <span className={active ? 'text-slate-300' : 'text-slate-400'}>({count})</span>
                  {hasIssue ? (
                    <span
                      className="h-2 w-2 rounded-full bg-amber-500"
                      title="Có kênh cần kiểm tra kết nối"
                    />
                  ) : null}
                </button>
              );
            })}
            {totalUnassignedCount > 0 || selectedStoreFilter === 'UNASSIGNED' ? (
              <button
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  selectedStoreFilter === 'UNASSIGNED'
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-amber-200 bg-amber-50/70 text-amber-800 hover:bg-amber-100/70'
                }`}
                onClick={() => setSelectedStoreFilter('UNASSIGNED')}
                type="button"
              >
                Chưa gán Store ({totalUnassignedCount})
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {visibleStores.length > 1 && selectedStoreFilter === 'ALL' && !normalizedSearch ? (
              <button
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                onClick={toggleCollapseAllStores}
                title={allVisibleCollapsed ? 'Mở rộng tất cả Store' : 'Thu gọn tất cả Store'}
                type="button"
              >
                {allVisibleCollapsed ? (
                  <>
                    <ChevronsUpDown className="h-3.5 w-3.5 text-slate-500" />
                    <span className="hidden sm:inline">Mở rộng</span>
                  </>
                ) : (
                  <>
                    <ChevronsDownUp className="h-3.5 w-3.5 text-slate-500" />
                    <span className="hidden sm:inline">Thu gọn</span>
                  </>
                )}
              </button>
            ) : null}

            <div className="relative w-full md:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-9 w-full rounded-lg border border-slate-300 pl-9 pr-7 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm tên kênh, @username, Store..."
                type="text"
                value={searchQuery}
              />
              {searchQuery ? (
                <button
                  aria-label="Xóa tìm kiếm"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700"
                  onClick={() => setSearchQuery('')}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {selectedStoreFilter !== 'UNASSIGNED' ? (
        <div className="space-y-3.5">
          {visibleStores.map((store) => {
            const storeAccounts = accounts.filter(
              (item) => item.storeId === store.id && matchesAccountSearch(item, store.name),
            );
            const storeIssueCount = storeAccounts.filter((item) => hasAccountIssue(item)).length;
            const isAddMenuOpen = openAddChannelMenuStoreId === store.id;
            const isStoreMenuOpen = openStoreMenuId === store.id;
            const isCollapsed =
              Boolean(collapsedStoreIds[store.id]) &&
              !normalizedSearch &&
              selectedStoreFilter === 'ALL';

            const platformCounts = PLATFORMS.map((platform) => ({
              platform,
              count: storeAccounts.filter((item) => item.platform === platform).length,
            })).filter((entry) => entry.count > 0);

            return (
              <section
                key={store.id}
                className="overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm"
                style={{ borderLeftWidth: '5px', borderLeftColor: store.color ?? '#2563eb' }}
              >
                <div
                  className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 ${
                    isCollapsed ? '' : 'border-b border-slate-100'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? `Mở rộng ${store.name}` : `Thu gọn ${store.name}`}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                      onClick={() => toggleStoreCollapsed(store.id)}
                      title={isCollapsed ? 'Mở rộng danh sách kênh' : 'Thu gọn Store này'}
                      type="button"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>

                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: store.color ?? '#2563eb' }}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          className="text-left text-base font-bold text-slate-950 hover:text-slate-700"
                          onClick={() => toggleStoreCollapsed(store.id)}
                          type="button"
                        >
                          {store.name}
                        </button>

                        {store.id === activeStoreId ? (
                          <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                            Đang thao tác
                          </span>
                        ) : (
                          <button
                            className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                            onClick={() => storeCtx.setActiveStoreId(store.id)}
                            title={`Chuyển Store đang thao tác sang ${store.name}`}
                            type="button"
                          >
                            Chọn thao tác
                          </button>
                        )}

                        {store.isDefault ? (
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                            Mặc định
                          </span>
                        ) : null}

                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          {storeAccounts.length} kênh
                        </span>

                        {isCollapsed && platformCounts.length > 0 ? (
                          <div className="flex items-center gap-1">
                            {platformCounts.map(({ platform, count }) => (
                              <span
                                key={platform}
                                className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${PLATFORM_BADGE_STYLES[platform]}`}
                                title={`${count} kênh ${PLATFORM_LABELS[platform]}`}
                              >
                                {PLATFORM_SHORT_CODES[platform]}
                                {count > 1 ? ` ${count}` : ''}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        {storeIssueCount > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                            <AlertTriangle className="h-3 w-3 text-amber-600" />
                            {storeIssueCount} kênh lỗi
                          </span>
                        ) : null}

                        {store.shopify?.connected && store.shopify.enabled ? (
                          <button
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-default"
                            disabled={!canConnect}
                            onClick={() => openStoreSettings(store, 'shopify')}
                            title="Mở cấu hình Shopify & Rút gọn link /s/ của Store này"
                            type="button"
                          >
                            <Link2 className="h-3 w-3 text-emerald-600" />
                            <span>
                              {store.shopify.publicDomain}
                              {store.shopify.shortPathPrefix}
                            </span>
                          </button>
                        ) : canConnect ? (
                          <button
                            className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 transition hover:border-emerald-300 hover:bg-emerald-50/60 hover:text-emerald-800"
                            onClick={() => openStoreSettings(store, 'shopify')}
                            title="Gắn Shopify Custom App để rút gọn link 1 chạm (/s/...)"
                            type="button"
                          >
                            <Link2 className="h-3 w-3" />
                            <span>+ Shopify (/s/)</span>
                          </button>
                        ) : null}

                        {store.proxy?.enabled && (store.proxy.targets?.length ?? 0) > 0 ? (
                          <button
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition disabled:cursor-default ${
                              store.proxy.lastCheckStatus === 'FAILED'
                                ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100'
                            }`}
                            disabled={!canConnect}
                            onClick={() => openStoreSettings(store, 'proxy')}
                            title={`Đang bọc Proxy Fail-Closed cho: ${store.proxy.targets.join(', ')}`}
                            type="button"
                          >
                            <Shield className="h-3 w-3" />
                            <span>
                              {store.proxy.lastCheckStatus === 'FAILED'
                                ? 'Proxy lỗi'
                                : `Proxy${store.proxy.countryLock ? ` ${store.proxy.countryLock}` : ''} · ${store.proxy.targets.length} đích`}
                            </span>
                          </button>
                        ) : (
                          <button
                            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-default"
                            disabled={!canConnect}
                            onClick={() => openStoreSettings(store, 'proxy')}
                            title="Mặc định đi Direct (0ms). Bấm để cấu hình Proxy riêng theo từng nền tảng cho Store này"
                            type="button"
                          >
                            <Zap className="h-3 w-3 text-amber-500" />
                            <span>Direct (0ms)</span>
                          </button>
                        )}
                      </div>

                      {store.description && !isCollapsed ? (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {store.description}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {canConnect ? (
                      <div className="relative" data-dropdown-root="true">
                        <button
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800"
                          onClick={() => {
                            const next = isAddMenuOpen ? null : store.id;
                            closeAllMenus();
                            setOpenAddChannelMenuStoreId(next);
                          }}
                          type="button"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>Thêm kênh</span>
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>

                        {isAddMenuOpen ? (
                          <div className="absolute right-0 z-30 mt-1.5 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                            <div className="px-2.5 py-1">
                              <p className="text-[11px] font-semibold uppercase text-slate-400">
                                Kết nối OAuth vào {store.name}
                              </p>
                              <p className="mt-0.5 text-[10px] text-slate-400">
                                Bấm tên kênh để mở ngay, hoặc bấm <strong>Copy</strong> để dán vào
                                Multilogin.
                              </p>
                            </div>
                            {PLATFORMS.map((platform) => {
                              const busyKey = `${store.id}:${platform}`;
                              return (
                                <div
                                  key={platform}
                                  className="flex items-center justify-between gap-1 rounded-lg px-1.5 py-1 hover:bg-slate-50"
                                >
                                  <button
                                    className="flex flex-1 items-center justify-between rounded-md px-1.5 py-1 text-left text-xs font-medium text-slate-800 hover:text-brand-700 disabled:opacity-50"
                                    disabled={connectingKey !== null || copyingKey !== null}
                                    onClick={() => void connectOAuth(platform, store.id)}
                                    type="button"
                                  >
                                    <span>+ {PLATFORM_LABELS[platform]}</span>
                                    {connectingKey === busyKey ? (
                                      <span className="text-[11px] text-slate-400">Đang mở...</span>
                                    ) : null}
                                  </button>
                                  <button
                                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
                                    disabled={connectingKey !== null || copyingKey !== null}
                                    onClick={() => void copyOAuthLink(platform, store.id)}
                                    title={`Copy link OAuth ${PLATFORM_LABELS[platform]} để dán vào trình duyệt Multilogin`}
                                    type="button"
                                  >
                                    <Copy className="h-3 w-3" />
                                    {copyingKey === busyKey ? 'Đang lấy...' : 'Copy'}
                                  </button>
                                </div>
                              );
                            })}
                            <div className="my-1 border-t border-slate-100" />
                            <button
                              className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs font-medium text-brand-700 hover:bg-brand-50"
                              onClick={() => openStoreSettings(store, 'general')}
                              type="button"
                            >
                              Chọn từ các kênh đã kết nối...
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {canConnect ? (
                      <button
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                        onClick={() => openStoreSettings(store, 'general')}
                        title="Cài đặt Store, Shopify (/s/) và Proxy riêng Store"
                        type="button"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        <span>Cài đặt</span>
                      </button>
                    ) : null}

                    <div className="relative" data-dropdown-root="true">
                      <button
                        aria-label={`Tùy chọn Store ${store.name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                        onClick={() => {
                          const next = isStoreMenuOpen ? null : store.id;
                          closeAllMenus();
                          setOpenStoreMenuId(next);
                        }}
                        title="Thêm thao tác Store"
                        type="button"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>

                      {isStoreMenuOpen ? (
                        <div className="absolute right-0 z-30 mt-1.5 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                          <button
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            disabled={storeAccounts.length === 0 || syncingStoreId === store.id}
                            onClick={() => void syncAllStorePosts(store)}
                            type="button"
                          >
                            <RefreshCw
                              className={`h-3.5 w-3.5 text-slate-500 ${
                                syncingStoreId === store.id ? 'animate-spin' : ''
                              }`}
                            />
                            <span>
                              {syncingStoreId === store.id
                                ? 'Đang đồng bộ Store...'
                                : 'Đồng bộ bài cả Store'}
                            </span>
                          </button>

                          {store.id !== activeStoreId ? (
                            <button
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                              onClick={() => {
                                closeAllMenus();
                                storeCtx.setActiveStoreId(store.id);
                              }}
                              type="button"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 text-brand-600" />
                              <span>Chọn làm Store đang thao tác</span>
                            </button>
                          ) : null}

                          {canConnect ? (
                            <>
                              <div className="my-1 border-t border-slate-100" />
                              <button
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-rose-600 hover:bg-rose-50"
                                onClick={() => void handleDeleteStore(store)}
                                type="button"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>Xóa Store {store.name}</span>
                              </button>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                {!isCollapsed ? (
                  <div className="p-4">
                    {storeAccounts.length > 0 ? (
                      <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                        {storeAccounts.map((account) =>
                          renderAccountCard(account, { isUnassigned: false }),
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/50 px-4 py-3.5">
                        <p className="text-xs text-slate-500">
                          Store <strong>{store.name}</strong> chưa có kênh nào. Bấm{' '}
                          <strong>+ Thêm kênh</strong> để kết nối OAuth hoặc chọn từ các kênh có
                          sẵn.
                        </p>
                        {canConnect ? (
                          <button
                            className="text-xs font-semibold text-brand-700 hover:underline"
                            onClick={() => openStoreSettings(store, 'general')}
                            type="button"
                          >
                            Gán kênh có sẵn vào {store.name} →
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}

          {!loading && visibleStores.length === 0 ? (
            <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
              <p className="text-base font-semibold text-slate-900">
                {stores.length === 0
                  ? 'Chưa có Store / Brand nào trong Workspace'
                  : 'Không tìm thấy Store nào khớp bộ lọc'}
              </p>
              <p className="mx-auto mt-1 max-w-lg text-xs text-slate-500">
                Tạo Store (VD: PreAureum, Wrydeco, ChillGen Rugs...) hoặc mở menu &ldquo;Nhập / Công
                cụ → Tự động gom Store&rdquo; để gom các Facebook Page và Instagram theo từng thương
                hiệu.
              </p>
              {canConnect && stores.length === 0 ? (
                <div className="mt-4 flex justify-center gap-2">
                  <SecondaryButton
                    disabled={autoGrouping || accounts.length === 0}
                    onClick={() => void handleAutoGroupStores()}
                    type="button"
                  >
                    ⚡ Tự động gom Store từ các kênh hiện có
                  </SecondaryButton>
                  <PrimaryButton onClick={openCreateStoreModal} type="button">
                    + Tạo Store đầu tiên
                  </PrimaryButton>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {(selectedStoreFilter === 'ALL' || selectedStoreFilter === 'UNASSIGNED') &&
      (unassignedAccounts.length > 0 || selectedStoreFilter === 'UNASSIGNED') ? (
        <section className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-100 bg-amber-50/60 px-4 py-3.5">
            <div>
              <h2 className="text-base font-bold text-slate-950">
                Kênh chưa gán Store ({unassignedAccounts.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-600">
                Các kênh này chưa thuộc Store nào nên chưa hiển thị khi soạn bài. Chọn Store ngay ở
                cuối mỗi thẻ
                {activeStore ? (
                  <>
                    {' '}
                    (hoặc bấm 1 chạm vào <strong>{activeStore.name}</strong>)
                  </>
                ) : null}
                .
              </p>
            </div>
            {canConnect ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {PLATFORMS.map((platform) => {
                  const busyKey = `GLOBAL:${platform}`;
                  return (
                    <div
                      key={platform}
                      className="inline-flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white"
                    >
                      <button
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={connectingKey !== null || copyingKey !== null}
                        onClick={() => void connectOAuth(platform)}
                        type="button"
                      >
                        {connectingKey === busyKey
                          ? 'Đang mở...'
                          : `+ ${PLATFORM_SHORT_CODES[platform]}`}
                      </button>
                      <button
                        className="border-l border-slate-200 px-2 py-1.5 text-xs text-slate-500 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
                        disabled={connectingKey !== null || copyingKey !== null}
                        onClick={() => void copyOAuthLink(platform)}
                        title={`Copy link OAuth ${PLATFORM_LABELS[platform]} để dán vào Multilogin`}
                        type="button"
                      >
                        {copyingKey === busyKey ? '...' : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="p-4">
            {unassignedAccounts.length > 0 ? (
              <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                {unassignedAccounts.map((account) =>
                  renderAccountCard(account, { isUnassigned: true }),
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Tất cả các kênh đã được gán vào Store đầy đủ.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {reassignModalAccount ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-950">Chuyển kênh sang Store khác</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {reassignModalAccount.name} ({PLATFORM_LABELS[reassignModalAccount.platform]})
                </p>
              </div>
              <button
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setReassignModalAccount(null)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4">
              <label className="block text-xs font-semibold text-slate-700">Chọn Store đích</label>
              <select
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                onChange={(e) => setReassignTargetStoreId(e.target.value)}
                value={reassignTargetStoreId}
              >
                <option value="">-- Gỡ khỏi Store (Chưa gán) --</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-3.5">
              <SecondaryButton onClick={() => setReassignModalAccount(null)} type="button">
                Hủy
              </SecondaryButton>
              <PrimaryButton
                busy={assigningAccountId === reassignModalAccount.id}
                disabled={
                  assigningAccountId === reassignModalAccount.id ||
                  reassignTargetStoreId === (reassignModalAccount.storeId ?? '')
                }
                onClick={() =>
                  void handleAssignAccountStore(reassignModalAccount.id, reassignTargetStoreId)
                }
                type="button"
              >
                Lưu thay đổi
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}

      {metaModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">Đồng bộ bằng Meta Access Token</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Dùng System User Token (Business Manager), User Token hoặc Page Token để tự động
                  quét toàn bộ Facebook Pages &amp; Instagram Business.
                </p>
              </div>
              <button
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setMetaModalOpen(false)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Meta Access Token (tùy chọn — để trống để dùng META_ACCESS_TOKEN đã lưu trong
                  .env)
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  onChange={(e) => setMetaToken(e.target.value)}
                  placeholder="Để trống để dùng Token mặc định của CF Group trong .env, hoặc dán Token khác..."
                  type="password"
                  value={metaToken}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Giới hạn theo Page ID (tùy chọn, cách nhau dấu phẩy)
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  onChange={(e) => setMetaPageIds(e.target.value)}
                  placeholder="Để trống để lấy tất cả Pages, hoặc nhập: 1425162140686730, ..."
                  type="text"
                  value={metaPageIds}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Quy tắc gán Store sau khi đồng bộ
                </label>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  onChange={(e) => setMetaTargetStoreId(e.target.value)}
                  value={metaTargetStoreId}
                >
                  <option value="AUTO">
                    ⚡ Tự động tạo &amp; ghép cặp Store (FB + IG) theo tên từng Page
                  </option>
                  <option value="NONE">Không gán Store (để ở mục Chưa gán)</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      Gán tất cả vào Store: {store.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <SecondaryButton onClick={() => setMetaModalOpen(false)} type="button">
                Đóng
              </SecondaryButton>
              <PrimaryButton
                busy={syncingMetaToken}
                disabled={syncingMetaToken}
                onClick={() => void syncFromMetaToken()}
                type="button"
              >
                Đồng bộ ngay
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}

      {callbackModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">
                  Hoàn tất kết nối từ Multilogin (Local)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Dán đường link <code>localhost:4000/api/v1/oauth/.../callback?code=...</code> trên
                  thanh địa chỉ Multilogin vào đây. Trình duyệt chính sẽ không mở trang mạng xã hội
                  ngoài nên giữ nguyên cách ly Proxy của Multilogin.
                </p>
              </div>
              <button
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setCallbackModalOpen(false)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Đường link Callback trên thanh địa chỉ Multilogin *
                </label>
                <textarea
                  autoFocus
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                  onChange={(e) => setCallbackUrlInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void submitCallbackUrl();
                    }
                  }}
                  placeholder="http://localhost:4000/api/v1/oauth/youtube/callback?state=...&code=..."
                  rows={4}
                  value={callbackUrlInput}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <SecondaryButton onClick={() => setCallbackModalOpen(false)} type="button">
                Đóng
              </SecondaryButton>
              <PrimaryButton
                busy={completingCallback}
                disabled={completingCallback || !callbackUrlInput.trim()}
                onClick={() => void submitCallbackUrl()}
                type="button"
              >
                Hoàn tất kết nối
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function oauthReasonMessage(reason: string | null): string | null {
  switch (reason) {
    case 'facebook_permission_not_available':
      return 'Facebook chưa grant pages_read_user_content vào token. Kiểm tra Login Configuration ID trong Facebook Login for Business có quyền này, restart API rồi disconnect/connect lại.';
    case 'platform_network':
      return 'API không gọi được nền tảng trong lúc đổi token. Kiểm tra DNS/VPN/firewall rồi bấm kết nối lại.';
    case 'platform_permission_denied':
      return 'Nền tảng từ chối quyền OAuth. Hãy kiểm tra các scope được yêu cầu trong Developer Dashboard.';
    case 'facebook_auth_invalid':
      return 'Facebook từ chối token OAuth. Hãy kiểm tra App ID/App Secret/API version và redirect URI.';
    case 'pinterest_auth_invalid':
      return 'Pinterest từ chối token OAuth hoặc token thiếu scope. Hãy kiểm tra App ID/App Secret, redirect URI và các scope user_accounts:read, boards:read, boards:write, pins:read, pins:write.';
    case 'youtube_auth_invalid':
      return 'YouTube từ chối token OAuth hoặc token thiếu scope. Hãy kiểm tra Client ID/Client Secret, redirect URI và các scope youtube.upload/youtube.readonly/youtube.force-ssl. Nếu vừa thêm scope, hãy disconnect/connect lại.';
    case 'tiktok_auth_invalid':
      return 'TikTok từ chối token OAuth hoặc token thiếu scope. Hãy kiểm tra Client Key/Client Secret, redirect URI và các scope user.info.basic/video.publish/video.upload.';
    case 'platform_auth_invalid':
      return 'Nền tảng từ chối token OAuth. Hãy kiểm tra credential, redirect URI và scope đã cấp.';
    case 'platform_platform_error':
      return 'Nền tảng trả dữ liệu khác định dạng hệ thống mong đợi. Xem log API để biết field nào sai, rồi thử kết nối lại.';
    case 'invalid_state':
      return 'OAuth state không hợp lệ hoặc đã hết hạn. Hãy bấm kết nối lại từ trang này.';
    case 'session_mismatch':
      return 'Phiên đăng nhập hiện tại không khớp với người bắt đầu OAuth. Hãy đăng nhập lại rồi kết nối.';
    case 'provider_error':
      return 'Nền tảng từ chối luồng OAuth. Hãy kiểm tra quyền được yêu cầu trong Developer Dashboard.';
    case 'cancelled':
      return null;
    default:
      return null;
  }
}
