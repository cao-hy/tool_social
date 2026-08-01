'use client';

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
  Circle,
  Clock,
  FileText,
  Globe,
  LayoutDashboard,
  Link2,
  LogOut,
  MessageSquare,
  PenSquare,
  RefreshCw,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { CURRENT_PHASE, isAvailable, NAV_ITEMS } from '@/lib/navigation';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { NotificationView } from '@/lib/types';
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
  '/network': Globe,
  '/settings': Settings,
};
import { NotificationToasts } from './notification-toasts';
import { RoleBadge } from './role-badge';
import { ProxyWidget } from './proxy-widget';

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
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
    if (!auth.loading && !auth.user) router.replace('/login');
  }, [auth.loading, auth.user, router]);

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

  useEffect(() => {
    if (!auth.activeWorkspaceId) return;
    const workspaceId = auth.activeWorkspaceId;
    async function fetchUnreadCount() {
      try {
        const res = await notificationsApi.list(workspaceId, {
          unreadOnly: true,
          limit: 99,
        });
        setUnreadCount(res.items.length);
      } catch (e) {
        console.error('Failed to fetch unread notifications', e);
      }
    }
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 60000);
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

  const canManageProxy =
    auth.activeWorkspace?.role === 'OWNER' || auth.activeWorkspace?.role === 'ADMIN';
  const navItems = NAV_ITEMS.filter(
    (item) => item.href !== '/notifications' && item.href !== '/settings',
  );

  return (
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
            <div>
              <p className="text-sm font-semibold text-brand-600">SocialHub</p>
              <p className="mt-1 text-xs text-slate-500">Phase {CURRENT_PHASE}</p>
            </div>
          )}
          {isCollapsed && (
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 font-bold text-white shadow-sm">
              SH
            </div>
          )}
        </div>

        {!isCollapsed ? (
          <div className="relative mb-5 shrink-0">
            <button
              onClick={() => setIsWorkspaceMenuOpen(!isWorkspaceMenuOpen)}
              className="w-full rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50 transition focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <p className="truncate text-sm font-semibold text-slate-900">
                {auth.activeWorkspace?.name ?? 'Chưa có workspace'}
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                {auth.activeWorkspace ? <RoleBadge role={auth.activeWorkspace.role} /> : null}
                <span className="truncate text-xs text-slate-500">{auth.user.email}</span>
              </div>
            </button>
          </div>
        ) : (
          <div className="relative mb-5 flex shrink-0 justify-center">
            <button
              onClick={() => setIsWorkspaceMenuOpen(!isWorkspaceMenuOpen)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 font-bold text-slate-600 hover:bg-slate-200 transition focus:outline-none focus:ring-2 focus:ring-brand-500"
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
              className={`absolute z-50 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg ${
                isCollapsed ? 'left-[70px] top-16' : 'left-5 top-28'
              }`}
            >
              {auth.workspaces.length > 0 && (
                <>
                  <div className="mb-2 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    CHỌN WORKSPACE
                  </div>
                  <div className="space-y-1">
                    {auth.workspaces.map((workspace) => (
                      <button
                        key={workspace.id}
                        onClick={() => {
                          auth.setActiveWorkspaceId(workspace.id);
                          setIsWorkspaceMenuOpen(false);
                        }}
                        className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${
                          workspace.id === auth.activeWorkspaceId
                            ? 'bg-brand-50 text-brand-700 font-medium'
                            : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div className="truncate">{workspace.name}</div>
                        <div className="text-xs opacity-70 capitalize">
                          {workspace.role.toLowerCase()}
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="my-2 border-t border-slate-100" />
                </>
              )}
              <div className="px-1">
                <button
                  onClick={() => {
                    setIsWorkspaceMenuOpen(false);
                    handleLogout();
                  }}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition"
                >
                  <LogOut className="h-4 w-4" />
                  Đăng xuất
                </button>
              </div>
            </div>
          </>
        )}

        {canManageProxy && auth.activeWorkspaceId ? (
          <div className="mb-5 shrink-0">
            <ProxyWidget workspaceId={auth.activeWorkspaceId} isCollapsed={isCollapsed} />
          </div>
        ) : null}

        <nav
          className={`flex-1 overflow-y-auto space-y-1 ${isCollapsed ? 'scrollbar-hide' : 'pr-1 -mr-1'}`}
        >
          {navItems.map((item) => {
            const available = isAvailable(item);
            const active = pathname === item.href;
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
          className={`sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 px-5 py-3 shadow-sm backdrop-blur sm:px-8 lg:px-10 transition-transform duration-300 ${isHeaderHidden ? '-translate-y-full' : 'translate-y-0'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {auth.activeWorkspace?.name ?? 'Workspace'}
              </p>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-slate-950">
                  {auth.user.email}
                </span>
                {auth.activeWorkspace ? <RoleBadge role={auth.activeWorkspace.role} /> : null}
              </div>
            </div>

            <div className="flex items-center gap-2">
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
                  pathname === '/settings'
                    ? 'border-brand-300 bg-brand-50 text-brand-700'
                    : 'border-slate-300 bg-white'
                }`}
                href="/settings"
                title="Cài đặt"
              >
                <Settings className="h-4 w-4" />
              </Link>

              <button
                aria-label="Đăng xuất"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:-translate-y-px hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-red-100"
                title="Đăng xuất"
                type="button"
                onClick={() => void handleLogout()}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <div className="px-5 py-6 sm:px-8 lg:px-10">{children}</div>
      </main>
      <NotificationToasts />
    </div>
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
          {items.map((item) => (
            <article key={item.id} className="border-b border-slate-100 px-4 py-3 last:border-b-0">
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
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                      <Clock className="h-3 w-3" />
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-950">{item.title}</p>
                  {item.body ? (
                    <p className="mt-1 line-clamp-2 text-sm text-slate-600">{item.body}</p>
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
          ))}

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
