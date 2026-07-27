'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { CURRENT_PHASE, isAvailable, NAV_ITEMS } from '@/lib/navigation';
import { useAuth } from '@/lib/auth-store';
import { SecondaryButton, SelectInput } from './form-controls';
import { RoleBadge } from './role-badge';

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!auth.loading && !auth.user) router.replace('/login');
  }, [auth.loading, auth.user, router]);

  async function handleLogout() {
    await auth.logout();
    router.replace('/login');
  }

  if (auth.loading) {
    return (
      <main className="grid min-h-screen place-items-center px-6 text-sm text-slate-600">
        Đang kiểm tra phiên đăng nhập...
      </main>
    );
  }

  if (!auth.user) return null;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[280px_1fr]">
      <aside className="border-r border-slate-200 bg-white px-5 py-5">
        <div className="mb-6">
          <p className="text-sm font-semibold text-brand-600">SocialHub Manager</p>
          <p className="mt-1 text-xs text-slate-500">Phase {CURRENT_PHASE}</p>
        </div>

        <div className="mb-5 rounded-lg border border-slate-200 p-3">
          <p className="truncate text-sm font-semibold text-slate-900">
            {auth.activeWorkspace?.name ?? 'Chưa có workspace'}
          </p>
          <div className="mt-2 flex items-center justify-between gap-3">
            {auth.activeWorkspace ? <RoleBadge role={auth.activeWorkspace.role} /> : null}
            <span className="truncate text-xs text-slate-500">{auth.user.email}</span>
          </div>
          {auth.workspaces.length > 1 ? (
            <SelectInput
              aria-label="Workspace"
              className="mt-3"
              value={auth.activeWorkspaceId ?? ''}
              onChange={(event) => auth.setActiveWorkspaceId(event.target.value)}
            >
              {auth.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </SelectInput>
          ) : null}
        </div>

        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const available = isAvailable(item);
            const active = pathname === item.href;

            if (!available) {
              return (
                <div
                  key={item.href}
                  className="rounded-md px-3 py-2 text-sm text-slate-400"
                  title={`Phase ${item.phase}`}
                >
                  <span className="block font-medium">{item.label}</span>
                  <span className="text-xs">{item.description}</span>
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                className={`block rounded-md px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-brand-50 font-semibold text-brand-700'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
                href={item.href}
              >
                <span className="block">{item.label}</span>
                <span className="text-xs text-slate-500">{item.description}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-6 border-t border-slate-200 pt-4">
          <SecondaryButton className="w-full" onClick={handleLogout} type="button">
            Đăng xuất
          </SecondaryButton>
        </div>
      </aside>

      <main className="min-w-0 px-5 py-6 sm:px-8 lg:px-10">{children}</main>
    </div>
  );
}
