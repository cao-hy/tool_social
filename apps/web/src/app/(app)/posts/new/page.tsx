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
import { mediaApi, postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  EMPTY_PLATFORM_OVERRIDE,
  platformOptions,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import { validatePostComposer } from '@/lib/post-validation';
import type { MediaAssetView, SocialAccountView } from '@/lib/types';

export default function NewPostPage() {
  const auth = useAuth();
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
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'publish' | 'schedule' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    socialAccountsApi
      .list(workspace.id)
      .then((result) => setAccounts(result.items.filter((item) => item.status === 'CONNECTED')))
      .catch((loadError) => setError(getErrorMessage(loadError)));
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

  function overrideFor(accountId: string): PlatformOverrideDraft {
    return platformOverrides[accountId] ?? EMPTY_PLATFORM_OVERRIDE;
  }

  function updateOverride(accountId: string, patch: Partial<PlatformOverrideDraft>): void {
    setPlatformOverrides((current) => ({
      ...current,
      [accountId]: { ...EMPTY_PLATFORM_OVERRIDE, ...current[accountId], ...patch },
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
      setError(getErrorMessage(createError));
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
      setError(getErrorMessage(publishError));
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
      setError(getErrorMessage(scheduleError));
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
    return selectedAccounts.map((account) => {
      const draft = overrideFor(account.id);
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
      };
    });
  }

  function buildPlatformOverridePayload() {
    return selectedAccounts
      .map((account) => {
        const draft = overrideFor(account.id);
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
      for (const file of Array.from(files)) {
        const request = await mediaApi.createUpload(workspace.id, {
          fileName: file.name,
          sizeBytes: file.size,
          declaredMimeType: file.type || 'application/octet-stream',
        });
        let uploadedDirectly = false;
        try {
          const uploadResponse = await fetch(request.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          });
          uploadedDirectly = uploadResponse.ok;
        } catch {
          uploadedDirectly = false;
        }
        if (!uploadedDirectly) {
          await mediaApi.uploadObject(workspace.id, request.mediaAsset.id, file);
        }
        const confirmed = await mediaApi.confirmUpload(workspace.id, request.mediaAsset.id);
        uploaded.push({ ...confirmed, previewUrl: URL.createObjectURL(file) });
      }
      setMediaAssets((current) => [...current, ...uploaded].slice(0, 10));
    } catch (uploadError) {
      setError(getErrorMessage(uploadError));
    } finally {
      setUploading(false);
    }
  }

  function removeMedia(mediaAssetId: string) {
    setMediaAssets((current) => current.filter((item) => item.id !== mediaAssetId));
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 xl:grid-cols-[1fr_360px]">
      <section className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-slate-950">Create Post</h1>
          <p className="mt-1 text-sm text-slate-600">
            Soạn nội dung, chọn tài khoản, rồi publish ngay hoặc đưa vào lịch.
          </p>
        </header>

        <InlineError message={error} />

        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
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
            <input
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
              className="block w-full text-sm text-slate-700 file:mr-3 file:h-10 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:text-sm file:font-medium file:text-slate-700"
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
          drafts={platformOverrides}
          mediaAssets={mediaAssets}
          onChange={updateOverride}
        />
      </section>

      <aside className="space-y-4">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-950">Tài khoản publish</h2>
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
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
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
          <h2 className="text-sm font-semibold text-slate-950">Preview</h2>
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
