'use client';

import { hasPermission } from '@socialhub/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/form-controls';
import { mediaApi, workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { AuditLogItem, MediaLibraryItem, StorageUsageView } from '@/lib/types';

export default function SettingsPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [storageUsage, setStorageUsage] = useState<StorageUsageView | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaLibraryItem[]>([]);
  const [mediaCursor, setMediaCursor] = useState<string | null>(null);
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [mediaStatus, setMediaStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);

  const canViewMedia = workspace ? hasPermission(workspace.role, 'media:view') : false;
  const canDeleteMedia = workspace ? hasPermission(workspace.role, 'media:delete') : false;

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

  const loadStoragePage = useCallback(
    async (cursor?: string, append = false) => {
      if (!workspace || !canViewMedia) return;
      setMediaLoading(true);
      setError(null);
      try {
        const [usage, media] = await Promise.all([
          mediaApi.usage(workspace.id),
          mediaApi.list(workspace.id, {
            q: mediaQuery.trim() || undefined,
            type: mediaType || undefined,
            status: mediaStatus || undefined,
            cursor,
            limit: 30,
          }),
        ]);
        setStorageUsage(usage);
        setMediaItems((current) => (append ? [...current, ...media.items] : media.items));
        setMediaCursor(media.nextCursor);
      } catch (loadError) {
        setError(getErrorMessage(loadError));
      } finally {
        setMediaLoading(false);
      }
    },
    [canViewMedia, mediaQuery, mediaStatus, mediaType, workspace],
  );

  useEffect(() => {
    if (!canViewMedia) {
      setStorageUsage(null);
      setMediaItems([]);
      setMediaCursor(null);
      return;
    }
    void loadStoragePage();
  }, [canViewMedia, loadStoragePage]);

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

  async function handleDeleteMedia(media: MediaLibraryItem) {
    if (!workspace || media.usage.total > 0) return;
    const confirmed = window.confirm(
      `Xóa media "${media.originalFileName ?? media.id}" khỏi storage? Thao tác này không hoàn tác được.`,
    );
    if (!confirmed) return;

    setDeletingMediaId(media.id);
    setError(null);
    try {
      await mediaApi.delete(workspace.id, media.id);
      await loadStoragePage();
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setDeletingMediaId(null);
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

      {canViewMedia ? (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Storage</h2>
              <p className="mt-1 text-sm text-slate-600">
                Dung lượng VPS và media đang lưu trong workspace.
              </p>
            </div>
            <SecondaryButton disabled={mediaLoading} onClick={() => void loadStoragePage()}>
              Làm mới
            </SecondaryButton>
          </div>

          <div className="grid gap-4 p-5 lg:grid-cols-3">
            <StorageMetric
              label="VPS còn trống"
              value={storageUsage ? formatBytes(storageUsage.disk.availableBytes) : '-'}
              detail={
                storageUsage
                  ? `${formatBytes(storageUsage.disk.usedBytes)} đã dùng / ${formatBytes(storageUsage.disk.totalBytes)}`
                  : 'Đang đọc filesystem'
              }
            />
            <StorageMetric
              label="Media workspace"
              value={storageUsage ? formatBytes(storageUsage.media.totalBytes) : '-'}
              detail={`${mediaItems.length} file đang hiển thị`}
            />
            <StorageMetric
              label="Tỷ lệ dùng ổ"
              value={storageUsage ? `${storageUsage.disk.usedPercent.toFixed(1)}%` : '-'}
              detail={storageUsage?.disk.path ?? 'API container filesystem'}
            />
          </div>

          {storageUsage ? (
            <div className="px-5 pb-5">
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600"
                  style={{ width: `${Math.min(storageUsage.disk.usedPercent, 100)}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 border-t border-slate-200 px-5 py-4 md:grid-cols-[1fr_160px_180px_auto]">
            <TextInput
              aria-label="Tìm media"
              placeholder="Tìm theo tên file"
              value={mediaQuery}
              onChange={(event) => setMediaQuery(event.target.value)}
            />
            <SelectInput
              aria-label="Loại media"
              value={mediaType}
              onChange={(event) => setMediaType(event.target.value)}
            >
              <option value="">Tất cả loại</option>
              <option value="IMAGE">Ảnh</option>
              <option value="VIDEO">Video</option>
            </SelectInput>
            <SelectInput
              aria-label="Trạng thái media"
              value={mediaStatus}
              onChange={(event) => setMediaStatus(event.target.value)}
            >
              <option value="">Tất cả trạng thái</option>
              <option value="READY">READY</option>
              <option value="PENDING_UPLOAD">PENDING_UPLOAD</option>
              <option value="FAILED">FAILED</option>
            </SelectInput>
            <SecondaryButton disabled={mediaLoading} onClick={() => void loadStoragePage()}>
              Lọc
            </SecondaryButton>
          </div>

          <div className="divide-y divide-slate-200">
            {mediaItems.map((media) => (
              <div
                key={media.id}
                className="grid gap-4 px-5 py-4 lg:grid-cols-[72px_1fr_140px_120px_120px]"
              >
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                  {media.type === 'IMAGE' && media.readUrl ? (
                    <img
                      alt={media.originalFileName ?? 'media'}
                      className="h-full w-full object-cover"
                      src={media.readUrl}
                    />
                  ) : (
                    <span className="text-xs font-semibold text-slate-500">{media.type}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-950">
                    {media.originalFileName ?? media.id}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{media.mimeType ?? media.status}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Upload bởi {media.uploadedByName ?? media.uploadedByEmail ?? 'không rõ'} ·{' '}
                    {media.createdAt ? new Date(media.createdAt).toLocaleString('vi-VN') : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-slate-500">Dung lượng</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {formatBytes(media.sizeBytes ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-slate-500">Đang dùng</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {media.usage.total} nơi
                  </p>
                </div>
                <div className="flex items-center lg:justify-end">
                  <SecondaryButton
                    disabled={
                      !canDeleteMedia || media.usage.total > 0 || deletingMediaId === media.id
                    }
                    onClick={() => void handleDeleteMedia(media)}
                  >
                    {deletingMediaId === media.id ? 'Đang xoá' : 'Xoá'}
                  </SecondaryButton>
                </div>
              </div>
            ))}
            {mediaItems.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-600">Chưa có media nào khớp filter.</p>
            ) : null}
          </div>

          {mediaCursor ? (
            <div className="border-t border-slate-200 px-5 py-4">
              <SecondaryButton
                disabled={mediaLoading}
                onClick={() => void loadStoragePage(mediaCursor, true)}
              >
                Tải thêm
              </SecondaryButton>
            </div>
          ) : null}
        </section>
      ) : null}

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

function StorageMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
      <p className="mt-1 truncate text-sm text-slate-600">{detail}</p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
