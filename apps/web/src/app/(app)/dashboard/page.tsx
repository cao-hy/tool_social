'use client';

import { ROLE_PERMISSIONS } from '@socialhub/shared';
import Link from 'next/link';
import { FileText, Link2, MessageSquare, PenSquare, Plus, Settings, Shield } from 'lucide-react';
import { useAuth } from '@/lib/auth-store';
import { useActiveStore } from '@/lib/store-context';
import { RoleBadge } from '@/components/role-badge';

export default function DashboardPage() {
  const auth = useAuth();
  const storeCtx = useActiveStore();
  const workspace = auth.activeWorkspace;
  const activeStore = storeCtx.activeStore;

  if (!workspace) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-950">Workspace</h1>
        <p className="mt-2 text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>
      </section>
    );
  }

  const permissions = ROLE_PERMISSIONS[workspace.role];

  const groupedPermissions = permissions.reduce(
    (acc, permission) => {
      const [resource, action] = permission.split(':');
      if (!resource || !action) return acc;
      if (!acc[resource]) acc[resource] = [];
      acc[resource].push(action);
      return acc;
    },
    {} as Record<string, string[]>,
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">
            {activeStore ? activeStore.name : workspace.name}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {activeStore
              ? `Tổng quan vận hành của Store "${activeStore.name}" trong ${workspace.name}`
              : `${workspace.slug}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeStore ? (
            <button
              type="button"
              onClick={() => storeCtx.openStoreSettingsModal(activeStore, 'general')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 shadow-xs transition hover:border-brand-300 hover:bg-brand-50"
            >
              <Settings className="h-3.5 w-3.5" />
              Cài đặt Store
            </button>
          ) : null}
          <RoleBadge role={workspace.role} />
        </div>
      </header>

      {!storeCtx.loading && !activeStore ? (
        <section className="rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Chưa có Store nào trong Workspace
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Tạo Store đầu tiên để gom nhóm kênh mạng xã hội, cài đặt Shopify `/s/` và Proxy độc lập
            cho từng thương hiệu.
          </p>
          <button
            type="button"
            onClick={() => storeCtx.openCreateStoreModal()}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Tạo Store đầu tiên
          </button>
        </section>
      ) : null}

      {activeStore ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <span
                className="flex h-11 w-11 items-center justify-center rounded-xl text-base font-bold text-white shadow-xs"
                style={{ backgroundColor: activeStore.color || '#2563eb' }}
              >
                {activeStore.name.charAt(0).toUpperCase()}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-slate-950">{activeStore.name}</h2>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    {activeStore.accounts.filter((a) => a.status === 'CONNECTED').length}/
                    {activeStore.accountCount} kênh đang kết nối
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {activeStore.shopify?.connected && activeStore.shopify.enabled ? (
                    <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                      Shopify Shortlink: {activeStore.shopify.publicDomain}
                      {activeStore.shopify.shortPathPrefix}
                    </span>
                  ) : (
                    <span>Shopify `/s/`: Chưa bật</span>
                  )}
                  <span>•</span>
                  {activeStore.proxy?.enabled && (activeStore.proxy.targets?.length ?? 0) > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">
                      <Shield className="h-3 w-3" />
                      Proxy: {activeStore.proxy.targets.join(', ')}
                    </span>
                  ) : (
                    <span>Mạng: Direct IP</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Link
              href="/posts/new"
              className="flex items-center gap-3 rounded-lg border border-slate-200 p-3.5 transition hover:border-brand-300 hover:bg-brand-50/40"
            >
              <PenSquare className="h-5 w-5 text-brand-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">Đăng bài mới</p>
                <p className="text-xs text-slate-500">Chỉ đăng trên {activeStore.name}</p>
              </div>
            </Link>
            <Link
              href="/posts"
              className="flex items-center gap-3 rounded-lg border border-slate-200 p-3.5 transition hover:border-brand-300 hover:bg-brand-50/40"
            >
              <FileText className="h-5 w-5 text-brand-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">Bài viết & Comment</p>
                <p className="text-xs text-slate-500">Danh sách bài của {activeStore.name}</p>
              </div>
            </Link>
            <Link
              href="/inbox"
              className="flex items-center gap-3 rounded-lg border border-slate-200 p-3.5 transition hover:border-brand-300 hover:bg-brand-50/40"
            >
              <MessageSquare className="h-5 w-5 text-brand-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">Hộp thư bình luận</p>
                <p className="text-xs text-slate-500">Phản hồi khách của {activeStore.name}</p>
              </div>
            </Link>
            <Link
              href="/accounts"
              className="flex items-center gap-3 rounded-lg border border-slate-200 p-3.5 transition hover:border-brand-300 hover:bg-brand-50/40"
            >
              <Link2 className="h-5 w-5 text-brand-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">Kênh MXH & Tích hợp</p>
                <p className="text-xs text-slate-500">Quản lý kênh, `/s/` & Proxy</p>
              </div>
            </Link>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <Link
          className="rounded-lg border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:bg-brand-50"
          href="/team"
        >
          <p className="text-sm font-semibold text-slate-900">Team</p>
          <p className="mt-1 text-sm text-slate-600">Members, invitations, roles</p>
        </Link>
        <Link
          className="rounded-lg border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:bg-brand-50"
          href="/settings"
        >
          <p className="text-sm font-semibold text-slate-900">Settings</p>
          <p className="mt-1 text-sm text-slate-600">Workspace profile and audit log</p>
        </Link>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold text-slate-900">Session</p>
          <p className="mt-1 truncate text-sm text-slate-600">{auth.user?.email}</p>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-950">Quyền hiện tại</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(groupedPermissions).map(([resource, actions]) => (
            <div
              key={resource}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <h3 className="mb-3 text-sm font-semibold capitalize text-slate-900">
                {resource.replace('_', ' ')}
              </h3>
              <div className="flex flex-wrap gap-2">
                {actions.map((action) => (
                  <span
                    key={action}
                    className="rounded-full border border-slate-100 bg-slate-50 px-2.5 py-1 text-xs font-medium capitalize text-slate-600"
                  >
                    {action.replace('_', ' ')}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
