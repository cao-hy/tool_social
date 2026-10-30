'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useRef, type ReactNode } from 'react';
import {
  BarChart2,
  Bell,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  Clock,
  FileText,
  Globe2,
  LayoutDashboard,
  Link2,
  LogOut,
  MessageSquare,
  PenSquare,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Store as StoreIcon,
  Users,
  X,
} from 'lucide-react';
import { isAvailable, NAV_ITEMS } from '@/lib/navigation';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  notificationBodyText,
  notificationDisplayMeta,
  platformBadgeClass,
} from '@/lib/notification-format';
import { StoreContextProvider, useActiveStore } from '@/lib/store-context';
import type { NotificationView } from '@/lib/types';
import {
  prefetchWorkspaceSharedMeta,
  prefetchWorkspaceTabData,
  workspaceQueryKeys,
} from '@/lib/workspace-queries';
import { useToast } from './toast-provider';

const ICONS: Record<string, React.ElementType> = {
  '/dashboard': LayoutDashboard,
  '/calendar': Calendar,
  '/posts/new': PenSquare,
  '/posts': FileText,
  '/inbox': MessageSquare,
  '/analytics': BarChart2,
  '/accounts': Link2,
  '/team': Users,
  '/notifications': Bell,
  '/settings': Settings,
};
const LOGO_PATH = '/logo_b6.png';

function resolveCurrentPageLabel(pathname: string): string {
  const exact = NAV_ITEMS.find((item) => item.href === pathname);
  if (exact) return exact.label;
  if (pathname.startsWith('/posts/') && pathname.endsWith('/edit')) {
    return 'Chỉnh sửa bài viết';
  }
  if (pathname.startsWith('/posts/')) {
    return 'Chi tiết bài viết';
  }
  return 'Tổng quan';
}
import { NotificationToasts } from './notification-toasts';
import {
  JobActivityHeaderControl,
  JobActivityProvider,
  JobActivityTransientBar,
} from './job-activity-panel';
import { RoleBadge } from './role-badge';
import {
  useWorkspaceEventSubscription,
  WorkspaceEventsProvider,
} from './workspace-events-provider';

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return (
    <WorkspaceEventsProvider workspaceId={auth.activeWorkspaceId}>
      <StoreContextProvider workspaceId={auth.activeWorkspaceId}>
        <AppShellInner>{children}</AppShellInner>
      </StoreContextProvider>
    </WorkspaceEventsProvider>
  );
}

function isWorkspaceGlobalRoute(pathname: string): boolean {
  return (
    pathname === '/analytics' ||
    pathname === '/accounts' ||
    pathname === '/team' ||
    pathname === '/settings' ||
    pathname === '/notifications'
  );
}

