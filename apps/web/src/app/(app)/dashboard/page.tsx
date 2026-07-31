'use client';

import { ROLE_PERMISSIONS } from '@socialhub/shared';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-store';
import { RoleBadge } from '@/components/role-badge';

export default function DashboardPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;

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
          <h1 className="text-2xl font-semibold text-slate-950">{workspace.name}</h1>
          <p className="mt-1 text-sm text-slate-600">{workspace.slug}</p>
        </div>
        <RoleBadge role={workspace.role} />
      </header>

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
