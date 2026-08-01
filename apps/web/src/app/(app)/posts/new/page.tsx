'use client';

import {
  hasPermission,
  normalizeOptionalSocialText,
  splitAndNormalizeHashtags,
  PLATFORM_LABELS,
  type Platform,
} from '@socialhub/shared';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
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
  platformOverrideFromCommon,
  platformOptions,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import { validatePostComposer } from '@/lib/post-validation';
import {
  buildSchedulePreview,
  zonedDateTimeLocalToUtcIso,
  type SchedulePreview,
} from '@/lib/schedule-time';
import type {
  MediaAssetView,
  MediaLibraryItem,
  SocialAccountView,
  StorageUsageView,
} from '@/lib/types';

const MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024;
const MULTIPART_UPLOAD_THRESHOLD_BYTES = 16 * 1024 * 1024;

type UploadStage = 'creating' | 'uploading' | 'confirming' | 'processing' | 'done' | 'failed';

interface UploadProgressItem {
  id: string;
  fileName: string;
  loadedBytes: number;
  totalBytes: number;
  stage: UploadStage;
  via: 'direct' | 'multipart' | 'api-fallback' | null;
}

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
  const [mediaMode, setMediaMode] = useState<'upload' | 'library'>('upload');
  const [libraryItems, setLibraryItems] = useState<MediaLibraryItem[]>([]);
  const [libraryCursorStack, setLibraryCursorStack] = useState<string[]>([]);
  const [libraryNextCursor, setLibraryNextCursor] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryType, setLibraryType] = useState('');
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsageView | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressItem[]>([]);
  const [busy, setBusy] = useState<'draft' | 'publish' | 'schedule' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

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
    void loadMediaLibrary();
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

  const schedulePreview = useMemo(() => {
    if (!workspace || !scheduledAt) return null;
    try {
      return buildSchedulePreview(scheduledAt, workspace.timezone);
    } catch {
      return null;
    }
  }, [scheduledAt, workspace]);

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

    setPlatformOverrides((current) => {
      const existing = current[accountId];
      const shouldSeedFromCommon = patch.customized === true && !existing?.customized;
      const base = shouldSeedFromCommon
        ? platformOverrideFromCommon(account.platform, account.scopes, {
            title,
            body,
            linkUrl,
            mediaAssetIds: mediaAssets.map((item) => item.id),
          })
        : (existing ?? platformOverrideDefaults(account.platform, account.scopes));

      return {
        ...current,
        [accountId]: {
          ...base,
          customized: patch.customized ?? true,
          ...patch,
        },
      };
    });
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
        scheduledAt: zonedDateTimeLocalToUtcIso(scheduledAt, workspace.timezone),
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
      title: normalizeOptionalSocialText(title),
      body: normalizeOptionalSocialText(body),
      linkUrl: linkUrl.trim() || undefined,
      hashtags: splitAndNormalizeHashtags(hashtags),
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
          title: normalizeOptionalSocialText(draft.title),
          caption: normalizeOptionalSocialText(draft.caption),
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
          title: normalizeOptionalSocialText(draft.title),
          caption: normalizeOptionalSocialText(draft.caption),
          description: normalizeOptionalSocialText(draft.description),
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
    const fileList = Array.from(files);
    const oversizedFile = fileList.find((file) => file.size > MAX_MEDIA_UPLOAD_BYTES);
    if (oversizedFile) {
      toast.error(
        `${oversizedFile.name} vượt giới hạn ${formatBytes(MAX_MEDIA_UPLOAD_BYTES)}. Nén file trước khi upload.`,
      );
      return;
    }

    setUploading(true);
    setUploadProgress([]);
    setError(null);
    try {
      const uploaded: Array<MediaAssetView & { previewUrl?: string }> = [];
      const processingIds: string[] = [];
      for (const file of fileList) {
        const uploadId = createUploadProgressId(file);
        upsertUploadProgress({
          id: uploadId,
          fileName: file.name,
          loadedBytes: 0,
          totalBytes: file.size,
          stage: 'creating',
          via: null,
        });
        try {
          const confirmed = shouldUseMultipartUpload(file)
            ? await uploadMultipartFile(workspace.id, file, uploadId)
            : await uploadSmallFile(workspace.id, file, uploadId);
          uploaded.push({
            ...confirmed,
            previewUrl: URL.createObjectURL(file),
          });
          updateUploadProgress(uploadId, {
            loadedBytes: file.size,
            stage: confirmed.status === 'PROCESSING' ? 'processing' : 'done',
            totalBytes: file.size,
          });
          if (confirmed.status === 'PROCESSING') {
            processingIds.push(confirmed.id);
          }
        } catch (fileUploadError) {
          updateUploadProgress(uploadId, { stage: 'failed' });
          throw fileUploadError;
        }
      }
      setMediaAssets((current) => [...current, ...uploaded].slice(0, 10));
      if (workspace) {
        void refreshStorageUsage();
        setLibraryCursorStack([]);
        void loadMediaLibrary();
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

  function upsertUploadProgress(next: UploadProgressItem) {
    setUploadProgress((current) => {
      const existing = current.findIndex((item) => item.id === next.id);
      if (existing === -1) return [...current, next];
      return current.map((item) => (item.id === next.id ? next : item));
    });
  }

  function updateUploadProgress(id: string, patch: Partial<UploadProgressItem>) {
    setUploadProgress((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function uploadSmallFile(
    workspaceId: string,
    file: File,
    uploadProgressId: string,
  ): Promise<MediaAssetView> {
    const request = await mediaApi.createUpload(workspaceId, {
      fileName: file.name,
      sizeBytes: file.size,
      declaredMimeType: file.type || 'application/octet-stream',
    });

    updateUploadProgress(uploadProgressId, { stage: 'uploading', via: 'direct' });
    try {
      await uploadDirectly(request.uploadUrl, file, (loadedBytes, totalBytes) => {
        updateUploadProgress(uploadProgressId, { loadedBytes, totalBytes });
      });
    } catch (directUploadError) {
      if (!shouldUseApiUploadFallback(request.uploadUrl)) {
        throw directUploadError;
      }
      updateUploadProgress(uploadProgressId, {
        loadedBytes: 0,
        stage: 'uploading',
        totalBytes: file.size,
        via: 'api-fallback',
      });
      await mediaApi.uploadObject(workspaceId, request.mediaAsset.id, file);
      updateUploadProgress(uploadProgressId, { loadedBytes: file.size, totalBytes: file.size });
    }

    updateUploadProgress(uploadProgressId, { stage: 'confirming' });
    return mediaApi.confirmUpload(workspaceId, request.mediaAsset.id);
  }

  async function uploadMultipartFile(
    workspaceId: string,
    file: File,
    uploadProgressId: string,
  ): Promise<MediaAssetView> {
    const request = await mediaApi.createMultipartUpload(workspaceId, {
      fileName: file.name,
      sizeBytes: file.size,
      declaredMimeType: file.type || 'application/octet-stream',
    });
    const loadedByPart = new Map<number, number>();

    updateUploadProgress(uploadProgressId, {
      loadedBytes: 0,
      stage: 'uploading',
      totalBytes: file.size,
      via: 'multipart',
    });

    try {
      const completedParts = await uploadMultipartParts({
        file,
        partSizeBytes: request.partSizeBytes,
        parts: request.parts,
        onPartProgress: (partNumber, loadedBytes) => {
          loadedByPart.set(partNumber, loadedBytes);
          updateUploadProgress(uploadProgressId, {
            loadedBytes: Math.min(sumLoadedParts(loadedByPart), file.size),
            totalBytes: file.size,
          });
        },
      });

      updateUploadProgress(uploadProgressId, {
        loadedBytes: file.size,
        stage: 'confirming',
        totalBytes: file.size,
      });
      return await mediaApi.completeMultipartUpload(workspaceId, request.mediaAsset.id, {
        uploadId: request.uploadId,
        parts: completedParts,
      });
    } catch (multipartError) {
      await mediaApi
        .abortMultipartUpload(workspaceId, request.mediaAsset.id, { uploadId: request.uploadId })
        .catch(() => undefined);
      throw multipartError;
    }
  }

  function uploadDirectly(
    uploadUrl: string,
    file: File,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    return uploadPut(uploadUrl, file, {
      contentType: file.type || 'application/octet-stream',
      onProgress,
    }).then(() => undefined);
  }

  async function pollMediaStatus(mediaAssetId: string) {
    if (!workspace) return;

    for (let attempt = 0; attempt < 90; attempt += 1) {
      await sleep(2000);
      try {
        const refreshed = await mediaApi.get(workspace.id, mediaAssetId);
        setMediaAssets((current) =>
          current.map((item) =>
            item.id === mediaAssetId ? { ...refreshed, previewUrl: item.previewUrl } : item,
          ),
        );
        if (refreshed.status === 'READY') {
          const refreshedFileName = refreshed.originalFileName;
          setUploadProgress((current) =>
            current.map((item) =>
              item.fileName === refreshedFileName ? { ...item, stage: 'done' } : item,
            ),
          );
          toast.success('Thumbnail video đã sẵn sàng.');
          return;
        }
        if (refreshed.status === 'FAILED') {
          const refreshedFileName = refreshed.originalFileName;
          setUploadProgress((current) =>
            current.map((item) =>
              item.fileName === refreshedFileName ? { ...item, stage: 'failed' } : item,
            ),
          );
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

    setUploadProgress((current) =>
      current.map((item) => (item.stage === 'processing' ? { ...item, stage: 'done' } : item)),
    );
    toast.warning('Video vẫn đang xử lý nền. Làm mới trang sau ít phút nếu chưa thấy thumbnail.');
  }

  function sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function refreshStorageUsage() {
    if (!workspace) return;
    try {
      setStorageUsage(await mediaApi.usage(workspace.id));
    } catch {
      setStorageUsage(null);
    }
  }

  async function loadMediaLibrary(cursor?: string) {
    if (!workspace) return;
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const response = await mediaApi.list(workspace.id, {
        limit: 12,
        cursor,
        q: libraryQuery.trim() || undefined,
        type: libraryType || undefined,
        status: 'READY',
      });
      setLibraryItems(response.items);
      setLibraryNextCursor(response.nextCursor);
    } catch (loadError) {
      setLibraryError(getErrorMessage(loadError));
    } finally {
      setLibraryLoading(false);
    }
  }

  function refreshMediaLibrary() {
    setLibraryCursorStack([]);
    void loadMediaLibrary();
  }

  function goToPreviousMediaPage() {
    const previousStack = libraryCursorStack.slice(0, -1);
    setLibraryCursorStack(previousStack);
    void loadMediaLibrary(previousStack.at(-1));
  }

  function goToNextMediaPage() {
    if (!libraryNextCursor) return;
    setLibraryCursorStack((current) => [...current, libraryNextCursor]);
    void loadMediaLibrary(libraryNextCursor);
  }

  function addMediaFromLibrary(asset: MediaLibraryItem) {
    if (mediaAssets.some((item) => item.id === asset.id)) {
      toast.info('Media này đã có trong draft.');
      return;
    }
    if (mediaAssets.length >= 10) {
      toast.warning('Mỗi draft hiện tối đa 10 media.');
      return;
    }
    setMediaAssets((current) => [...current, asset]);
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

        <div className="space-y-5 rounded-lg border border-sky-200 bg-sky-50/40 p-5">
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
            <Field label="Link đích">
              <TextInput
                placeholder="https://..."
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                URL đính kèm khi nền tảng hỗ trợ link/CTA. Đây không phải URL media.
              </p>
            </Field>
            <Field label="Hashtags">
              <TextInput
                placeholder="campaign, launch"
                value={hashtags}
                onChange={(event) => setHashtags(event.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Nhập cách nhau bằng dấu phẩy hoặc khoảng trắng. Nền tảng dùng hashtag trong mô tả sẽ
                được hệ thống tự gắn khi publish.
              </p>
            </Field>
          </div>

          <Field label="Lên lịch">
            <TextInput
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
            {schedulePreview ? <ScheduleTimePreview preview={schedulePreview} /> : null}
          </Field>

          <Field label="Media">
            <StorageHint usage={storageUsage} uploading={uploading} />
            <div className="mt-3 inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
              <button
                className={`h-9 rounded px-3 text-sm font-semibold transition ${
                  mediaMode === 'upload'
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-slate-600 hover:text-slate-950'
                }`}
                type="button"
                onClick={() => setMediaMode('upload')}
              >
                Upload mới
              </button>
              <button
                className={`h-9 rounded px-3 text-sm font-semibold transition ${
                  mediaMode === 'library'
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-slate-600 hover:text-slate-950'
                }`}
                type="button"
                onClick={() => {
                  setMediaMode('library');
                  if (libraryItems.length === 0) void loadMediaLibrary();
                }}
              >
                Chọn từ server
              </button>
            </div>

            {mediaMode === 'upload' ? (
              <input
                accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
                className="mt-3 block w-full text-sm text-slate-700 file:mr-3 file:h-10 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:text-sm file:font-medium file:text-slate-700"
                disabled={uploading}
                multiple
                type="file"
                onChange={(event) => void uploadMedia(event.target.files)}
              />
            ) : (
              <MediaLibraryPicker
                items={libraryItems}
                loading={libraryLoading}
                hasNext={libraryNextCursor !== null}
                hasPrevious={libraryCursorStack.length > 0}
                error={libraryError}
                page={libraryCursorStack.length + 1}
                query={libraryQuery}
                selectedIds={mediaAssets.map((asset) => asset.id)}
                type={libraryType}
                onAdd={addMediaFromLibrary}
                onNext={goToNextMediaPage}
                onPrevious={goToPreviousMediaPage}
                onQueryChange={setLibraryQuery}
                onRefresh={refreshMediaLibrary}
                onTypeChange={setLibraryType}
              />
            )}
          </Field>
          {uploading ? <p className="text-sm text-slate-600">Đang upload media...</p> : null}
          <UploadProgressList items={uploadProgress} />
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
          common={{ title, body, linkUrl, hashtags }}
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

        <section className="rounded-lg border border-slate-200 bg-white flex flex-col xl:max-h-[calc(100vh-24rem)] overflow-hidden">
          <button
            type="button"
            className="flex items-center justify-between p-4 focus:outline-none"
            onClick={() => setShowPreview(!showPreview)}
          >
            <h2 className="text-sm font-semibold text-slate-950 shrink-0">Bản xem nhanh</h2>
            {showPreview ? (
              <ChevronUp className="h-5 w-5 text-slate-500" />
            ) : (
              <ChevronDown className="h-5 w-5 text-slate-500" />
            )}
          </button>

          {showPreview && (
            <div className="px-4 pb-4 overflow-y-auto border-t border-slate-100">
              <div className="mt-2 rounded-md border border-slate-200 p-3">
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
            </div>
          )}
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

function ScheduleTimePreview({ preview }: { preview: SchedulePreview }) {
  return (
    <div
      className={`mt-3 rounded-md border px-3 py-3 ${
        preview.isPast
          ? 'border-red-200 bg-red-50 text-red-800'
          : 'border-emerald-200 bg-emerald-50 text-emerald-900'
      }`}
    >
      <div className="grid gap-3 text-sm md:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase opacity-75">Workspace</p>
          <p className="mt-1 font-semibold">{preview.workspaceText}</p>
          <p className="mt-0.5 text-xs opacity-80">{preview.workspaceTimezone}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase opacity-75">Giờ máy bạn</p>
          <p className="mt-1 font-semibold">{preview.localText}</p>
          <p className="mt-0.5 text-xs opacity-80">{preview.localTimezone}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase opacity-75">UTC lưu queue</p>
          <p className="mt-1 font-semibold">{preview.utcText}</p>
          <p className="mt-0.5 text-xs opacity-80">{preview.relativeText}</p>
        </div>
      </div>
      <p className="mt-3 text-xs opacity-80">
        {preview.isPast
          ? 'Thời gian này đã qua theo UTC, API sẽ từ chối lên lịch.'
          : 'Bấm "Lên lịch" để lưu bài vào Calendar theo giờ workspace phía trên.'}
      </p>
    </div>
  );
}

function UploadProgressList({ items }: { items: UploadProgressItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      {items.map((item) => {
        const percent =
          item.totalBytes > 0
            ? Math.min(100, Math.round((item.loadedBytes / item.totalBytes) * 100))
            : 0;
        const tone =
          item.stage === 'failed'
            ? 'bg-red-500'
            : item.stage === 'done'
              ? 'bg-emerald-500'
              : 'bg-brand-600';

        return (
          <div key={item.id}>
            <div className="flex items-center justify-between gap-3 text-xs text-slate-600">
              <span className="min-w-0 truncate font-medium text-slate-800">{item.fileName}</span>
              <span className="shrink-0">
                {uploadStageLabel(item.stage)}
                {item.via === 'multipart' ? ' multipart' : ''}
                {item.via === 'api-fallback' ? ' qua API local' : ''}
                {item.stage === 'uploading' ? ` · ${percent}%` : ''}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white">
              <div
                className={`h-full rounded-full transition-all ${tone}`}
                style={{ width: `${item.stage === 'confirming' ? 100 : percent}%` }}
              />
            </div>
          </div>
        );
      })}
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

function MediaLibraryPicker({
  items,
  loading,
  hasNext,
  hasPrevious,
  error,
  page,
  query,
  selectedIds,
  type,
  onAdd,
  onNext,
  onPrevious,
  onQueryChange,
  onRefresh,
  onTypeChange,
}: {
  items: MediaLibraryItem[];
  loading: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  error: string | null;
  page: number;
  query: string;
  selectedIds: string[];
  type: string;
  onAdd: (asset: MediaLibraryItem) => void;
  onNext: () => void;
  onPrevious: () => void;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  onTypeChange: (value: string) => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_auto]">
        <TextInput
          placeholder="Tìm theo tên file..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <select
          className="h-11 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          value={type}
          onChange={(event) => onTypeChange(event.target.value)}
        >
          <option value="">Tất cả media</option>
          <option value="IMAGE">Ảnh</option>
          <option value="VIDEO">Video</option>
        </select>
        <SecondaryButton disabled={loading} onClick={onRefresh} type="button">
          {loading ? 'Đang tải...' : 'Tìm'}
        </SecondaryButton>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2">
        <p className="text-sm font-semibold text-slate-700">Trang {page}</p>
        <div className="flex items-center gap-2">
          <SecondaryButton disabled={loading || !hasPrevious} onClick={onPrevious} type="button">
            <ChevronLeft className="mr-1 h-4 w-4" />
            Trước
          </SecondaryButton>
          <SecondaryButton disabled={loading || !hasNext} onClick={onNext} type="button">
            Sau
            <ChevronRight className="ml-1 h-4 w-4" />
          </SecondaryButton>
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((asset) => {
            const selected = selectedIds.includes(asset.id);
            return (
              <article
                key={asset.id}
                className={`overflow-hidden rounded-md border bg-white ${
                  selected ? 'border-brand-300 ring-2 ring-brand-100' : 'border-slate-200'
                }`}
              >
                <MediaPreview asset={asset} />
                <div className="space-y-2 p-3">
                  <div>
                    <p className="truncate text-sm font-semibold text-slate-950">
                      {asset.originalFileName ?? asset.id}
                    </p>
                    <p className="text-xs text-slate-500">
                      {asset.type} · {formatBytes(asset.sizeBytes ?? 0)}
                    </p>
                  </div>
                  <p className="text-xs text-slate-500">
                    Đã dùng: {asset.usage.total} ·{' '}
                    {asset.createdAt ? formatDate(asset.createdAt) : '-'}
                  </p>
                  <SecondaryButton
                    className="w-full"
                    disabled={selected}
                    onClick={() => onAdd(asset)}
                    type="button"
                  >
                    {selected ? 'Đã thêm vào draft' : 'Dùng media này'}
                  </SecondaryButton>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-6 text-center text-sm text-slate-500">
          {loading ? 'Đang tải thư viện media...' : 'Chưa có media READY nào để dùng lại.'}
        </p>
      )}

      {items.length > 0 ? (
        <div className="mt-3 flex items-center justify-center gap-3">
          <SecondaryButton disabled={loading || !hasPrevious} onClick={onPrevious} type="button">
            <ChevronLeft className="mr-1 h-4 w-4" />
            Trước
          </SecondaryButton>
          <span className="min-w-20 text-center text-sm font-semibold text-slate-600">
            Trang {page}
          </span>
          <SecondaryButton disabled={loading || !hasNext} onClick={onNext} type="button">
            Sau
            <ChevronRight className="ml-1 h-4 w-4" />
          </SecondaryButton>
        </div>
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

function createUploadProgressId(file: File): string {
  const randomPart =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${file.name}-${file.size}-${randomPart}`;
}

function shouldUseMultipartUpload(file: File): boolean {
  return file.type.startsWith('video/') || file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES;
}

async function uploadMultipartParts(input: {
  file: File;
  partSizeBytes: number;
  parts: Array<{ partNumber: number; uploadUrl: string }>;
  onPartProgress: (partNumber: number, loadedBytes: number) => void;
}): Promise<Array<{ partNumber: number; etag: string }>> {
  const completedParts: Array<{ partNumber: number; etag: string }> = [];

  let currentConcurrency = 2;
  const minConcurrency = 1;
  const maxConcurrency = 4;

  let activeWorkers = 0;
  let nextIndex = 0;
  let hasFailed = false;
  let lastError: Error | null = null;

  return new Promise((resolve, reject) => {
    function startNext() {
      if (hasFailed) return;
      if (nextIndex >= input.parts.length && activeWorkers === 0) {
        resolve(completedParts.sort((a, b) => a.partNumber - b.partNumber));
        return;
      }

      while (activeWorkers < currentConcurrency && nextIndex < input.parts.length && !hasFailed) {
        const part = input.parts[nextIndex];
        nextIndex++;

        if (!part) continue;

        activeWorkers++;
        processPart(part).finally(() => {
          activeWorkers--;
          startNext();
        });
      }
    }

    async function processPart(part: { partNumber: number; uploadUrl: string }) {
      const start = (part.partNumber - 1) * input.partSizeBytes;
      const end = Math.min(start + input.partSizeBytes, input.file.size);
      const chunk = input.file.slice(start, end);

      let attempt = 0;
      const maxAttempts = 3;

      while (attempt <= maxAttempts && !hasFailed) {
        try {
          const result = await uploadPart(part.uploadUrl, chunk, (loadedBytes) => {
            input.onPartProgress(part.partNumber, loadedBytes);
          });

          completedParts.push({ partNumber: part.partNumber, etag: result.etag });

          if (attempt === 0) {
            currentConcurrency = Math.min(currentConcurrency + 1, maxConcurrency);
          }
          return;
        } catch (error) {
          attempt++;
          currentConcurrency = minConcurrency;

          if (attempt > maxAttempts) {
            hasFailed = true;
            lastError = error instanceof Error ? error : new Error(String(error));
            reject(lastError);
            return;
          }

          const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    startNext();
  });
}

async function uploadPart(
  uploadUrl: string,
  chunk: Blob,
  onProgress: (loadedBytes: number) => void,
): Promise<{ etag: string }> {
  const result = await uploadPut(uploadUrl, chunk, {
    onProgress: (loadedBytes) => onProgress(loadedBytes),
  });
  if (!result.etag) {
    throw new Error(
      'Upload part thành công nhưng không đọc được ETag. Kiểm tra CORS của MinIO phải expose header ETag.',
    );
  }
  return { etag: result.etag };
}

function uploadPut(
  uploadUrl: string,
  body: Blob,
  options: {
    contentType?: string;
    onProgress: (loadedBytes: number, totalBytes: number) => void;
  },
): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.timeout = 120_000;
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress(body.size, body.size);
        resolve({ etag: xhr.getResponseHeader('ETag') });
        return;
      }
      reject(new Error(`Media host từ chối upload trực tiếp: HTTP ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error(directUploadFailureMessage(uploadUrl)));
    xhr.ontimeout = () => reject(new Error('Upload trực tiếp lên media host quá thời gian chờ.'));
    xhr.send(body);
  });
}

function sumLoadedParts(loadedByPart: Map<number, number>): number {
  let total = 0;
  for (const loadedBytes of loadedByPart.values()) total += loadedBytes;
  return total;
}

function shouldUseApiUploadFallback(uploadUrl: string): boolean {
  if (!isLocalBrowserHost()) return false;
  try {
    const hostname = new URL(uploadUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'minio';
  } catch {
    return false;
  }
}

function directUploadFailureMessage(uploadUrl: string): string {
  const host = safeUploadHost(uploadUrl);
  const suffix = isLocalBrowserHost()
    ? ' Local dev có thể fallback qua API nếu media host là localhost/minio.'
    : ' Production không fallback qua API để tránh làm nghẽn VPS; kiểm tra CORS/Nginx/MinIO media domain.';
  return `Không upload trực tiếp lên media host${host ? ` ${host}` : ''}.${suffix}`;
}

function isLocalBrowserHost(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

function safeUploadHost(uploadUrl: string): string | null {
  try {
    return new URL(uploadUrl).host;
  } catch {
    return null;
  }
}

function uploadStageLabel(stage: UploadStage): string {
  switch (stage) {
    case 'creating':
      return 'Chuẩn bị';
    case 'uploading':
      return 'Đang upload';
    case 'confirming':
      return 'Đang kiểm tra';
    case 'processing':
      return 'Đang tạo thumbnail';
    case 'done':
      return 'Hoàn tất';
    case 'failed':
      return 'Thất bại';
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}
