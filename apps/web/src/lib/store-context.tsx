'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { StoreSettingsModal, type StoreSettingsTab } from '@/components/store-settings-modal';
import { socialAccountsApi, storesApi } from './api-client';
import type { SocialAccountView, StoreView } from './types';
import { SHARED_META_STALE_TIME, workspaceQueryKeys } from './workspace-queries';

interface StoreContextValue {
  stores: StoreView[];
  accounts: SocialAccountView[];
  activeStoreAccounts: SocialAccountView[];
  unassignedAccounts: SocialAccountView[];
  activeStore: StoreView | null;
  activeStoreId: string | null;
  loading: boolean;
  setActiveStoreId: (storeId: string) => void;
  refreshStores: () => Promise<void>;
  openCreateStoreModal: () => void;
  openStoreSettingsModal: (store?: StoreView | null, initialTab?: StoreSettingsTab) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

function sessionStoreKey(workspaceId: string): string {
  return `socialhub.activeStore.${workspaceId}`;
}

function localLastStoreKey(workspaceId: string): string {
  return `socialhub.lastActiveStore.${workspaceId}`;
}

function readTabStoredId(workspaceId: string | null): string | null {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(sessionStoreKey(workspaceId));
  } catch {
    return null;
  }
}

function readLastUsedStoreId(workspaceId: string | null): string | null {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(localLastStoreKey(workspaceId));
  } catch {
    return null;
  }
}

function writeTabStoredId(workspaceId: string, storeId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(sessionStoreKey(workspaceId), storeId);
  } catch {
    // ignore storage quota errors
  }
}

function writeLastUsedStoreId(workspaceId: string, storeId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(localLastStoreKey(workspaceId), storeId);
  } catch {
    // ignore storage quota errors
  }
}

export function StoreContextProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(() =>
    readTabStoredId(workspaceId),
  );
  const [modalState, setModalState] = useState<{
    open: boolean;
    store: StoreView | null;
    initialTab: StoreSettingsTab;
  }>({
    open: false,
    store: null,
    initialTab: 'general',
  });

  useEffect(() => {
    setSelectedStoreId(readTabStoredId(workspaceId));
  }, [workspaceId]);

  const storesQuery = useQuery({
    queryKey: workspaceQueryKeys.stores(workspaceId ?? 'none'),
    queryFn: () => storesApi.list(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    staleTime: SHARED_META_STALE_TIME,
  });

  const accountsQuery = useQuery({
    queryKey: workspaceQueryKeys.socialAccounts(workspaceId ?? 'none'),
    queryFn: () => socialAccountsApi.list(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    staleTime: SHARED_META_STALE_TIME,
  });

  const stores = useMemo(() => storesQuery.data?.items ?? [], [storesQuery.data]);
  const accounts = useMemo(() => accountsQuery.data?.items ?? [], [accountsQuery.data]);

  const resolvedActiveStore = useMemo<StoreView | null>(() => {
    if (stores.length === 0) return null;

    if (selectedStoreId) {
      const fromTab = stores.find((item) => item.id === selectedStoreId);
      if (fromTab) return fromTab;
    }

    const lastUsed = readLastUsedStoreId(workspaceId);
    if (lastUsed) {
      const fromLastUsed = stores.find((item) => item.id === lastUsed);
      if (fromLastUsed) return fromLastUsed;
    }

    return stores.find((item) => item.isDefault) ?? stores[0] ?? null;
  }, [selectedStoreId, stores, workspaceId]);

  const activeStoreId = resolvedActiveStore?.id ?? null;

  useEffect(() => {
    if (!workspaceId || !activeStoreId) return;
    if (selectedStoreId !== activeStoreId) {
      setSelectedStoreId(activeStoreId);
    }
    writeTabStoredId(workspaceId, activeStoreId);
  }, [activeStoreId, selectedStoreId, workspaceId]);

  const setActiveStoreId = useCallback(
    (storeId: string) => {
      setSelectedStoreId(storeId);
      if (workspaceId) {
        writeTabStoredId(workspaceId, storeId);
        writeLastUsedStoreId(workspaceId, storeId);
      }
    },
    [workspaceId],
  );

  const refreshStores = useCallback(async () => {
    if (!workspaceId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.stores(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.socialAccounts(workspaceId) }),
    ]);
  }, [queryClient, workspaceId]);

  const openCreateStoreModal = useCallback(() => {
    setModalState({
      open: true,
      store: null,
      initialTab: 'general',
    });
  }, []);

  const openStoreSettingsModal = useCallback(
    (store?: StoreView | null, initialTab: StoreSettingsTab = 'general') => {
      setModalState({
        open: true,
        store: store === undefined ? resolvedActiveStore : store,
        initialTab,
      });
    },
    [resolvedActiveStore],
  );

  const activeStoreAccounts = useMemo(
    () => (activeStoreId ? accounts.filter((account) => account.storeId === activeStoreId) : []),
    [accounts, activeStoreId],
  );

  const unassignedAccounts = useMemo(
    () => accounts.filter((account) => !account.storeId),
    [accounts],
  );

  const value = useMemo<StoreContextValue>(
    () => ({
      stores,
      accounts,
      activeStoreAccounts,
      unassignedAccounts,
      activeStore: resolvedActiveStore,
      activeStoreId,
      loading: Boolean(workspaceId) && (storesQuery.isLoading || accountsQuery.isLoading),
      setActiveStoreId,
      refreshStores,
      openCreateStoreModal,
      openStoreSettingsModal,
    }),
    [
      accounts,
      accountsQuery.isLoading,
      activeStoreAccounts,
      activeStoreId,
      openCreateStoreModal,
      openStoreSettingsModal,
      refreshStores,
      resolvedActiveStore,
      setActiveStoreId,
      stores,
      storesQuery.isLoading,
      unassignedAccounts,
      workspaceId,
    ],
  );

  return (
    <StoreContext.Provider value={value}>
      {children}
      {modalState.open && workspaceId ? (
        <StoreSettingsModal
          workspaceId={workspaceId}
          store={modalState.store}
          accounts={accounts}
          defaultColorIndex={stores.length}
          isFirstStore={stores.length === 0}
          initialTab={modalState.initialTab}
          onClose={() => setModalState((prev) => ({ ...prev, open: false }))}
          onSaved={async (updatedStore) => {
            await refreshStores();
            if (!modalState.store && updatedStore?.id) {
              setActiveStoreId(updatedStore.id);
            }
          }}
        />
      ) : null}
    </StoreContext.Provider>
  );
}

export function useActiveStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error('useActiveStore must be used within StoreContextProvider');
  }
  return ctx;
}
