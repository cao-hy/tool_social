'use client';

import { useQueryClient } from '@tanstack/react-query';
import { hasPermission, PLATFORM_LABELS, PLATFORMS, type Platform } from '@socialhub/shared';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InlineError, PrimaryButton, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { useWorkspaceEventSubscription } from '@/components/workspace-events-provider';
import { socialAccountsApi, storesApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { SocialAccountView, StoreView } from '@/lib/types';
import { SHARED_META_STALE_TIME, workspaceQueryKeys } from '@/lib/workspace-queries';

const STORE_COLOR_SWATCHES = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#059669',
  '#0891b2',
  '#4f46e5',
  '#b45309',
] as const;

const PLATFORM_BADGE_STYLES: Record<Platform, string> = {
  FACEBOOK: 'bg-blue-50 text-blue-700 border-blue-200',
  INSTAGRAM: 'bg-pink-50 text-pink-700 border-pink-200',
  YOUTUBE: 'bg-red-50 text-red-700 border-red-200',
  TIKTOK: 'bg-slate-900 text-white border-slate-800',
  PINTEREST: 'bg-rose-50 text-rose-700 border-rose-200',
};

interface StoreModalDraft {
  id: string | null;
  name: string;
  description: string;
  color: string;
  isDefault: boolean;
  socialAccountIds: string[];
}

