'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { AUTH_UNAUTHORIZED_EVENT, authApi } from './api-client';
import type { AuthPayload, UserView, WorkspaceSummary } from './types';

interface AuthState {
  user: UserView | null;
  workspaces: WorkspaceSummary[];
  loading: boolean;
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceSummary | null;
  setActiveWorkspaceId: (workspaceId: string) => void;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  applyAuthPayload: (payload: AuthPayload) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = 'socialhub.activeWorkspaceId';
const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password'] as const;
const PUBLIC_ROUTES = [
  '/',
  '/features',
  '/how-it-works',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
] as const;

function isPublicOrAuthPath(pathname: string): boolean {
  return (
    AUTH_ROUTES.some((route) => pathname.startsWith(route)) ||
    PUBLIC_ROUTES.some((route) => pathname === route)
  );
}

function isSameWorkspaceSummary(a: WorkspaceSummary, b: WorkspaceSummary): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.slug === b.slug &&
    a.role === b.role &&
    a.timezone === b.timezone
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<UserView | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

  const userRef = useRef<UserView | null>(null);
  userRef.current = user;
  const inflightRefreshRef = useRef<Promise<void> | null>(null);

  const chooseWorkspace = useCallback((items: WorkspaceSummary[], preferred: string | null) => {
    const next = items.find((workspace) => workspace.id === preferred) ?? items[0] ?? null;
    const nextId = next?.id ?? null;
    setActiveWorkspaceIdState((prev) => (prev === nextId ? prev : nextId));
    if (next) window.localStorage.setItem(STORAGE_KEY, next.id);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const applyAuthPayload = useCallback(
    (payload: AuthPayload) => {
      if (userRef.current && userRef.current.id !== payload.user.id) {
        queryClient.clear();
      }
      userRef.current = payload.user;
      setUser((prev) =>
        prev &&
        prev.id === payload.user.id &&
        prev.email === payload.user.email &&
        prev.name === payload.user.name
          ? prev
          : payload.user,
      );
      setWorkspaces((prev) => {
        if (
          prev.length === payload.workspaces.length &&
          prev.every((item, idx) => {
            const incoming = payload.workspaces[idx];
            return incoming ? isSameWorkspaceSummary(item, incoming) : false;
          })
        ) {
          return prev;
        }
        return payload.workspaces;
      });
      chooseWorkspace(payload.workspaces, window.localStorage.getItem(STORAGE_KEY));
      setBootstrapped(true);
      setLoading(false);
    },
    [chooseWorkspace, queryClient],
  );

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (inflightRefreshRef.current) {
        return inflightRefreshRef.current;
      }

      const shouldShowBlockingLoader = !options?.silent && !userRef.current;
      if (shouldShowBlockingLoader) {
        setLoading(true);
      }

      const task = (async () => {
        try {
          const payload = await authApi.me();
          applyAuthPayload(payload);
        } catch {
          userRef.current = null;
          setUser(null);
          setWorkspaces([]);
          setActiveWorkspaceIdState(null);
          queryClient.clear();
        } finally {
          setBootstrapped(true);
          setLoading(false);
          inflightRefreshRef.current = null;
        }
      })();

      inflightRefreshRef.current = task;
      return task;
    },
    [applyAuthPayload, queryClient],
  );

  const isPublicRoute = isPublicOrAuthPath(pathname);

  useEffect(() => {
    if (isPublicRoute || bootstrapped) {
      return;
    }
    void refresh();
  }, [bootstrapped, isPublicRoute, refresh]);

  useEffect(() => {
    function handleUnauthorized() {
      userRef.current = null;
      setUser(null);
      setWorkspaces([]);
      setActiveWorkspaceIdState(null);
      setBootstrapped(true);
      setLoading(false);
      queryClient.clear();
    }

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    };
  }, [queryClient]);

  const setActiveWorkspaceId = useCallback(
    (workspaceId: string) => {
      chooseWorkspace(workspaces, workspaceId);
    },
    [chooseWorkspace, workspaces],
  );

  const logout = useCallback(async () => {
    await authApi.logout();
    userRef.current = null;
    setUser(null);
    setWorkspaces([]);
    setActiveWorkspaceIdState(null);
    setBootstrapped(true);
    setLoading(false);
    window.localStorage.removeItem(STORAGE_KEY);
    queryClient.clear();
  }, [queryClient]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const effectiveLoading = loading || (!isPublicRoute && !bootstrapped && !user);

  const value = useMemo(
    () => ({
      user,
      workspaces,
      loading: effectiveLoading,
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
      effectiveLoading,
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
