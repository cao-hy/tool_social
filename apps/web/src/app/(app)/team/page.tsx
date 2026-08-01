'use client';

import {
  canAssignRole,
  hasPermission,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@socialhub/shared';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/form-controls';
import { RoleBadge } from '@/components/role-badge';
import { useToast } from '@/components/toast-provider';
import { workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { WorkspaceInvitation, WorkspaceMember } from '@/lib/types';

export default function TeamPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('VIEWER');
  const [invitation, setInvitation] = useState<WorkspaceInvitation | null>(null);

  async function loadMembers(workspaceId: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await workspaceApi.members(workspaceId);
      setMembers(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    void loadMembers(workspace.id);
  }, [workspace]);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;

    setSubmitting(true);
    setError(null);
    setInvitation(null);
    const form = new FormData(event.currentTarget);

    try {
      const result = await workspaceApi.invite(workspace.id, {
        email: String(form.get('email') ?? ''),
        role: inviteRole,
      });
      setInvitation(result);
      event.currentTarget.reset();
      setInviteRole('VIEWER');
      toast.success(result.resent ? 'Đã gửi lại lời mời.' : 'Đã gửi lời mời.');
    } catch (inviteError) {
      toast.error(getErrorMessage(inviteError));
    } finally {
      setSubmitting(false);
    }
  }

  async function changeRole(memberId: string, role: WorkspaceRole) {
    if (!workspace) return;
    setError(null);
    try {
      await workspaceApi.changeRole(workspace.id, memberId, role);
      await loadMembers(workspace.id);
      toast.success('Đã cập nhật vai trò.');
    } catch (changeError) {
      toast.error(getErrorMessage(changeError));
    }
  }

  async function removeMember(memberId: string) {
    if (!workspace) return;
    setError(null);
    try {
      await workspaceApi.removeMember(workspace.id, memberId);
      await loadMembers(workspace.id);
      toast.success('Đã xóa thành viên khỏi workspace.');
    } catch (removeError) {
      toast.error(getErrorMessage(removeError));
    }
  }

  if (!workspace) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-950">Team</h1>
        <p className="mt-2 text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>
      </section>
    );
  }

  const canInvite = hasPermission(workspace.role, 'member:invite');
  const canRemove = hasPermission(workspace.role, 'member:remove');
  const canChangeRole = hasPermission(workspace.role, 'member:change_role');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-950">Team</h1>
        <p className="mt-1 text-sm text-slate-600">{workspace.name}</p>
      </header>

      {canInvite ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Mời thành viên</h2>
          <form className="mt-4 grid gap-3 md:grid-cols-[1fr_180px_auto]" onSubmit={handleInvite}>
            <Field label="Email">
              <TextInput name="email" required type="email" />
            </Field>
            <Field label="Vai trò">
              <SelectInput
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
              >
                {WORKSPACE_ROLES.filter((role) => role !== 'OWNER').map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <PrimaryButton busy={submitting} className="self-end" type="submit">
              Mời / Mời lại
            </PrimaryButton>
          </form>
          {invitation ? (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              {invitation.resent ? 'Invitation đã được mời lại' : 'Invitation đã tạo'} cho{' '}
              {invitation.email}. Link cũ, nếu có, không còn dùng được.
              {invitation.devInvitationToken ? (
                <>
                  <p className="mt-2 break-all font-mono text-xs text-emerald-900">
                    {invitation.devInvitationToken}
                  </p>
                  <p className="mt-2">
                    <a
                      className="font-medium text-emerald-900 underline"
                      href={`/accept-invitation?token=${encodeURIComponent(invitation.devInvitationToken)}`}
                    >
                      Mở trang nhận lời mời
                    </a>
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <InlineError message={error} />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Thành viên</h2>
          <span className="text-sm text-slate-500">
            {loading ? 'Đang tải...' : `${members.length} người`}
          </span>
        </div>
        <div className="divide-y divide-slate-200">
          {members.map((member) => {
            const isSelf = member.userId === auth.user?.id;
            const canEditThisRole = canChangeRole && !isSelf;
            const canRemoveThisMember = canRemove && !isSelf;

            return (
              <div key={member.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1fr_190px_140px]">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-950">
                    {member.name ?? member.email}
                  </p>
                  <p className="truncate text-sm text-slate-600">{member.email}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Tham gia {new Date(member.createdAt).toLocaleDateString('vi-VN')}
                  </p>
                </div>
                {canEditThisRole ? (
                  <SelectInput
                    aria-label={`Vai trò của ${member.email}`}
                    value={member.role}
                    onChange={(event) =>
                      void changeRole(member.id, event.target.value as WorkspaceRole)
                    }
                  >
                    {WORKSPACE_ROLES.map((role) => (
                      <option
                        key={role}
                        disabled={
                          role !== member.role &&
                          !canAssignRole({
                            actorRole: workspace.role,
                            targetCurrentRole: member.role,
                            targetNewRole: role,
                            isSelf,
                          })
                        }
                        value={role}
                      >
                        {role}
                      </option>
                    ))}
                  </SelectInput>
                ) : (
                  <div className="flex items-center">
                    <RoleBadge role={member.role} />
                  </div>
                )}
                <div className="flex items-center justify-start lg:justify-end">
                  <SecondaryButton
                    disabled={!canRemoveThisMember}
                    onClick={() => void removeMember(member.id)}
                    type="button"
                  >
                    Xóa
                  </SecondaryButton>
                </div>
              </div>
            );
          })}
          {!loading && members.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-600">Không có thành viên.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