export default function AccountsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [accounts, setAccounts] = useState<SocialAccountView[]>(
    () =>
      (workspace
        ? queryClient.getQueryData<{ items: SocialAccountView[] }>(
            workspaceQueryKeys.socialAccounts(workspace.id),
          )?.items
        : undefined) ?? [],
  );
  const [stores, setStores] = useState<StoreView[]>(
    () =>
      (workspace
        ? queryClient.getQueryData<{ items: StoreView[] }>(workspaceQueryKeys.stores(workspace.id))
            ?.items
        : undefined) ?? [],
  );
  const [selectedStoreFilter, setSelectedStoreFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [copyingKey, setCopyingKey] = useState<string | null>(null);
  const [hasCopiedOAuthLink, setHasCopiedOAuthLink] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncingStoreId, setSyncingStoreId] = useState<string | null>(null);
  const [autoGrouping, setAutoGrouping] = useState(false);
  const [assigningAccountId, setAssigningAccountId] = useState<string | null>(null);
  const [openAddChannelMenuStoreId, setOpenAddChannelMenuStoreId] = useState<string | null>(null);

  const [storeModal, setStoreModal] = useState<StoreModalDraft | null>(null);
  const [savingStore, setSavingStore] = useState(false);

  const [metaModalOpen, setMetaModalOpen] = useState(false);
  const [metaToken, setMetaToken] = useState('');
  const [metaPageIds, setMetaPageIds] = useState('');
  const [metaTargetStoreId, setMetaTargetStoreId] = useState<string>('AUTO');
  const [syncingMetaToken, setSyncingMetaToken] = useState(false);

  const [callbackModalOpen, setCallbackModalOpen] = useState(false);
  const [callbackUrlInput, setCallbackUrlInput] = useState('');
  const [completingCallback, setCompletingCallback] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const reloadTimerRef = useRef<number | null>(null);

  async function loadAccounts(
    workspaceId: string,
    options?: { silent?: boolean; useCache?: boolean },
  ) {
    const cachedAccounts = queryClient.getQueryData<{ items: SocialAccountView[] }>(
      workspaceQueryKeys.socialAccounts(workspaceId),
    );
    const cachedStores = queryClient.getQueryData<{ items: StoreView[] }>(
      workspaceQueryKeys.stores(workspaceId),
    );
    const hasWarmData = Boolean(cachedAccounts && cachedStores);

    if (cachedAccounts) setAccounts(cachedAccounts.items);
    if (cachedStores) setStores(cachedStores.items);

    const shouldBlockUi = !options?.silent && !hasWarmData;
    if (shouldBlockUi) setLoading(true);
    setError(null);
    try {
      const staleTime = options?.useCache ? SHARED_META_STALE_TIME : 0;
      const [accountsResult, storesResult] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: workspaceQueryKeys.socialAccounts(workspaceId),
          queryFn: () => socialAccountsApi.list(workspaceId),
          staleTime,
        }),
        queryClient.fetchQuery({
          queryKey: workspaceQueryKeys.stores(workspaceId),
          queryFn: () => storesApi.list(workspaceId),
          staleTime,
        }),
      ]);
      setAccounts(accountsResult.items);
      setStores(storesResult.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      if (shouldBlockUi) setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    const key = workspaceQueryKeys.socialAccounts(workspace.id);
    if (queryClient.getQueryData(key) !== undefined) {
      queryClient.setQueryData(key, { items: accounts });
    }
  }, [accounts, queryClient, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const key = workspaceQueryKeys.stores(workspace.id);
    if (queryClient.getQueryData(key) !== undefined) {
      queryClient.setQueryData(key, { items: stores });
    }
  }, [queryClient, stores, workspace]);

  useEffect(() => {
    if (!workspace) return;
    void loadAccounts(workspace.id, { useCache: true });
    return () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, [workspace]);

  useWorkspaceEventSubscription((event) => {
    if (!workspace) return;
    if (
      event.type === 'accounts.changed' ||
      event.type === 'stream.reconnected' ||
      (event.type === 'posts.changed' && event.queueName === 'sync-external-posts')
    ) {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void loadAccounts(workspace.id, { silent: true });
      }, 400);
    }
  });

  useEffect(() => {
    if (!workspace || !hasCopiedOAuthLink) return;
    function handleWindowFocus() {
      if (workspace) {
        void loadAccounts(workspace.id);
      }
    }
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [hasCopiedOAuthLink, workspace]);

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

  if (!workspace) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-950">Stores & Social Accounts</h1>
        <p className="mt-2 text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>
      </section>
    );
  }

  const canConnect = hasPermission(workspace.role, 'social_account:connect');
  const canDisconnect = hasPermission(workspace.role, 'social_account:disconnect');
  const totalUnassignedCount = accounts.filter((item) => !item.storeId).length;

  async function connectOAuth(platform: Platform, storeId?: string) {
    if (!workspace) return;
    const key = `${storeId ?? 'GLOBAL'}:${platform}`;
    setConnectingKey(key);
    setOpenAddChannelMenuStoreId(null);
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
      setOpenAddChannelMenuStoreId(null);
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
      await loadAccounts(workspace.id);
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
    if (!window.confirm('Bạn có chắc muốn ngắt kết nối kênh này?')) return;
    setError(null);
    try {
      await socialAccountsApi.disconnect(workspace.id, accountId);
      await loadAccounts(workspace.id);
      toast.success('Đã ngắt kết nối tài khoản.');
    } catch (disconnectError) {
      toast.error(getErrorMessage(disconnectError));
    }
  }

  async function testConnection(accountId: string) {
    if (!workspace) return;
    setTesting(accountId);
    setError(null);
    try {
      const result = await socialAccountsApi.testConnection(workspace.id, accountId);
      toast.success(`Kết nối OK: ${result.profile.name}`);
      await loadAccounts(workspace.id);
    } catch (testError) {
      toast.error(getErrorMessage(testError));
    } finally {
      setTesting(null);
    }
  }

  async function syncPosts(accountId: string) {
    if (!workspace) return;
    setSyncing(accountId);
    setError(null);
    try {
      await socialAccountsApi.syncPosts(workspace.id, accountId);
      toast.success('Đã gửi yêu cầu đồng bộ bài viết vào queue.');
      await loadAccounts(workspace.id);
    } catch (syncError) {
      toast.error(getErrorMessage(syncError));
    } finally {
      setSyncing(null);
    }
  }

  async function syncAllStorePosts(store: StoreView) {
    if (!workspace) return;
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
      await loadAccounts(workspace.id);
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
      await loadAccounts(workspace.id);
      toast.success(`Đã đồng bộ ${result.syncedCount} tài khoản Facebook/Instagram từ Meta Token.`);
    } catch (syncError) {
      toast.error(getErrorMessage(syncError));
    } finally {
      setSyncingMetaToken(false);
    }
  }

  function openCreateStoreModal() {
    const nextColor =
      STORE_COLOR_SWATCHES[stores.length % STORE_COLOR_SWATCHES.length] ?? '#2563eb';
    setStoreModal({
      id: null,
      name: '',
      description: '',
      color: nextColor,
      isDefault: stores.length === 0,
      socialAccountIds: [],
    });
  }

  function openEditStoreModal(store: StoreView) {
    const storeAccountIds = accounts
      .filter((item) => item.storeId === store.id)
      .map((item) => item.id);
    setStoreModal({
      id: store.id,
      name: store.name,
      description: store.description ?? '',
      color: store.color ?? '#2563eb',
      isDefault: store.isDefault,
      socialAccountIds: storeAccountIds,
    });
  }

  async function handleSaveStoreModal() {
    if (!workspace || !storeModal || !storeModal.name.trim()) return;
    setSavingStore(true);
    try {
      if (storeModal.id) {
        const updated = await storesApi.update(workspace.id, storeModal.id, {
          name: storeModal.name.trim(),
          description: storeModal.description.trim() || null,
          color: storeModal.color,
          isDefault: storeModal.isDefault,
          socialAccountIds: storeModal.socialAccountIds,
        });
        toast.success(`Đã cập nhật Store "${updated.name}".`);
      } else {
        const created = await storesApi.create(workspace.id, {
          name: storeModal.name.trim(),
          description: storeModal.description.trim() || null,
          color: storeModal.color,
          isDefault: storeModal.isDefault,
          socialAccountIds: storeModal.socialAccountIds,
        });
        toast.success(`Đã tạo Store "${created.name}".`);
      }
      setStoreModal(null);
      await loadAccounts(workspace.id);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSavingStore(false);
    }
  }

  async function handleDeleteStore(store: StoreView) {
    if (!workspace) return;
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
      await loadAccounts(workspace.id);
      toast.success(`Đã xóa Store "${store.name}".`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleAutoGroupStores() {
    if (!workspace) return;
    setAutoGrouping(true);
    try {
      const result = await storesApi.autoGroup(workspace.id);
      await loadAccounts(workspace.id);
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
      await loadAccounts(workspace.id);
      toast.success('Đã cập nhật Store cho kênh.');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAssigningAccountId(null);
    }
  }

  function renderAccountCard(account: SocialAccountView) {
    return (
      <div
        key={account.id}
        className="flex flex-col justify-between rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 transition hover:border-slate-300 hover:bg-white"
      >
        <div>
          <div className="flex items-start justify-between gap-2">
            <span
              className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold ${
                PLATFORM_BADGE_STYLES[account.platform]
              }`}
            >
              {PLATFORM_LABELS[account.platform]}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                account.status === 'CONNECTED'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  account.status === 'CONNECTED' ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              {account.status}
            </span>
          </div>

          <div className="mt-2.5 flex items-center gap-2.5">
            {account.avatarUrl ? (
              <img
                alt={account.name}
                className="h-9 w-9 shrink-0 rounded-full border border-slate-200 object-cover"
                src={account.avatarUrl}
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">
                {account.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-semibold text-slate-900">{account.name}</p>
                {account.profileUrl ? (
                  <a
                    className="shrink-0 text-slate-400 hover:text-slate-700"
                    href={account.profileUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Mở trang kênh"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>
              <p className="truncate text-xs text-slate-500">
                {account.username
                  ? `@${account.username}`
                  : `ID: ${account.externalAccountId ?? account.id}`}
              </p>
            </div>
          </div>

          <p className="mt-2 truncate text-[11px] text-slate-400">
            {account.lastSyncedAt
              ? `Đồng bộ: ${new Date(account.lastSyncedAt).toLocaleString('vi-VN')}`
              : 'Chưa đồng bộ bài viết'}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 pt-2.5">
          <select
            aria-label={`Chọn Store cho ${account.name}`}
            className="max-w-[155px] truncate rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-slate-900 focus:outline-none disabled:bg-slate-100"
            disabled={!canConnect || assigningAccountId === account.id}
            onChange={(e) => void handleAssignAccountStore(account.id, e.target.value)}
            value={account.storeId ?? ''}
          >
            <option value="">-- Chưa gán Store --</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                Store: {s.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1">
            <button
              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={testing !== null || syncing === account.id}
              onClick={() => void testConnection(account.id)}
              title="Kiểm tra kết nối token"
              type="button"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              {testing === account.id ? '...' : 'Test'}
            </button>
            <button
              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={syncing !== null || testing === account.id}
              onClick={() => void syncPosts(account.id)}
              title="Đồng bộ bài viết từ nền tảng"
              type="button"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${syncing === account.id ? 'animate-spin' : ''}`}
              />
              Sync
            </button>
            {canDisconnect ? (
              <button
                className="inline-flex items-center rounded border border-transparent px-1.5 py-1 text-xs text-rose-600 hover:bg-rose-50"
                onClick={() => void disconnect(account.id)}
                title="Ngắt kết nối kênh"
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Stores & Kênh Mạng Xã Hội</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-800">
              {stores.length} Stores
            </span>
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
              {accounts.length} Kênh đã kết nối
            </span>
            {totalUnassignedCount > 0 ? (
              <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700">
                {totalUnassignedCount} Kênh chưa gán Store
              </span>
            ) : null}
          </div>
        </div>

        {canConnect ? (
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={() => void openCallbackModal()} type="button">
              <CheckCircle2 className="mr-1.5 h-4 w-4 text-emerald-600" />
              Dán Callback Multilogin
            </SecondaryButton>
            <SecondaryButton
              disabled={autoGrouping || accounts.length === 0}
              onClick={() => void handleAutoGroupStores()}
              type="button"
            >
              {autoGrouping ? 'Đang gom...' : '⚡ Tự động gom Store'}
            </SecondaryButton>
            <SecondaryButton onClick={() => setMetaModalOpen(true)} type="button">
              <ShieldCheck className="mr-1.5 h-4 w-4 text-blue-600" />
              Đồng bộ Meta Token
            </SecondaryButton>
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

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
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
              const count = accounts.filter((a) => a.storeId === store.id).length;
              return (
                <button
                  key={store.id}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
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
                </button>
              );
            })}
            <button
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                selectedStoreFilter === 'UNASSIGNED'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-amber-50/70 text-amber-800 hover:bg-amber-100/70'
              }`}
              onClick={() => setSelectedStoreFilter('UNASSIGNED')}
              type="button"
            >
              Chưa gán Store ({totalUnassignedCount})
            </button>
          </div>

          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-9 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm tên kênh, @username, Store..."
              type="text"
              value={searchQuery}
            />
          </div>
        </div>
      </section>

      {selectedStoreFilter !== 'UNASSIGNED' ? (
        <div className="space-y-4">
          {visibleStores.map((store) => {
            const storeAccounts = accounts.filter(
              (item) => item.storeId === store.id && matchesAccountSearch(item, store.name),
            );
            const isMenuOpen = openAddChannelMenuStoreId === store.id;

            return (
              <section
                key={store.id}
                className="overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm"
                style={{ borderLeftWidth: '5px', borderLeftColor: store.color ?? '#2563eb' }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="h-3.5 w-3.5 rounded-full"
                      style={{ backgroundColor: store.color ?? '#2563eb' }}
                    />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-bold text-slate-950">{store.name}</h2>
                        {store.isDefault ? (
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                            Mặc định
                          </span>
                        ) : null}
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                          {storeAccounts.length} kênh
                        </span>
                      </div>
                      {store.description ? (
                        <p className="mt-0.5 text-xs text-slate-500">{store.description}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {storeAccounts.length > 0 ? (
                      <button
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={syncingStoreId === store.id}
                        onClick={() => void syncAllStorePosts(store)}
                        type="button"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${
                            syncingStoreId === store.id ? 'animate-spin' : ''
                          }`}
                        />
                        Đồng bộ bài cả Store
                      </button>
                    ) : null}

                    {canConnect ? (
                      <div className="relative">
                        <button
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                          onClick={() => setOpenAddChannelMenuStoreId(isMenuOpen ? null : store.id)}
                          type="button"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Thêm kênh
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>

                        {isMenuOpen ? (
                          <div className="absolute right-0 z-20 mt-1.5 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
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
                              onClick={() => {
                                setOpenAddChannelMenuStoreId(null);
                                openEditStoreModal(store);
                              }}
                              type="button"
                            >
                              Chọn từ các kênh đã kết nối...
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {canConnect ? (
                      <>
                        <button
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          onClick={() => openEditStoreModal(store)}
                          title="Sửa tên, màu và chọn kênh cho Store"
                          type="button"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Sửa
                        </button>
                        <button
                          className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-1.5 text-xs text-rose-600 hover:bg-rose-50"
                          onClick={() => void handleDeleteStore(store)}
                          title={`Xóa Store ${store.name}`}
                          type="button"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                <div className="p-5">
                  {storeAccounts.length > 0 ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {storeAccounts.map((account) => renderAccountCard(account))}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/50 px-4 py-4">
                      <p className="text-xs text-slate-500">
                        Store <strong>{store.name}</strong> chưa có kênh nào. Bấm{' '}
                        <strong>+ Thêm kênh</strong> để kết nối OAuth hoặc chọn từ các kênh có sẵn.
                      </p>
                      {canConnect ? (
                        <button
                          className="text-xs font-semibold text-brand-700 hover:underline"
                          onClick={() => openEditStoreModal(store)}
                          type="button"
                        >
                          Gán kênh có sẵn vào {store.name} →
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
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
                Tạo Store (VD: PreAureum, Wrydeco, ChillGen Rugs...) hoặc bấm &ldquo;Tự động gom
                Store&rdquo; để gom các Facebook Page và Instagram theo từng thương hiệu.
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-100 bg-amber-50/60 px-5 py-4">
            <div>
              <h2 className="text-base font-bold text-slate-950">
                Kênh chưa gán Store ({unassignedAccounts.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-600">
                Các kênh này chưa thuộc Store nào. Chọn Store ở góc dưới mỗi thẻ hoặc bấm{' '}
                <strong>⚡ Tự động gom Store</strong>.
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
                          : `+ ${PLATFORM_LABELS[platform]}`}
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

          <div className="p-5">
            {unassignedAccounts.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {unassignedAccounts.map((account) => renderAccountCard(account))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Tất cả các kênh đã được gán vào Store đầy đủ.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {storeModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-lg font-bold text-slate-950">
                {storeModal.id ? 'Chỉnh sửa Store / Brand' : 'Tạo Store / Brand mới'}
              </h2>
              <button
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setStoreModal(null)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Tên Store / Thương hiệu *
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  onChange={(e) =>
                    setStoreModal((curr) => (curr ? { ...curr, name: e.target.value } : null))
                  }
                  placeholder="VD: PreAureum, Wrydeco, ChillGen Rugs..."
                  type="text"
                  value={storeModal.name}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Mô tả ngắn (tùy chọn)
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                  onChange={(e) =>
                    setStoreModal((curr) =>
                      curr ? { ...curr, description: e.target.value } : null,
                    )
                  }
                  placeholder="VD: Trang sức bạc PreAureum US"
                  type="text"
                  value={storeModal.description}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Màu nhận diện Store
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {STORE_COLOR_SWATCHES.map((swatch) => (
                    <button
                      key={swatch}
                      aria-label={`Chọn màu ${swatch}`}
                      className={`h-7 w-7 rounded-full border-2 transition ${
                        storeModal.color === swatch
                          ? 'scale-110 border-slate-950 ring-2 ring-slate-300'
                          : 'border-transparent hover:scale-105'
                      }`}
                      onClick={() =>
                        setStoreModal((curr) => (curr ? { ...curr, color: swatch } : null))
                      }
                      style={{ backgroundColor: swatch }}
                      type="button"
                    />
                  ))}
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  checked={storeModal.isDefault}
                  className="rounded border-slate-300"
                  onChange={(e) =>
                    setStoreModal((curr) =>
                      curr ? { ...curr, isDefault: e.target.checked } : null,
                    )
                  }
                  type="checkbox"
                />
                Đặt làm Store mặc định khi mở trang Tạo bài đăng
              </label>

              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-700">
                    Chọn các kênh thuộc Store này ({storeModal.socialAccountIds.length} đã chọn)
                  </label>
                </div>
                <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 p-2.5">
                  {accounts.map((account) => {
                    const checked = storeModal.socialAccountIds.includes(account.id);
                    const otherStore =
                      account.store && account.store.id !== storeModal.id ? account.store : null;
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
                              setStoreModal((curr) => {
                                if (!curr) return null;
                                const exists = curr.socialAccountIds.includes(account.id);
                                return {
                                  ...curr,
                                  socialAccountIds: exists
                                    ? curr.socialAccountIds.filter((id) => id !== account.id)
                                    : [...curr.socialAccountIds, account.id],
                                };
                              })
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
                  {accounts.length === 0 ? (
                    <p className="py-3 text-center text-xs text-slate-500">
                      Chưa có kênh nào đã kết nối.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <SecondaryButton onClick={() => setStoreModal(null)} type="button">
                Hủy
              </SecondaryButton>
              <PrimaryButton
                busy={savingStore}
                disabled={!storeModal.name.trim() || savingStore}
                onClick={() => void handleSaveStoreModal()}
                type="button"
              >
                {storeModal.id ? 'Lưu thay đổi' : 'Tạo Store'}
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
                  quét toàn bộ Facebook Pages & Instagram Business.
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
                    ⚡ Tự động tạo & ghép cặp Store (FB + IG) theo tên từng Page
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
