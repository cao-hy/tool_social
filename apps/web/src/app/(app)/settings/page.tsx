'use client';

import { hasPermission } from '@socialhub/shared';
import { ChevronLeft, ChevronRight, Clock, Database, FileText, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/form-controls';
import { FallbackImage, mediaThumbnailSources } from '@/components/media-preview';
import { useToast } from '@/components/toast-provider';
import { mediaApi, systemApi, workspaceApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { AuditLogItem, MediaLibraryItem, StorageUsageView } from '@/lib/types';

const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC - Giờ chuẩn' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Asia/Ho_Chi_Minh - Việt Nam' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore - Singapore' },
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok - Thái Lan' },
  { value: 'Asia/Jakarta', label: 'Asia/Jakarta - Indonesia' },
  { value: 'Asia/Manila', label: 'Asia/Manila - Philippines' },
  { value: 'Asia/Kuala_Lumpur', label: 'Asia/Kuala_Lumpur - Malaysia' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo - Nhật Bản' },
  { value: 'Asia/Seoul', label: 'Asia/Seoul - Hàn Quốc' },
  { value: 'America/New_York', label: 'America/New_York - US Eastern' },
  { value: 'America/Chicago', label: 'America/Chicago - US Central' },
  { value: 'America/Denver', label: 'America/Denver - US Mountain' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles - US Pacific' },
  { value: 'America/Toronto', label: 'America/Toronto - Canada Eastern' },
  { value: 'Europe/London', label: 'Europe/London - United Kingdom' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin - Đức' },
  { value: 'Europe/Paris', label: 'Europe/Paris - Pháp' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney - Úc' },
] as const;

const DEFAULT_TIMEZONE_BY_COUNTRY: Record<string, string> = {
  AU: 'Australia/Sydney',
  CA: 'America/Toronto',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  GB: 'Europe/London',
  ID: 'Asia/Jakarta',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  MY: 'Asia/Kuala_Lumpur',
  PH: 'Asia/Manila',
  SG: 'Asia/Singapore',
  TH: 'Asia/Bangkok',
  US: 'America/New_York',
  VN: 'Asia/Ho_Chi_Minh',
};

export default function SettingsPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [timezoneSuggestion, setTimezoneSuggestion] = useState<{
    countryCode: string;
    source: 'proxy' | 'current';
  } | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [storageUsage, setStorageUsage] = useState<StorageUsageView | null>(null);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [deletingMultiple, setDeletingMultiple] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaLibraryItem[]>([]);
  const [mediaCursorStack, setMediaCursorStack] = useState<string[]>([]);
  const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [mediaStatus, setMediaStatus] = useState('');
  const [activeSection, setActiveSection] = useState<'storage' | 'audit'>('storage');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);
  const [renamingMediaId, setRenamingMediaId] = useState<string | null>(null);
  const [regeneratingMediaId, setRegeneratingMediaId] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<MediaLibraryItem | null>(null);

  const canViewMedia = workspace ? hasPermission(workspace.role, 'media:view') : false;
  const canUploadMedia = workspace ? hasPermission(workspace.role, 'media:upload') : false;
  const canDeleteMedia = workspace ? hasPermission(workspace.role, 'media:delete') : false;
  const canUpdate = hasPermission(workspace?.role ?? 'VIEWER', 'workspace:update');

  useEffect(() => {
    if (!workspace) return;
    setName(workspace.name);
    setTimezone(workspace.timezone);
  }, [workspace]);

  const canViewAudit = workspace ? hasPermission(workspace.role, 'audit_log:view') : false;
  const canRenameMedia = canUploadMedia;

  useEffect(() => {
    if (!workspace || !canUpdate) {
      setTimezoneSuggestion(null);
      return;
    }

    let cancelled = false;
    systemApi
      .getNetworkStatus(workspace.id)
      .then((status) => {
        if (cancelled) return;
        const proxyCountry = normalizeCountryCode(
          status.proxyConfig.enabled ? status.proxyConfig.countryLock : null,
        );
        const currentCountry = normalizeCountryCode(status.countryCode);
        const countryCode = proxyCountry ?? currentCountry;
        setTimezoneSuggestion(
          countryCode
            ? {
                countryCode,
                source: proxyCountry ? 'proxy' : 'current',
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setTimezoneSuggestion(null);
      });

    return () => {
      cancelled = true;
    };
  }, [canUpdate, workspace]);

  const loadAuditLogs = useCallback(async () => {
    if (!workspace || !canViewAudit) return;
    setAuditLoading(true);
    setError(null);
    try {
      const result = await workspaceApi.auditLogs(workspace.id);
      setAuditLogs(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setAuditLoading(false);
    }
  }, [canViewAudit, workspace]);

  useEffect(() => {
    if (!workspace || !canViewAudit) {
      setAuditLogs([]);
      return;
    }

    void loadAuditLogs();
  }, [canViewAudit, loadAuditLogs, workspace]);

  const loadStoragePage = useCallback(
    async (cursor?: string) => {
      if (!workspace || !canViewMedia) return;
      setMediaLoading(true);
      setError(null);
      try {
        const [usage, response] = await Promise.all([
          mediaApi.usage(workspace.id),
          mediaApi.list(workspace.id, {
            limit: 20,
            cursor,
            q: mediaQuery || undefined,
            type: mediaType || undefined,
            status: mediaStatus || undefined,
          }),
        ]);
        setStorageUsage(usage);
        setMediaItems(response.items);
        setSelectedMediaIds(new Set());
        setMediaNextCursor(response.nextCursor);
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
      setMediaCursorStack([]);
      setMediaNextCursor(null);
      return;
    }
    void loadStoragePage();
  }, [canViewMedia, loadStoragePage]);

  useEffect(() => {
    if (activeSection === 'storage' && !canViewMedia && canViewAudit) {
      setActiveSection('audit');
    }
  }, [activeSection, canViewAudit, canViewMedia]);

  const auditSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of auditLogs) {
      counts.set(log.action, (counts.get(log.action) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([action, count]) => ({ action, count }));
  }, [auditLogs]);

  const timezoneOptions = useMemo(() => {
    if (TIMEZONE_OPTIONS.some((option) => option.value === timezone)) return TIMEZONE_OPTIONS;
    return [{ value: timezone, label: `${timezone} - custom hiện tại` }, ...TIMEZONE_OPTIONS];
  }, [timezone]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace) return;

    setSubmitting(true);
    setError(null);

    try {
      await workspaceApi.update(workspace.id, { name, timezone });
      await auth.refresh();
      toast.success('Đã lưu cấu hình workspace.');
    } catch (saveError) {
      toast.error(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteMedia(media: MediaLibraryItem) {
    if (!workspace) return;
    if (media.status === 'ARCHIVED' && media.usage.total > 0) {
      toast.warning('Media này vẫn còn được bài active dùng nên chưa thể xóa hẳn.');
      return;
    }
    const isArchive = media.usage.total > 0 && media.status !== 'ARCHIVED';
    const confirmed = window.confirm(
      isArchive
        ? `Dọn dẹp file gốc của "${media.originalFileName ?? media.id}"? Thao tác này sẽ xoá file gốc để tiết kiệm dung lượng nhưng vẫn giữ lại thumbnail.`
        : `Xóa media "${media.originalFileName ?? media.id}" khỏi storage? Thao tác này không hoàn tác được.`,
    );
    if (!confirmed) return;

    setDeletingMediaId(media.id);
    setError(null);
    try {
      if (isArchive) {
        await mediaApi.archive(workspace.id, media.id);
      } else {
        await mediaApi.delete(workspace.id, media.id);
      }
      await loadStoragePage(mediaCursorStack.at(-1));
      toast.success(isArchive ? 'Đã dọn dẹp file media.' : 'Đã xóa media.');
    } catch (deleteError) {
      toast.error(getErrorMessage(deleteError));
    } finally {
      setDeletingMediaId(null);
    }
  }

  async function handleRenameMedia(media: MediaLibraryItem) {
    if (!workspace) return;
    const currentName = media.originalFileName ?? '';
    const nextName = window.prompt('Tên media mới', currentName);
    if (nextName === null) return;
    const trimmedName = nextName.trim();
    if (!trimmedName) {
      toast.warning('Tên media không được để trống.');
      return;
    }
    if (trimmedName === currentName) return;

    setRenamingMediaId(media.id);
    setError(null);
    try {
      const updated = await mediaApi.rename(workspace.id, media.id, trimmedName);
      setMediaItems((current) =>
        current.map((item) =>
          item.id === media.id ? { ...item, originalFileName: updated.originalFileName } : item,
        ),
      );
      toast.success('Đã đổi tên media.');
    } catch (renameError) {
      toast.error(getErrorMessage(renameError));
    } finally {
      setRenamingMediaId(null);
    }
  }

  async function handleRegenerateThumbnail(media: MediaLibraryItem) {
    if (!workspace) return;
    setRegeneratingMediaId(media.id);
    setError(null);
    try {
      await mediaApi.regenerateThumbnail(workspace.id, media.id);

      let finalStatus = 'PROCESSING';
      let attempts = 0;
      while (finalStatus === 'PROCESSING' && attempts < 15) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const res = await mediaApi.list(workspace.id, {
          q: media.originalFileName ?? media.id,
          limit: 5,
        });
        const updatedMedia = res.items.find((m) => m.id === media.id);
        if (updatedMedia) {
          finalStatus = updatedMedia.status;
          if (finalStatus === 'READY') {
            toast.success('Tạo ảnh thumbnail thành công!');
            break;
          } else if (finalStatus === 'FAILED') {
            toast.error('Tạo ảnh thumbnail thất bại (lỗi xử lý video).');
            break;
          }
        }
        attempts++;
      }

      if (finalStatus === 'PROCESSING') {
        toast.info('Đang tạo ảnh thumbnail ở nền, vui lòng tải lại trang sau ít phút.');
      }

      await loadStoragePage(mediaCursorStack.at(-1));
    } catch (regenerateError) {
      toast.error(getErrorMessage(regenerateError));
    } finally {
      setRegeneratingMediaId(null);
    }
  }

  const deletableMediaIds = mediaItems
    .filter((m) => canDeleteMedia && !(m.status === 'ARCHIVED' && m.usage.total > 0))
    .map((m) => m.id);

  const isAllSelected =
    deletableMediaIds.length > 0 && deletableMediaIds.every((id) => selectedMediaIds.has(id));

  function handleSelectAll() {
    if (isAllSelected) {
      setSelectedMediaIds(new Set());
    } else {
      setSelectedMediaIds(new Set(deletableMediaIds));
    }
  }

  function handleToggleMedia(id: string) {
    const next = new Set(selectedMediaIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedMediaIds(next);
  }

  function refreshMediaPage() {
    setMediaCursorStack([]);
    void loadStoragePage();
  }

  function goToPreviousMediaPage() {
    const previousStack = mediaCursorStack.slice(0, -1);
    setMediaCursorStack(previousStack);
    void loadStoragePage(previousStack.at(-1));
  }

  function goToNextMediaPage() {
    if (!mediaNextCursor) return;
    setMediaCursorStack((current) => [...current, mediaNextCursor]);
    void loadStoragePage(mediaNextCursor);
  }

  function applySuggestedTimezone() {
    const suggestedTimezone = timezoneSuggestion
      ? DEFAULT_TIMEZONE_BY_COUNTRY[timezoneSuggestion.countryCode]
      : null;
    if (!suggestedTimezone) {
      toast.warning('Vị trí mạng hiện tại chưa có timezone mặc định để áp dụng.');
      return;
    }
    setTimezone(suggestedTimezone);
    toast.info(`Đã chọn timezone ${suggestedTimezone}. Bấm Lưu để áp dụng.`);
  }

  async function handleDeleteMultiple() {
    if (!workspace || selectedMediaIds.size === 0) return;
    const confirmed = window.confirm(
      `Thực hiện hành động trên ${selectedMediaIds.size} media đã chọn? (Nếu media đang dùng sẽ được Dọn dẹp, ngược lại sẽ bị Xoá)`,
    );
    if (!confirmed) return;

    setDeletingMultiple(true);
    setError(null);
    try {
      for (const id of selectedMediaIds) {
        const media = mediaItems.find((m) => m.id === id);
        if (media && media.usage.total > 0 && media.status !== 'ARCHIVED') {
          await mediaApi.archive(workspace.id, id);
        } else {
          await mediaApi.delete(workspace.id, id);
        }
      }
      setSelectedMediaIds(new Set());
      await loadStoragePage(mediaCursorStack.at(-1));
      toast.success(`Đã xử lý ${selectedMediaIds.size} media.`);
    } catch (deleteError) {
      toast.error(getErrorMessage(deleteError));
    } finally {
      setDeletingMultiple(false);
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-950">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">{workspace.name}</p>
      </header>

      <InlineError message={error} />

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">Workspace</h2>
        <form className="mt-4 grid gap-4 md:grid-cols-[1fr_320px_auto]" onSubmit={handleSave}>
          <Field label="Tên workspace">
            <TextInput
              disabled={!canUpdate}
              name="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-slate-800">Timezone</span>
            <SelectInput
              disabled={!canUpdate}
              name="timezone"
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {timezoneOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectInput>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <SecondaryButton
                disabled={
                  !canUpdate ||
                  !timezoneSuggestion ||
                  !DEFAULT_TIMEZONE_BY_COUNTRY[timezoneSuggestion.countryCode]
                }
                type="button"
                onClick={applySuggestedTimezone}
              >
                Dùng theo vị trí mạng
              </SecondaryButton>
              <span className="text-xs text-slate-500">
                {timezoneSuggestion
                  ? `${
                      timezoneSuggestion.source === 'proxy' ? 'Proxy target' : 'Vị trí hiện tại'
                    } ${timezoneSuggestion.countryCode} -> ${
                      DEFAULT_TIMEZONE_BY_COUNTRY[timezoneSuggestion.countryCode] ??
                      'chưa map timezone'
                    }`
                  : 'Chưa xác minh được vị trí mạng'}
              </span>
            </div>
          </div>
          <PrimaryButton busy={submitting} className="self-end" disabled={!canUpdate} type="submit">
            Lưu
          </PrimaryButton>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-2">
        <div className="grid gap-2 md:grid-cols-2">
          <button
            className={`flex items-center justify-between rounded-md px-4 py-3 text-left transition ${
              activeSection === 'storage'
                ? 'bg-slate-950 text-white shadow-sm'
                : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={!canViewMedia}
            type="button"
            onClick={() => setActiveSection('storage')}
          >
            <span>
              <span className="block text-sm font-semibold">Storage</span>
              <span
                className={`mt-0.5 block text-xs ${
                  activeSection === 'storage' ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                Media, dung lượng VPS và thao tác xóa
              </span>
            </span>
            <Database className="h-5 w-5" />
          </button>
          <button
            className={`flex items-center justify-between rounded-md px-4 py-3 text-left transition ${
              activeSection === 'audit'
                ? 'bg-slate-950 text-white shadow-sm'
                : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
            } disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={!canViewAudit}
            type="button"
            onClick={() => setActiveSection('audit')}
          >
            <span>
              <span className="block text-sm font-semibold">Audit log</span>
              <span
                className={`mt-0.5 block text-xs ${
                  activeSection === 'audit' ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                Lịch sử hành động quan trọng
              </span>
            </span>
            <FileText className="h-5 w-5" />
          </button>
        </div>
      </section>

      {activeSection === 'storage' && canViewMedia ? (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Storage</h2>
              <p className="mt-1 text-sm text-slate-600">
                Dung lượng VPS và media đang lưu trong workspace.
              </p>
            </div>
            <SecondaryButton disabled={mediaLoading} onClick={refreshMediaPage}>
              <RefreshCw className={`mr-2 h-4 w-4 ${mediaLoading ? 'animate-spin' : ''}`} />
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
              detail={`Trang ${mediaCursorStack.length + 1} · ${mediaItems.length} file`}
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
              <option value="PROCESSING">PROCESSING</option>
              <option value="FAILED">FAILED</option>
              <option value="ARCHIVED">ARCHIVED</option>
            </SelectInput>
            <SecondaryButton disabled={mediaLoading} onClick={refreshMediaPage}>
              Lọc
            </SecondaryButton>
          </div>

          <MediaPager
            currentPage={mediaCursorStack.length + 1}
            hasNext={mediaNextCursor !== null}
            hasPrevious={mediaCursorStack.length > 0}
            loading={mediaLoading}
            onNext={goToNextMediaPage}
            onPrevious={goToPreviousMediaPage}
          />

          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={isAllSelected}
                disabled={deletableMediaIds.length === 0}
                onChange={handleSelectAll}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="text-sm font-medium text-slate-700">
                Đã chọn {selectedMediaIds.size}
              </span>
            </div>
            {selectedMediaIds.size > 0 && (
              <SecondaryButton
                disabled={deletingMultiple}
                onClick={() => void handleDeleteMultiple()}
              >
                {deletingMultiple ? 'Đang xoá...' : `Xoá ${selectedMediaIds.size} mục`}
              </SecondaryButton>
            )}
          </div>

          <div className="divide-y divide-slate-200 border-t border-slate-200">
            {mediaItems.map((media) => {
              const source = media.displayUrl ?? media.thumbnailUrl ?? media.readUrl;
              const isDeletable =
                canDeleteMedia && !(media.status === 'ARCHIVED' && media.usage.total > 0);
              const isArchive = media.usage.total > 0 && media.status !== 'ARCHIVED';
              const canRegenerateThumbnail =
                canUploadMedia && media.type === 'VIDEO' && media.status !== 'ARCHIVED';
              return (
                <div
                  key={media.id}
                  className="grid items-center gap-4 px-5 py-4 lg:grid-cols-[24px_72px_1fr_140px_120px_180px]"
                >
                  <input
                    type="checkbox"
                    disabled={!isDeletable}
                    checked={selectedMediaIds.has(media.id)}
                    onChange={() => handleToggleMedia(media.id)}
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                    {source ? (
                      <button
                        type="button"
                        onClick={() => setPreviewMedia(media)}
                        className="relative h-full w-full block group"
                      >
                        <FallbackImage
                          alt={media.originalFileName ?? 'media'}
                          className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
                          sources={mediaThumbnailSources(media)}
                        />
                        {media.type === 'VIDEO' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                            <div className="rounded-full bg-slate-900/80 p-1.5 text-white shadow-sm">
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polygon points="5 3 19 12 5 21 5 3"></polygon>
                              </svg>
                            </div>
                          </div>
                        )}
                      </button>
                    ) : (
                      <span className="text-xs font-semibold text-slate-500">{media.type}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">
                      <button
                        type="button"
                        onClick={() => setPreviewMedia(media)}
                        className="hover:underline hover:text-brand-600 truncate max-w-full text-left"
                      >
                        {media.originalFileName ?? media.id}
                      </button>
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {media.status === 'ARCHIVED'
                        ? 'ARCHIVED - chỉ còn thumbnail'
                        : (media.mimeType ?? media.status)}
                    </p>
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
                  <div className="flex flex-col gap-2 lg:items-end">
                    <SecondaryButton
                      disabled={
                        !canRenameMedia ||
                        renamingMediaId === media.id ||
                        deletingMediaId === media.id ||
                        deletingMultiple
                      }
                      onClick={() => void handleRenameMedia(media)}
                    >
                      {renamingMediaId === media.id ? 'Đang đổi...' : 'Đổi tên'}
                    </SecondaryButton>
                    {canRegenerateThumbnail ? (
                      <SecondaryButton
                        disabled={
                          regeneratingMediaId === media.id ||
                          deletingMediaId === media.id ||
                          deletingMultiple
                        }
                        onClick={() => void handleRegenerateThumbnail(media)}
                      >
                        {regeneratingMediaId === media.id ? 'Đang tạo...' : 'Tạo thumbnail'}
                      </SecondaryButton>
                    ) : null}
                    <SecondaryButton
                      disabled={!isDeletable || deletingMediaId === media.id || deletingMultiple}
                      onClick={() => void handleDeleteMedia(media)}
                    >
                      {deletingMediaId === media.id
                        ? 'Đang xử lý...'
                        : isArchive
                          ? 'Dọn dẹp'
                          : 'Xoá'}
                    </SecondaryButton>
                  </div>
                </div>
              );
            })}
            {mediaItems.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-600">Chưa có media nào khớp filter.</p>
            ) : null}
          </div>

          <MediaPager
            currentPage={mediaCursorStack.length + 1}
            hasNext={mediaNextCursor !== null}
            hasPrevious={mediaCursorStack.length > 0}
            loading={mediaLoading}
            onNext={goToNextMediaPage}
            onPrevious={goToPreviousMediaPage}
          />
        </section>
      ) : null}

      {activeSection === 'audit' && canViewAudit ? (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Audit log</h2>
              <p className="mt-1 text-sm text-slate-600">
                Theo dõi ai đã thay đổi workspace, bài viết, media, proxy và thành viên.
              </p>
            </div>
            <SecondaryButton disabled={auditLoading} onClick={() => void loadAuditLogs()}>
              <RefreshCw className={`mr-2 h-4 w-4 ${auditLoading ? 'animate-spin' : ''}`} />
              Làm mới
            </SecondaryButton>
          </div>

          <div className="grid gap-3 p-5 md:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="space-y-3">
              <div className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs font-medium uppercase text-slate-500">Tổng log đang xem</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{auditLogs.length}</p>
                <p className="mt-1 text-sm text-slate-600">100 log mới nhất</p>
              </div>
              {auditSummary.length > 0 ? (
                <div className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium uppercase text-slate-500">Loại hay gặp</p>
                  <div className="mt-3 space-y-2">
                    {auditSummary.map((item) => (
                      <div key={item.action} className="flex items-center justify-between gap-3">
                        <span className="truncate text-xs font-semibold text-slate-700">
                          {formatAuditAction(item.action)}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                          {item.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </aside>

            <div className="max-h-[640px] overflow-y-auto rounded-lg border border-slate-200">
              {auditLogs.map((log) => (
                <AuditLogRow key={log.id} log={log} />
              ))}
              {auditLogs.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-600">
                  {auditLoading ? 'Đang tải audit log...' : 'Chưa có audit log.'}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {previewMedia && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-6"
          onClick={() => setPreviewMedia(null)}
        >
          <div
            className="relative w-full max-w-4xl rounded-lg bg-black shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute top-4 right-4 z-10 flex gap-2">
              <a
                href={previewMedia.readUrl ?? previewMedia.displayUrl ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="rounded-full bg-slate-900/60 p-2 text-white hover:bg-slate-900 transition"
                title="Mở trong tab mới"
              >
                Mở
              </a>
              <button
                type="button"
                onClick={() => setPreviewMedia(null)}
                className="rounded-full bg-slate-900/60 p-2 text-white hover:bg-slate-900 transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center justify-center min-h-[300px] max-h-[80vh] overflow-hidden">
              {previewMedia.type === 'VIDEO' ? (
                <video
                  src={previewMedia.readUrl ?? previewMedia.displayUrl ?? undefined}
                  controls
                  className="max-h-[80vh] max-w-full"
                  autoPlay
                />
              ) : (
                <img
                  src={previewMedia.readUrl ?? previewMedia.displayUrl ?? undefined}
                  alt={previewMedia.originalFileName ?? 'media'}
                  className="max-h-[80vh] max-w-full object-contain"
                />
              )}
            </div>
            <div className="p-4 text-center text-sm font-medium text-slate-300">
              {previewMedia.originalFileName ?? previewMedia.id}
            </div>
          </div>
        </div>
      )}
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

function MediaPager({
  currentPage,
  hasPrevious,
  hasNext,
  loading,
  onPrevious,
  onNext,
}: {
  currentPage: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-3">
      <p className="text-sm font-semibold text-slate-700">Trang {currentPage}</p>
      <div className="flex items-center gap-2">
        <SecondaryButton disabled={loading || !hasPrevious} onClick={onPrevious}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          Trước
        </SecondaryButton>
        <SecondaryButton disabled={loading || !hasNext} onClick={onNext}>
          Sau
          <ChevronRight className="ml-1 h-4 w-4" />
        </SecondaryButton>
      </div>
    </div>
  );
}

function AuditLogRow({ log }: { log: AuditLogItem }) {
  const detail = compactAuditDetail(log);

  return (
    <article className="border-b border-slate-200 px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-950 px-2.5 py-1 text-xs font-semibold text-white">
              {formatAuditAction(log.action)}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              {log.resourceType ?? 'SYSTEM'}
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-semibold text-slate-950">
            {log.resourceId ?? 'Không có resource id'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Actor: {log.actorUserId ?? 'system'} · IP: {log.actorIp ?? '-'}
          </p>
        </div>
        <p className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-slate-500">
          <Clock className="h-3.5 w-3.5" />
          {new Date(log.createdAt).toLocaleString('vi-VN')}
        </p>
      </div>

      {detail ? (
        <details className="mt-3 rounded-md border border-slate-200 bg-slate-50">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">
            Chi tiết thay đổi
          </summary>
          <pre className="max-h-72 overflow-auto border-t border-slate-200 px-3 py-2 text-xs leading-relaxed text-slate-700">
            {detail}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function compactAuditDetail(log: AuditLogItem): string | null {
  const payload = removeEmptyFields({
    before: log.before,
    after: log.after,
    metadata: log.metadata,
    requestId: log.requestId,
    actorUserAgent: log.actorUserAgent,
  });

  if (Object.keys(payload).length === 0) return null;
  return JSON.stringify(payload, null, 2);
}

function removeEmptyFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
  );
}

function formatAuditAction(action: string): string {
  return action
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
