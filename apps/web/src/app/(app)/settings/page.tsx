'use client';

import { hasPermission } from '@socialhub/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, InlineError, PrimaryButton, TextInput } from '@/components/form-controls';
import { workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { AuditLogItem } from '@/lib/types';

export default function SettingsPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    setName(workspace.name);
    setTimezone(workspace.timezone);
  }, [workspace]);

  useEffect(() => {
    if (!workspace || !hasPermission(workspace.role, 'audit_log:view')) {
      setAuditLogs([]);
      return;
    }

    async function loadAuditLogs() {
      if (!workspace) return;
      try {
        const result = await workspaceApi.auditLogs(workspace.id);
        setAuditLogs(result.items);
      } catch (loadError) {
        setError(getErrorMessage(loadError));
      }
    }

    void loadAuditLogs();
  }, [workspace]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;

    setSubmitting(true);
    setError(null);
    setSaved(false);

    try {
      await workspaceApi.update(workspace.id, { name, timezone });
      await auth.refresh();
      setSaved(true);
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  }

  if (!workspace) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-950">Settings</h1>
        <p className="mt-2 text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>
      </section>
    );
  }

  const canUpdate = hasPermission(workspace.role, 'workspace:update');
  const canViewAudit = hasPermission(workspace.role, 'audit_log:view');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-950">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">{workspace.name}</p>
      </header>

      <InlineError message={error} />

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">Workspace</h2>
        <form className="mt-4 grid gap-4 md:grid-cols-[1fr_220px_auto]" onSubmit={handleSave}>
          <Field label="Tên workspace">
            <TextInput
              disabled={!canUpdate}
              name="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Timezone">
            <TextInput
              disabled={!canUpdate}
              name="timezone"
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </Field>
          <PrimaryButton busy={submitting} className="self-end" disabled={!canUpdate} type="submit">
            Lưu
          </PrimaryButton>
        </form>
        {saved ? <p className="mt-3 text-sm font-medium text-emerald-700">Đã lưu.</p> : null}
      </section>

      {canViewAudit ? (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-semibold text-slate-950">Audit log</h2>
          </div>
          <div className="divide-y divide-slate-200">
            {auditLogs.map((log) => (
              <div key={log.id} className="grid gap-2 px-5 py-4 md:grid-cols-[220px_1fr_180px]">
                <p className="font-mono text-xs font-semibold text-slate-700">{log.action}</p>
                <p className="truncate text-sm text-slate-600">
                  {log.resourceType ?? 'Resource'} {log.resourceId ?? ''}
                </p>
                <p className="text-sm text-slate-500">
                  {new Date(log.createdAt).toLocaleString('vi-VN')}
                </p>
              </div>
            ))}
            {auditLogs.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-600">Chưa có audit log.</p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