function AppShellInner({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const storeCtx = useActiveStore();
  const queryClient = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
  const [isStoreMenuOpen, setIsStoreMenuOpen] = useState(false);
  const [isHeaderStoreMenuOpen, setIsHeaderStoreMenuOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notificationItems, setNotificationItems] = useState<NotificationView[]>([]);
  const [notificationsUnreadOnly, setNotificationsUnreadOnly] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsUpdating, setNotificationsUpdating] = useState<string | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isHeaderHidden, setIsHeaderHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  useEffect(() => {
    if (!auth.loading && !auth.user) router.replace('/login');
  }, [auth.loading, auth.user, router]);

  useEffect(() => {
    if (!auth.activeWorkspaceId) return;
    const workspaceId = auth.activeWorkspaceId;
    const timer = window.setTimeout(() => {
      prefetchWorkspaceSharedMeta(queryClient, workspaceId);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [auth.activeWorkspaceId, queryClient]);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY > lastScrollY.current && currentScrollY > 50) {
        setIsHeaderHidden(true);
      } else {
        setIsHeaderHidden(false);
      }
      lastScrollY.current = currentScrollY;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const fetchUnreadCount = async (workspaceId: string) => {
    try {
      const res = await notificationsApi.list(workspaceId, {
        unreadOnly: true,
        limit: 99,
      });
      setUnreadCount(res.items.length);
    } catch (e) {
      console.error('Failed to fetch unread notifications', e);
    }
  };

  useWorkspaceEventSubscription((event) => {
    if (!auth.activeWorkspaceId) return;
    const workspaceId = auth.activeWorkspaceId;

    if (
      event.type === 'notification.created' ||
      event.type === 'notifications.changed' ||
      event.type === 'stream.reconnected'
    ) {
      if (isNotificationsOpen) {
        void loadNotifications({ silent: true });
      } else {
        void fetchUnreadCount(workspaceId);
      }
    }

    if (
      event.type === 'posts.changed' ||
      event.type === 'comment.created' ||
      event.type === 'comment.replied' ||
      event.type === 'comments.synced'
    ) {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.postsRoot(workspaceId) });
    }

    if (event.type === 'metrics.synced') {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.analyticsRoot(workspaceId),
      });
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.postsRoot(workspaceId) });
    }

    if (event.type === 'accounts.changed') {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.socialAccounts(workspaceId),
      });
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.stores(workspaceId) });
    }

    if (event.type === 'media.updated') {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.mediaRoot(workspaceId) });
    }

    if (event.type === 'stream.reconnected') {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all(workspaceId) });
    }
  });

  useEffect(() => {
    if (!auth.activeWorkspaceId) return;
    const workspaceId = auth.activeWorkspaceId;
    void fetchUnreadCount(workspaceId);
    const interval = setInterval(() => void fetchUnreadCount(workspaceId), 60000);
    return () => clearInterval(interval);
  }, [auth.activeWorkspaceId]);

  async function loadNotifications(options?: { silent?: boolean }) {
    if (!auth.activeWorkspaceId) return;
    if (!options?.silent) setNotificationsLoading(true);
    setNotificationsError(null);
    try {
      const [listResult, unreadResult] = await Promise.all([
        notificationsApi.list(auth.activeWorkspaceId, {
          unreadOnly: notificationsUnreadOnly,
          limit: 12,
        }),
        notificationsApi.list(auth.activeWorkspaceId, {
          unreadOnly: true,
          limit: 99,
        }),
      ]);
      setNotificationItems(listResult.items);
      setUnreadCount(unreadResult.items.length);
    } catch (loadError) {
      setNotificationsError(getErrorMessage(loadError));
    } finally {
      if (!options?.silent) setNotificationsLoading(false);
    }
  }

  useEffect(() => {
    if (!isNotificationsOpen || !auth.activeWorkspaceId) return;
    void loadNotifications();
  }, [auth.activeWorkspaceId, isNotificationsOpen, notificationsUnreadOnly]);

  async function markNotificationRead(notificationId: string) {
    if (!auth.activeWorkspaceId) return;
    setNotificationsUpdating(notificationId);
    try {
      await notificationsApi.markRead(auth.activeWorkspaceId, notificationId);
      await loadNotifications({ silent: true });
    } catch (updateError) {
      toast.error(getErrorMessage(updateError));
    } finally {
      setNotificationsUpdating(null);
    }
  }

  async function markAllNotificationsRead() {
    if (!auth.activeWorkspaceId) return;
    setNotificationsUpdating('all');
    try {
      await notificationsApi.markAllRead(auth.activeWorkspaceId);
      await loadNotifications({ silent: true });
      toast.success('Đã đánh dấu tất cả notification là đã đọc.');
    } catch (updateError) {
      toast.error(getErrorMessage(updateError));
    } finally {
      setNotificationsUpdating(null);
    }
  }

  async function handleLogout() {
    try {
      await auth.logout();
      router.replace('/login');
    } catch (logoutError) {
      toast.error(getErrorMessage(logoutError));
    }
  }

  if (auth.loading) {
    return (
      <main className="grid min-h-screen place-items-center px-6 text-sm text-slate-600">
        Đang kiểm tra phiên đăng nhập...
      </main>
    );
  }

  if (!auth.user) return null;

  const navItems = NAV_ITEMS.filter(
    (item) => item.href !== '/notifications' && item.href !== '/settings',
  );

  return (
    <JobActivityProvider workspaceId={auth.activeWorkspaceId} isSidebarCollapsed={isCollapsed}>
      <div
        className={`min-h-screen transition-all duration-300 lg:grid ${
          isCollapsed ? 'lg:grid-cols-[80px_1fr]' : 'lg:grid-cols-[280px_1fr]'
        }`}
      >
        <aside
          className={`sticky top-0 flex h-screen flex-col border-r border-slate-200 bg-white py-5 ${
            isCollapsed ? 'items-center px-3' : 'px-5'
          }`}
        >
          <div
            className={`mb-6 shrink-0 ${
              isCollapsed ? 'text-center' : 'flex items-center justify-between'
            }`}
          >
            {!isCollapsed && (
              <div className="min-w-0">
                <img
                  src={LOGO_PATH}
                  alt="b6-teams logo"
                  className="h-9 w-36 object-cover object-center"
                />
              </div>
            )}
            {isCollapsed && (
              <div className="mx-auto flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
                <img src={LOGO_PATH} alt="b6-teams logo" className="h-10 w-10 object-cover" />
              </div>
            )}
          </div>

          <div className="relative mb-2.5 shrink-0">
            {!isCollapsed ? (
              <button
                type="button"
                onClick={() => {
                  setIsStoreMenuOpen(false);
                  setIsWorkspaceMenuOpen(!isWorkspaceMenuOpen);
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-xs font-bold text-brand-700 ring-1 ring-inset ring-brand-200/70">
                  {auth.activeWorkspace?.name?.charAt(0).toUpperCase() ?? 'W'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-slate-900">
                    {auth.activeWorkspace?.name ?? 'Chưa có workspace'}
                  </p>
                  <p className="truncate text-[11px] font-medium capitalize text-slate-500">
                    {auth.activeWorkspace
                      ? auth.activeWorkspace.role.toLowerCase()
                      : 'Tài khoản cá nhân'}
                  </p>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              </button>
            ) : (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    setIsStoreMenuOpen(false);
                    setIsWorkspaceMenuOpen(!isWorkspaceMenuOpen);
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 font-bold text-brand-700 ring-1 ring-inset ring-brand-200/70 transition hover:bg-brand-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  title={auth.activeWorkspace?.name ?? 'Workspace'}
                >
                  {auth.activeWorkspace?.name?.charAt(0).toUpperCase() ?? 'W'}
                </button>
              </div>
            )}

            {/* Unified Workspace & User Menu Popup */}
            {isWorkspaceMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsWorkspaceMenuOpen(false)} />
                <div
                  className={`absolute z-50 w-68 rounded-lg border border-slate-200 bg-white p-2 shadow-xl ${
                    isCollapsed
                      ? 'left-full top-0 ml-3'
                      : 'left-0 top-full mt-1.5 w-full min-w-[256px]'
                  }`}
                >
                  <div className="mb-2 rounded-md bg-slate-50 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-slate-900">
                        {auth.user.name || 'Tài khoản đang đăng nhập'}
                      </span>
                      {auth.activeWorkspace ? <RoleBadge role={auth.activeWorkspace.role} /> : null}
                    </div>
                    <p className="mt-1 break-all text-xs text-slate-500">{auth.user.email}</p>
                  </div>

                  {auth.workspaces.length > 0 && (
                    <>
                      <div className="mb-1.5 px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        Chọn Workspace
                      </div>
                      <div className="space-y-1">
                        {auth.workspaces.map((workspace) => {
                          const isSelected = workspace.id === auth.activeWorkspaceId;
                          return (
                            <button
                              key={workspace.id}
                              type="button"
                              onClick={() => {
                                auth.setActiveWorkspaceId(workspace.id);
                                setIsWorkspaceMenuOpen(false);
                              }}
                              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ${
                                isSelected
                                  ? 'bg-brand-50 font-medium text-brand-700'
                                  : 'text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="truncate">{workspace.name}</div>
                                <div className="text-xs capitalize opacity-70">
                                  {workspace.role.toLowerCase()}
                                </div>
                              </div>
                              {isSelected ? (
                                <Check className="h-4 w-4 shrink-0 text-brand-600" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="my-2 border-t border-slate-100" />
                    </>
                  )}
                  <div className="px-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsWorkspaceMenuOpen(false);
                        void handleLogout();
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50"
                    >
                      <LogOut className="h-4 w-4" />
                      Đăng xuất
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {auth.activeWorkspaceId ? (
            <div className="relative mb-5 shrink-0">
              {!isCollapsed ? (
                storeCtx.stores.length === 0 && !storeCtx.loading ? (
                  <button
                    type="button"
                    onClick={() => storeCtx.openCreateStoreModal()}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50/60 px-3 py-2.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Tạo Store đầu tiên
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setIsWorkspaceMenuOpen(false);
                      setIsStoreMenuOpen((prev) => !prev);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-left transition hover:border-brand-300 hover:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white shadow-sm"
                      style={{ backgroundColor: storeCtx.activeStore?.color || '#2563eb' }}
                    >
                      {storeCtx.activeStore?.name?.charAt(0).toUpperCase() ?? 'S'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Store đang chọn
                        </span>
                        {storeCtx.unassignedAccounts.length > 0 ? (
                          <span
                            className="rounded-full bg-amber-100 px-1.5 py-0.2 text-[9px] font-bold text-amber-800"
                            title={`${storeCtx.unassignedAccounts.length} kênh chưa gán Store`}
                          >
                            +{storeCtx.unassignedAccounts.length} chưa gán
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {storeCtx.activeStore?.name ??
                          (storeCtx.loading ? 'Đang tải Store...' : 'Chọn Store')}
                      </p>
                      {storeCtx.activeStore ? (
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                          <span>{storeCtx.activeStore.accountCount} kênh</span>
                          {storeCtx.activeStore.shopify?.connected &&
                          storeCtx.activeStore.shopify.enabled ? (
                            <span className="rounded bg-emerald-50 px-1 font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                              /s/
                            </span>
                          ) : null}
                          {storeCtx.activeStore.proxy?.enabled &&
                          (storeCtx.activeStore.proxy.targets?.length ?? 0) > 0 ? (
                            <span className="rounded bg-indigo-50 px-1 font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200">
                              Proxy ({storeCtx.activeStore.proxy.targets.length})
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />
                  </button>
                )
              ) : (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      setIsWorkspaceMenuOpen(false);
                      if (storeCtx.stores.length === 0 && !storeCtx.loading) {
                        storeCtx.openCreateStoreModal();
                      } else {
                        setIsStoreMenuOpen((prev) => !prev);
                      }
                    }}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shadow-sm ring-2 ring-white transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    style={{ backgroundColor: storeCtx.activeStore?.color || '#2563eb' }}
                    title={
                      storeCtx.activeStore
                        ? `Store đang chọn: ${storeCtx.activeStore.name}`
                        : 'Chọn hoặc tạo Store'
                    }
                  >
                    {storeCtx.activeStore?.name?.charAt(0).toUpperCase() ?? (
                      <StoreIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
              )}

              {isStoreMenuOpen ? (
                <StoreSwitcherMenu
                  isCollapsed={isCollapsed}
                  onClose={() => setIsStoreMenuOpen(false)}
                />
              ) : null}
            </div>
          ) : null}

          <nav
            className={`flex-1 overflow-y-auto space-y-1 ${isCollapsed ? 'scrollbar-hide' : 'pr-1 -mr-1'}`}
          >
            {navItems.map((item) => {
              const available = isAvailable(item);
              const activeHref = pendingHref ?? pathname;
              const active = activeHref === item.href;
              const Icon = ICONS[item.href] || LayoutDashboard;

              if (!available) {
                return (
                  <div
                    key={item.href}
                    className={`flex items-center rounded-md px-3 py-2 text-sm text-slate-400 ${isCollapsed ? 'justify-center' : ''}`}
                    title={`Phase ${item.phase}: ${item.label}`}
                  >
                    <Icon className={`h-5 w-5 ${isCollapsed ? '' : 'mr-3'}`} />
                    {!isCollapsed && (
                      <div>
                        <span className="block font-medium">{item.label}</span>
                        <span className="text-xs">{item.description}</span>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <Link
                  key={item.href}
                  className={`flex items-center rounded-md px-3 py-2 text-sm transition relative ${
                    active
                      ? 'bg-brand-50 font-semibold text-brand-700'
                      : 'text-slate-700 hover:bg-slate-100'
                  } ${isCollapsed ? 'justify-center' : ''}`}
                  href={item.href}
                  title={isCollapsed ? item.label : undefined}
                  onMouseEnter={() => {
                    router.prefetch(item.href);
                    prefetchWorkspaceTabData(
                      queryClient,
                      auth.activeWorkspaceId,
                      item.href,
                      storeCtx.activeStoreId,
                    );
                  }}
                  onFocus={() => {
                    router.prefetch(item.href);
                    prefetchWorkspaceTabData(
                      queryClient,
                      auth.activeWorkspaceId,
                      item.href,
                      storeCtx.activeStoreId,
                    );
                  }}
                  onClick={(event) => {
                    if (
                      !event.defaultPrevented &&
                      event.button === 0 &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.altKey &&
                      pathname !== item.href
                    ) {
                      setPendingHref(item.href);
                    }
                  }}
                >
                  <div className="relative">
                    <Icon className={`h-5 w-5 ${isCollapsed ? '' : 'mr-3'}`} />
                  </div>
                  {!isCollapsed && (
                    <div>
                      <div>
                        <span className="block">{item.label}</span>
                        <span className="text-xs text-slate-500">{item.description}</span>
                      </div>
                    </div>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="mt-6 shrink-0 border-t border-slate-200 pt-4 pb-2">
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className={`flex w-full items-center rounded-md p-2 text-sm text-slate-500 hover:bg-slate-100 transition ${isCollapsed ? 'justify-center' : ''}`}
              title={isCollapsed ? 'Mở rộng menu' : 'Thu gọn menu'}
            >
              {isCollapsed ? (
                <ChevronRight className="h-5 w-5" />
              ) : (
                <>
                  <ChevronLeft className="mr-3 h-5 w-5" />
                  <span className="font-medium">Thu gọn menu</span>
                </>
              )}
            </button>
          </div>
        </aside>

        <main className="min-w-0 bg-slate-50">
          <header
            className={`sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 px-5 py-2.5 shadow-sm backdrop-blur sm:px-8 lg:px-10 transition-transform duration-300 ${isHeaderHidden ? '-translate-y-full' : 'translate-y-0'}`}
          >
            <div className="flex items-center justify-between gap-3">
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
                <span className="hidden truncate font-medium text-slate-500 sm:inline">
                  {auth.activeWorkspace?.name ?? 'Workspace'}
                </span>
                <span className="hidden select-none text-slate-300 sm:inline">/</span>
                <span className="truncate font-semibold text-slate-900">
                  {resolveCurrentPageLabel(pendingHref ?? pathname)}
                </span>

                {auth.activeWorkspaceId ? (
                  isWorkspaceGlobalRoute(pendingHref ?? pathname) ? (
                    <span
                      className="ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
                      title="Trang này hiển thị phạm vi toàn bộ Workspace"
                    >
                      <Globe2 className="h-3.5 w-3.5 text-slate-500" />
                      {(pendingHref ?? pathname) === '/analytics'
                        ? 'Toàn bộ Stores'
                        : 'Cấp Workspace'}
                    </span>
                  ) : storeCtx.activeStore ? (
                    <div className="relative ml-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setIsHeaderStoreMenuOpen((prev) => !prev)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 shadow-xs transition hover:border-brand-300 hover:bg-brand-50/40"
                        title="Đổi nhanh Store đang thao tác (độc lập trên từng tab trình duyệt)"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: storeCtx.activeStore.color || '#2563eb' }}
                        />
                        <span className="max-w-[140px] truncate">{storeCtx.activeStore.name}</span>
                        <ChevronsUpDown className="h-3 w-3 text-slate-400" />
                      </button>
                      {isHeaderStoreMenuOpen ? (
                        <StoreSwitcherMenu
                          alignHeader
                          onClose={() => setIsHeaderStoreMenuOpen(false)}
                        />
                      ) : null}
                    </div>
                  ) : null
                ) : null}
              </nav>

              <div className="flex shrink-0 items-center gap-2">
                <JobActivityHeaderControl onBeforeOpen={() => setIsNotificationsOpen(false)} />

                <div className="relative">
                  <button
                    aria-expanded={isNotificationsOpen}
                    aria-label="Mở thông báo"
                    className={`relative inline-flex h-10 w-10 items-center justify-center rounded-md border text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-100 ${
                      isNotificationsOpen
                        ? 'border-brand-300 bg-brand-50 text-brand-700'
                        : 'border-slate-300 bg-white'
                    }`}
                    title="Thông báo"
                    type="button"
                    onClick={() => setIsNotificationsOpen((current) => !current)}
                  >
                    <Bell className="h-4 w-4" />
                    {unreadCount > 0 ? (
                      <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow-sm ring-2 ring-white">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    ) : null}
                  </button>
                  {isNotificationsOpen ? (
                    <NotificationPopover
                      items={notificationItems}
                      loading={notificationsLoading}
                      unreadCount={unreadCount}
                      unreadOnly={notificationsUnreadOnly}
                      updating={notificationsUpdating}
                      error={notificationsError}
                      onClose={() => setIsNotificationsOpen(false)}
                      onRefresh={() => void loadNotifications()}
                      onToggleUnreadOnly={() => setNotificationsUnreadOnly((current) => !current)}
                      onMarkRead={(notificationId) => void markNotificationRead(notificationId)}
                      onMarkAllRead={() => void markAllNotificationsRead()}
                    />
                  ) : null}
                </div>

                <Link
                  aria-label="Cài đặt"
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-md border text-slate-700 transition hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-100 ${
                    (pendingHref ?? pathname) === '/settings'
                      ? 'border-brand-300 bg-brand-50 text-brand-700'
                      : 'border-slate-300 bg-white'
                  }`}
                  href="/settings"
                  title="Cài đặt"
                  onMouseEnter={() => {
                    router.prefetch('/settings');
                    prefetchWorkspaceTabData(queryClient, auth.activeWorkspaceId, '/settings');
                  }}
                  onFocus={() => {
                    router.prefetch('/settings');
                    prefetchWorkspaceTabData(queryClient, auth.activeWorkspaceId, '/settings');
                  }}
                  onClick={(event) => {
                    if (
                      !event.defaultPrevented &&
                      event.button === 0 &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.altKey &&
                      pathname !== '/settings'
                    ) {
                      setPendingHref('/settings');
                    }
                  }}
                >
                  <Settings className="h-4 w-4" />
                </Link>
              </div>
            </div>
            {pendingHref && pendingHref !== pathname ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-brand-100">
                <div className="h-full w-1/3 animate-pulse bg-brand-600" />
              </div>
            ) : null}
          </header>

          <div className="px-5 py-6 sm:px-8 lg:px-10">{children}</div>
        </main>
        <JobActivityTransientBar />
        <NotificationToasts />
      </div>
    </JobActivityProvider>
  );
}

function StoreSwitcherMenu({
  isCollapsed = false,
  alignHeader = false,
  onClose,
}: {
  isCollapsed?: boolean;
  alignHeader?: boolean;
  onClose: () => void;
}) {
  const storeCtx = useActiveStore();

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className={`absolute z-50 rounded-xl border border-slate-200 bg-white p-2 shadow-xl ${
          alignHeader
            ? 'left-0 top-full mt-1.5 w-72'
            : isCollapsed
              ? 'left-full top-0 ml-3 w-72'
              : 'left-0 top-full mt-1.5 w-full min-w-[264px]'
        }`}
      >
        <div className="mb-1.5 flex items-center justify-between px-2 pt-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Chuyển Store thao tác
          </span>
          <span className="text-[10px] font-medium text-slate-400">Độc lập theo Tab</span>
        </div>

        <div className="max-h-64 space-y-1 overflow-y-auto pr-0.5">
          {storeCtx.stores.map((store) => {
            const isSelected = store.id === storeCtx.activeStoreId;
            const hasShopify = Boolean(store.shopify?.connected && store.shopify.enabled);
            const proxyCount = store.proxy?.enabled ? (store.proxy.targets?.length ?? 0) : 0;

            return (
              <button
                key={store.id}
                type="button"
                onClick={() => {
                  storeCtx.setActiveStoreId(store.id);
                  onClose();
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                  isSelected
                    ? 'bg-brand-50 font-semibold text-brand-800 ring-1 ring-inset ring-brand-200/80'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white"
                    style={{ backgroundColor: store.color || '#2563eb' }}
                  >
                    {store.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate">{store.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-normal text-slate-500">
                      <span>{store.accountCount} kênh</span>
                      {hasShopify ? (
                        <span className="font-medium text-emerald-700">• /s/</span>
                      ) : null}
                      {proxyCount > 0 ? (
                        <span className="inline-flex items-center gap-0.5 font-medium text-indigo-700">
                          • <Shield className="h-2.5 w-2.5" /> {proxyCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                {isSelected ? <Check className="h-4 w-4 shrink-0 text-brand-600" /> : null}
              </button>
            );
          })}
        </div>

        <div className="my-2 border-t border-slate-100" />

        <div className="space-y-1">
          {storeCtx.activeStore ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                storeCtx.openStoreSettingsModal(storeCtx.activeStore, 'general');
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              <Settings className="h-3.5 w-3.5 text-slate-500" />
              Cài đặt Store &ldquo;{storeCtx.activeStore.name}&rdquo;
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              onClose();
              storeCtx.openCreateStoreModal();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-brand-700 transition hover:bg-brand-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Tạo Store mới
          </button>
        </div>
      </div>
    </>
  );
}

function NotificationPopover({
  items,
  loading,
  unreadCount,
  unreadOnly,
  updating,
  error,
  onClose,
  onRefresh,
  onToggleUnreadOnly,
  onMarkRead,
  onMarkAllRead,
}: {
  items: NotificationView[];
  loading: boolean;
  unreadCount: number;
  unreadOnly: boolean;
  updating: string | null;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onToggleUnreadOnly: () => void;
  onMarkRead: (notificationId: string) => void;
  onMarkAllRead: () => void;
}) {
  return (
    <>
      <button
        aria-label="Đóng thông báo"
        className="fixed inset-0 z-40 cursor-default"
        type="button"
        onClick={onClose}
      />
      <section className="absolute right-0 top-12 z-50 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-950">Thông báo</p>
              <p className="mt-1 text-xs text-slate-500">
                {unreadCount > 0 ? `${unreadCount} chưa đọc` : 'Không có thông báo mới'}
              </p>
            </div>
            <button
              aria-label="Đóng"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
              type="button"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={`inline-flex h-8 items-center rounded-md border px-3 text-xs font-semibold transition ${
                unreadOnly
                  ? 'border-brand-200 bg-brand-50 text-brand-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
              type="button"
              onClick={onToggleUnreadOnly}
            >
              {unreadOnly ? 'Hiện tất cả' : 'Chỉ chưa đọc'}
            </button>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:text-slate-400"
              disabled={loading}
              type="button"
              onClick={onRefresh}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Làm mới
            </button>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:text-slate-400"
              disabled={updating !== null || unreadCount === 0}
              type="button"
              onClick={onMarkAllRead}
            >
              <Check className="h-3.5 w-3.5" />
              Đọc hết
            </button>
          </div>
        </div>

        {error ? (
          <p className="m-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="max-h-[420px] overflow-y-auto">
          {items.map((item) => {
            const meta = notificationDisplayMeta(item);
            const body = notificationBodyText(item);
            return (
              <article
                key={item.id}
                className="border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                      item.readAt ? 'bg-slate-100 text-slate-400' : 'bg-brand-50 text-brand-700'
                    }`}
                  >
                    {item.readAt ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Circle className="h-3 w-3 fill-current" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {item.type}
                      </span>
                      {meta.platformLabel ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${platformBadgeClass(meta.platform)}`}
                        >
                          {meta.platformLabel}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                        <Clock className="h-3 w-3" />
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                      {item.title}
                    </p>
                    {body ? (
                      <p className="mt-1 line-clamp-2 text-sm text-slate-600">{body}</p>
                    ) : null}
                    {meta.postTitle ? (
                      <p className="mt-1 truncate text-xs text-slate-500">Bài: {meta.postTitle}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {item.linkUrl ? (
                        <Link
                          className="text-xs font-semibold text-brand-700 hover:text-brand-800"
                          href={item.linkUrl}
                          onClick={onClose}
                        >
                          Mở liên quan
                        </Link>
                      ) : null}
                      {!item.readAt ? (
                        <button
                          className="text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:text-slate-400"
                          disabled={updating !== null}
                          type="button"
                          onClick={() => onMarkRead(item.id)}
                        >
                          {updating === item.id ? 'Đang cập nhật...' : 'Đánh dấu đã đọc'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}

          {!loading && items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              Chưa có notification nào.
            </p>
          ) : null}
          {loading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">Đang tải...</p>
          ) : null}
        </div>
      </section>
    </>
  );
}
