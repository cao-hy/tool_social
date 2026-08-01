'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BarChart2,
  Bell,
  Calendar,
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe,
  LayoutDashboard,
  Link2,
  LogOut,
  MessageSquare,
  PenSquare,
  Settings,
  Users,
} from 'lucide-react';
import { CURRENT_PHASE, isAvailable, NAV_ITEMS } from '@/lib/navigation';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
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
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!auth.loading && !auth.user) router.replace('/login');
  }, [auth.loading, auth.user, router]);

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
          {NAV_ITEMS.map((item) => {
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
                  {item.href === '/notifications' && unreadCount > 0 && isCollapsed && (
                    <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5 rounded-full bg-red-500 shadow-sm ring-1 ring-white" />
                  )}
                </div>
                {!isCollapsed && (
                  <div className="flex flex-1 items-center justify-between">
                    <div>
                      <span className="block">{item.label}</span>
                      <span className="text-xs text-slate-500">{item.description}</span>
                    </div>
                    {item.href === '/notifications' && unreadCount > 0 && (
                      <span className="flex h-5 items-center justify-center rounded-full bg-red-500 px-2 text-xs font-bold text-white shadow-sm">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
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

      <main className="min-w-0 px-5 py-6 sm:px-8 lg:px-10">{children}</main>
      <NotificationToasts />
    </div>
  );
}
