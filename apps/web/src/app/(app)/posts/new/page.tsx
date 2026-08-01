'use client';

import { hasPermission, PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from '@/components/form-controls';
import { MediaPreview } from '@/components/media-preview';
import { PlatformComposerPanels } from '@/components/platform-composer-panels';
import { useToast } from '@/components/toast-provider';
import { mediaApi, postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  isPlatformOverrideActive,
  platformOverrideDefaults,
  platformOptions,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import { validatePostComposer } from '@/lib/post-validation';
import type { MediaAssetView, SocialAccountView, StorageUsageView } from '@/lib/types';

export default function NewPostPage() {
  const auth = useAuth();
  const toast = useToast();
  const router = useRouter();
  const workspace = auth.activeWorkspace;
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [platformOverrides, setPlatformOverrides] = useState<Record<string, PlatformOverrideDraft>>(
    {},
  );
  const [mediaAssets, setMediaAssets] = useState<Array<MediaAssetView & { previewUrl?: string }>>(
    [],
  );
  const [storageUsage, setStorageUsage] = useState<StorageUsageView | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'publish' | 'schedule' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    socialAccountsApi
      .list(workspace.id)
      .then((result) => setAccounts(result.items.filter((item) => item.status === 'CONNECTED')))
      .catch((loadError) => setError(getErrorMessage(loadError)));

    mediaApi
      .usage(workspace.id)
      .then((usage) => setStorageUsage(usage))
      .catch(() => setStorageUsage(null));
  }, [workspace]);

  const groupedAccounts = useMemo(() => {
    const groups = new Map<Platform, SocialAccountView[]>();
    for (const account of accounts) {
      const items = groups.get(account.platform) ?? [];
      items.push(account);
      groups.set(account.platform, items);
    }
    return [...groups.entries()];
  }, [accounts]);

  const selectedAccounts = useMemo(
    () => accounts.filter((account) => selectedIds.includes(account.id)),
    [accounts, selectedIds],
  );

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const canCreate = hasPermission(workspace.role, 'post:create');
  const canPublish = hasPermission(workspace.role, 'post:publish');
  const canSchedule = hasPermission(workspace.role, 'post:schedule');

  function toggleAccount(accountId: string) {
    setSelectedIds((current) =>
      current.includes(accountId)
        ? current.filter((item) => item !== accountId)
        : [...current, accountId],
    );
  }

  function overrideFor(account: SocialAccountView): PlatformOverrideDraft {
    return (
      platformOverrides[account.id] ?? platformOverrideDefaults(account.platform, account.scopes)
    );
  }

  function updateOverride(accountId: string, patch: Partial<PlatformOverrideDraft>): void {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    setPlatformOverrides((current) => ({
      ...current,
      [accountId]: {
        ...(current[accountId] ?? platformOverrideDefaults(account.platform, account.scopes)),
        customized: patch.customized ?? true,
        ...patch,
      },
    }));
  }

  async function createDraft() {
    if (!workspace) return;
    const validationError = validateForm(false, false);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (scheduledAt) {
      setError(
        'Bạn đã chọn thời gian đăng. Bấm "Lên lịch" để đưa bài vào Calendar, hoặc xóa thời gian để lưu draft.',
      );
      return;
    }
    setBusy('draft');
    setError(null);
    try {
      const post = await postsApi.create(workspace.id, payload());
      router.push(`/posts?created=${post.id}`);
    } catch (createError) {
      toast.error(getErrorMessage(createError));
    } finally {
      setBusy(null);
    }
  }

  async function publishNow() {
    if (!workspace) return;
    const validationError = validateForm(true, true);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy('publish');
    setError(null);
    try {
      const post = await postsApi.create(workspace.id, payload());
      await postsApi.publish(workspace.id, post.id, selectedIds);
      router.push(`/posts?queued=${post.id}`);
    } catch (publishError) {
      toast.error(getErrorMessage(publishError));
    } finally {
      setBusy(null);
    }
  }

  async function schedule() {
    if (!workspace) return;
    const validationError = validateForm(true, true);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy('schedule');
    setError(null);
    try {
      const post = await postsApi.create(workspace.id, {
        ...payload(),
        scheduledAt: new Date(scheduledAt).toISOString(),
      });
      router.push(`/calendar?scheduled=${post.id}`);
    } catch (scheduleError) {
      toast.error(getErrorMessage(scheduleError));
    } finally {
      setBusy(null);
    }
  }

  function payload() {
    const platformOverridePayload = buildPlatformOverridePayload();
    return {
      title: title.trim() || undefined,
      body: body.trim() || undefined,
      linkUrl: linkUrl.trim() || undefined,
      hashtags: hashtags
        .split(/[,\s]+/)
        .map((item) => item.replace(/^#/, '').trim())
        .filter(Boolean),
      socialAccountIds: selectedIds,
      mediaAssetIds: mediaAssets.map((item) => item.id),
      platformOverrides: platformOverridePayload,
    };
  }

  function validateForm(requireTargets: boolean, requirePublishableContent: boolean) {
    return validatePostComposer({
      title,
      body,
      linkUrl,
      selectedAccounts,
      mediaAssets,
      platformOverrides: buildValidationOverrides(),
      requireTargets,
      requirePublishableContent,
    });
  }

  function buildValidationOverrides() {
    return selectedAccounts
      .map((account) => {
        const draft = overrideFor(account);
        if (!isPlatformOverrideActive(account.platform, draft)) return null;
        const selectedMedia =
          draft.mediaAssetIds.length > 0
            ? mediaAssets.filter((asset) => draft.mediaAssetIds.includes(asset.id))
            : undefined;
        return {
          socialAccountId: account.id,
          title: draft.title.trim() || undefined,
          caption: draft.caption.trim() || undefined,
          linkUrl: draft.linkUrl.trim() || undefined,
          mediaAssets: selectedMedia,
          options: platformOptions(account.platform, draft),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  function buildPlatformOverridePayload() {
    return selectedAccounts
      .map((account) => {
        const draft = overrideFor(account);
        if (!isPlatformOverrideActive(account.platform, draft)) return null;
        const options = platformOptions(account.platform, draft);
        return {
          socialAccountId: account.id,
          title: draft.title.trim() || undefined,
          caption: draft.caption.trim() || undefined,
          description: draft.description.trim() || undefined,
          linkUrl: draft.linkUrl.trim() || undefined,
          mediaAssetIds: draft.mediaAssetIds.length > 0 ? draft.mediaAssetIds : undefined,
          options,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .filter(
        (item) =>
          item.title ||
          item.caption ||
          item.description ||
          item.linkUrl ||
          item.mediaAssetIds ||
          item.options,
      );
  }

  async function uploadMedia(files: FileList | null) {
    if (!workspace || !files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded: Array<MediaAssetView & { previewUrl?: string }> = [];
      const processingIds: string[] = [];
      for (const file of Array.from(files)) {
        const request = await mediaApi.createUpload(workspace.id, {
          fileName: file.name,
          sizeBytes: file.size,
          declaredMimeType: file.type || 'application/octet-stream',
        });
        let uploadedDirectly = false;
        try {
          uploadedDirectly = await uploadDirectly(request.uploadUrl, file);
        } catch {
          uploadedDirectly = false;
        }
        if (!uploadedDirectly) {
          await mediaApi.uploadObject(workspace.id, request.mediaAsset.id, file);
        }
        const confirmed = await mediaApi.confirmUpload(workspace.id, request.mediaAsset.id);
        uploaded.push({
          ...confirmed,
          previewUrl: URL.createObjectURL(file),
        });
        if (confirmed.status === 'PROCESSING') {
          processingIds.push(confirmed.id);
        }
      }
      setMediaAssets((current) => [...current, ...uploaded].slice(0, 10));
      if (workspace) {
        mediaApi
          .usage(workspace.id)
          .then((usage) => setStorageUsage(usage))
          .catch(() => undefined);
      }
      toast.success(`Đã upload ${uploaded.length} media.`);
      if (processingIds.length > 0) {
        toast.info('Video đang xử lý thumbnail. Bạn có thể tiếp tục soạn bài.');
        for (const mediaAssetId of processingIds) {
          void pollMediaStatus(mediaAssetId);
        }
      }
    } catch (uploadError) {
      toast.error(getErrorMessage(uploadError));
    } finally {
      setUploading(false);
    }
  }

  async function uploadDirectly(uploadUrl: string, file: File): Promise<boolean> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      signal: AbortSignal.timeout(120_000),
    });
    return response.ok;
  }

  async function pollMediaStatus(mediaAssetId: string) {
    if (!workspace) return;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(2000);
      try {
        const refreshed = await mediaApi.get(workspace.id, mediaAssetId);
        setMediaAssets((current) =>
          current.map((item) =>
            item.id === mediaAssetId ? { ...refreshed, previewUrl: item.previewUrl } : item,
          ),
        );
        if (refreshed.status === 'READY') {
          toast.success('Thumbnail video đã sẵn sàng.');
          return;
        }
        if (refreshed.status === 'FAILED') {
          toast.error('Xử lý video thất bại. Hãy thử upload lại file khác.');
          return;
        }
      } catch (pollError) {
        if (attempt >= 2) {
          toast.error(getErrorMessage(pollError));
          return;
        }
      }
    }

    toast.warning('Video vẫn đang xử lý. Làm mới trang sau ít phút nếu chưa thấy thumbnail.');
  }

  function sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function removeMedia(mediaAssetId: string) {
    setMediaAssets((current) => current.filter((item) => item.id !== mediaAssetId));
    setPlatformOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).map(([accountId, draft]) => [
          accountId,
          {
            ...draft,
            mediaAssetIds: draft.mediaAssetIds.filter((id) => id !== mediaAssetId),
          },
        ]),
      ),
    );
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-slate-950">Tạo bài đăng</h1>
          <p className="mt-1 text-sm text-slate-600">
            Soạn nội dung chung một lần, sau đó tùy chỉnh riêng cho từng nền tảng khi cần.
          </p>
        </header>

        <InlineError message={error} />

        <div className="space-y-5 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-950">Nội dung chung</h2>
              <p className="mt-1 text-sm text-slate-500">
                Mọi target sẽ dùng phần này nếu không bật tùy chỉnh riêng.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              {selectedIds.length} tài khoản đã chọn
            </span>
          </div>

          <Field label="Tiêu đề nội bộ">
            <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>

          <Field label="Nội dung">
            <textarea
              className="min-h-48 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Link">
              <TextInput
                placeholder="https://..."
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
              />
            </Field>
            <Field label="Hashtags">
              <TextInput
                placeholder="campaign, launch"
                value={hashtags}
                onChange={(event) => setHashtags(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Lên lịch">
            <TextInput
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
            {scheduledAt ? (
              <p className="mt-1 text-xs text-slate-500">
                Bấm "Lên lịch" để lưu bài vào Calendar. "Lưu draft" sẽ không tự lên lịch.
              </p>
            ) : null}
          </Field>

          <Field label="Media">
            <StorageHint usage={storageUsage} uploading={uploading} />
            <input
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
              className="mt-3 block w-full text-sm text-slate-700 file:mr-3 file:h-10 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:text-sm file:font-medium file:text-slate-700"
              disabled={uploading}
              multiple
              type="file"
              onChange={(event) => void uploadMedia(event.target.files)}
            />
          </Field>
          {uploading ? <p className="text-sm text-slate-600">Đang upload media...</p> : null}
          {mediaAssets.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {mediaAssets.map((asset) => (
                <div key={asset.id} className="rounded-md border border-slate-200 p-3">
                  <MediaPreview asset={asset} />
                  <p className="mt-2 truncate text-sm font-medium text-slate-900">
                    {asset.originalFileName ?? asset.id}
                  </p>
                  <p className="text-xs text-slate-500">
                    {asset.mimeType ?? asset.type} · {asset.status}
                  </p>
                  <SecondaryButton
                    className="mt-2 w-full"
                    onClick={() => removeMedia(asset.id)}
                    type="button"
                  >
                    Gỡ khỏi draft
                  </SecondaryButton>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <PlatformComposerPanels
          accounts={selectedAccounts}
          common={{ title, body, linkUrl }}
          drafts={platformOverrides}
          mediaAssets={mediaAssets}
          workspaceId={workspace.id}
          onChange={updateOverride}
        />
      </section>

      <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-950">Kênh publish</h2>
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
              {selectedIds.length}/{accounts.length}
            </span>
          </div>
          <div className="mt-3 space-y-3">
            {groupedAccounts.map(([platform, items]) => (
              <div key={platform}>
                <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
                  {PLATFORM_LABELS[platform]}
                </p>
                <div className="space-y-2">
                  {items.map((account) => (
                    <label
                      key={account.id}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition ${
                        selectedIds.includes(account.id)
                          ? 'border-brand-300 bg-brand-50'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        checked={selectedIds.includes(account.id)}
                        className="mt-1"
                        type="checkbox"
                        onChange={() => toggleAccount(account.id)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">
                          {account.name}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {account.username ?? account.id}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {accounts.length === 0 ? (
              <p className="text-sm text-slate-600">Chưa có social account nào đã kết nối.</p>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-950">Bản xem nhanh</h2>
          <div className="mt-3 rounded-md border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">{title || 'Untitled post'}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
              {body || 'Nội dung bài đăng sẽ hiện ở đây.'}
            </p>
            {hashtags ? (
              <p className="mt-3 text-sm text-brand-700">
                {payload()
                  .hashtags.map((item) => `#${item}`)
                  .join(' ')}
              </p>
            ) : null}
            {mediaAssets.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {mediaAssets.map((asset) => (
                  <MediaPreview key={asset.id} asset={asset} className="max-h-48" />
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <div className="grid gap-2">
          <SecondaryButton
            disabled={!canCreate || busy !== null}
            onClick={createDraft}
            type="button"
          >
            Lưu draft
          </SecondaryButton>
          <PrimaryButton
            busy={busy === 'publish'}
            disabled={!canPublish || selectedIds.length === 0}
            onClick={publishNow}
            type="button"
          >
            Publish ngay
          </PrimaryButton>
          <SecondaryButton
            disabled={!canSchedule || selectedIds.length === 0 || !scheduledAt || busy !== null}
            onClick={schedule}
            type="button"
          >
            Lên lịch
          </SecondaryButton>
        </div>
      </aside>
    </div>
  );
}

function StorageHint({ usage, uploading }: { usage: StorageUsageView | null; uploading: boolean }) {
  if (!usage) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Đang kiểm tra dung lượng VPS...
      </div>
    );
  }

  const availablePercent =
    usage.disk.totalBytes > 0 ? (usage.disk.availableBytes / usage.disk.totalBytes) * 100 : 0;
  const isLow = usage.disk.availableBytes < 2 * 1024 ** 3 || availablePercent < 10;
  const isVeryLow = usage.disk.availableBytes < 1 * 1024 ** 3 || availablePercent < 5;
  const tone = isVeryLow
    ? 'border-red-200 bg-red-50 text-red-800'
    : isLow
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  const barTone = isVeryLow ? 'bg-red-500' : isLow ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className={`rounded-md border px-3 py-3 ${tone}`}>
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase opacity-75">Còn trống</p>
          <p className="mt-0.5 font-semibold">{formatBytes(usage.disk.availableBytes)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase opacity-75">Media workspace</p>
          <p className="mt-0.5 font-semibold">{formatBytes(usage.media.totalBytes)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase opacity-75">
            {uploading ? 'Đang upload' : 'Ổ đĩa đã dùng'}
          </p>
          <p className="mt-0.5 font-semibold">{usage.disk.usedPercent.toFixed(1)}%</p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/70">
        <div
          className={`h-full rounded-full ${barTone}`}
          style={{ width: `${Math.min(Math.max(usage.disk.usedPercent, 0), 100)}%` }}
        />
      </div>
      {isLow ? (
        <p className="mt-2 text-xs">
          Dung lượng VPS thấp. Nên dọn media cũ trong Settings trước khi upload video lớn.
        </p>
      ) : null}
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
