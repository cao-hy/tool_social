import type { WorkspaceRole } from '@socialhub/shared';

const ROLE_STYLE: Record<WorkspaceRole, string> = {
  OWNER: 'bg-slate-950 text-white',
  ADMIN: 'bg-brand-100 text-brand-700',
  EDITOR: 'bg-emerald-100 text-emerald-800',
  ANALYST: 'bg-sky-100 text-sky-800',
  VIEWER: 'bg-slate-100 text-slate-700',
};

export function RoleBadge({ role }: { role: WorkspaceRole }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${ROLE_STYLE[role]}`}>
      {role}
    </span>
  );
}
