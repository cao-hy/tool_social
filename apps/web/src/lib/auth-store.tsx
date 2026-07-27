'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { authApi } from './api-client';
import type { AuthPayload, UserView, WorkspaceSummary } from './types';

interface AuthState {
  user: UserView | null;
  workspaces: WorkspaceSummary[];
  loading: boolean;
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceSummary | null;
  setActiveWorkspaceId: (workspaceId: string) => void;
  refresh: () => Promise<void>;
  applyAuthPayload: (payload: AuthPayload) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = 'socialhub.activeWorkspaceId';
const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<UserView | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

  const chooseWorkspace = useCallback((items: WorkspaceSummary[], preferred: string | null) => {
    const next = items.find((workspace) => workspace.id === preferred) ?? items[0] ?? null;
    setActiveWorkspaceIdState(next?.id ?? null);
    if (next) window.localStorage.setItem(STORAGE_KEY, next.id);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const applyAuthPayload = useCallback(
    (payload: AuthPayload) => {
      setUser(payload.user);
      setWorkspaces(payload.workspaces);
      chooseWorkspace(payload.workspaces, window.localStorage.getItem(STORAGE_KEY));
    },
    [chooseWorkspace],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await authApi.me();
      applyAuthPayload(payload);
    } catch {
      setUser(null);
      setWorkspaces([]);
      setActiveWorkspaceIdState(null);
    } finally {
      setLoading(false);
    }
  }, [applyAuthPayload]);

  useEffect(() => {
    if (AUTH_ROUTES.some((route) => pathname.startsWith(route))) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [pathname, refresh]);

  const setActiveWorkspaceId = useCallback(
    (workspaceId: string) => {
      chooseWorkspace(workspaces, workspaceId);
    },
    [chooseWorkspace, workspaces],
  );

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspaceIdState(null);
    window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const value = useMemo(
    () => ({
      user,
      workspaces,
      loading,
      activeWorkspaceId,
      activeWorkspace,
      setActiveWorkspaceId,
      refresh,
      applyAuthPayload,
      logout,
    }),
    [
      user,
      workspaces,
      loading,
      activeWorkspaceId,
      activeWorkspace,
      setActiveWorkspaceId,
      refresh,
      applyAuthPayload,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
