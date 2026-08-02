'use client';

import {
  hasPermission,
  normalizeOptionalSocialText,
  splitAndNormalizeHashtags,
  PLATFORM_LABELS,
  type Platform,
} from '@socialhub/shared';
import { Eye, X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  Field,
  InlineError,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from '@/components/form-controls';
import {
  FallbackImage,
  mediaPreviewSources,
  mediaThumbnailSources,
} from '@/components/media-preview';
import { PlatformComposerPanels } from '@/components/platform-composer-panels';
import { useToast } from '@/components/toast-provider';
import { postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  fillMissingPlatformOverrideFromCommon,
  isPlatformOverrideActive,
  platformOverrideDefaults,
  platformOverrideFromCommon,
  platformOptions,
  platformOverrideFromOptions,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import { validatePostComposer } from '@/lib/post-validation';
import type { ContentPostView, MediaAssetView, SocialAccountView } from '@/lib/types';

const CONTENT_EDITABLE_POST_STATUSES = [
  'DRAFT',
  'FAILED',
  'SCHEDULED',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
] as const;
const TARGET_EDITABLE_POST_STATUSES = ['DRAFT', 'FAILED', 'SCHEDULED'] as const;

export default function EditPostPage() {
  const auth = useAuth();
  const toast = useToast();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const workspace = auth.activeWorkspace;
  const [post, setPost] = useState<ContentPostView | null>(null);
  const [accounts, setAccounts] = useState<SocialAccountView[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [mediaAssetIds, setMediaAssetIds] = useState<string[]>([]);
  const [platformOverrides, setPlatformOverrides] = useState<Record<string, PlatformOverrideDraft>>(
    {},
  );
  const [previewAsset, setPreviewAsset] = useState<MediaAssetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    Promise.all([postsApi.get(workspace.id, params.id), socialAccountsApi.list(workspace.id)])
      .then(([loadedPost, loadedAccounts]) => {
        setPost(loadedPost);
        setTitle(loadedPost.title ?? '');
        setBody(loadedPost.body ?? '');
        setLinkUrl(loadedPost.linkUrl ?? '');
        setHashtags(loadedPost.hashtags.join(', '));
        setSelectedIds(loadedPost.platformPosts.map((item) => item.socialAccountId));
        setMediaAssetIds(loadedPost.media.map((item) => item.id));
        setPlatformOverrides(
          Object.fromEntries(
            loadedPost.platformPosts.map((item) => {
              const account = loadedAccounts.items.find(
                (loadedAccount) => loadedAccount.id === item.socialAccountId,
              );
              const draft = platformOverrideFromOptions({
                title: item.title ?? '',
                caption: item.caption ?? '',
                description: item.description ?? '',
                linkUrl: item.linkUrl ?? '',
                mediaAssetIds: item.media.map((asset) => asset.id),
                options: item.options,
              });
              return [
                item.socialAccountId,
                fillMissingPlatformOverrideFromCommon(item.platform, account?.scopes ?? [], draft, {
                  title: loadedPost.title ?? '',
                  body: loadedPost.body ?? '',
                  linkUrl: loadedPost.linkUrl ?? '',
                  mediaAssetIds: loadedPost.media.map((asset) => asset.id),
                }),
              ];
            }),
          ),
        );
        setAccounts(loadedAccounts.items.filter((item) => item.status === 'CONNECTED'));
      })
      .catch((loadError) => setError(getErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, [workspace, params.id]);

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

  const canUpdate = hasPermission(workspace.role, 'post:update');
  const canEditContent = post ? canEditPostContent(post.status) : false;
  const canEditTargets = post ? canEditPostTargets(post.status) : false;
  const isPublishedEdit = post ? isPublishedPostStatus(post.status) : false;

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

  function updateOverride(accountId: string, patch: Partial<PlatformOverrideDraft>) {
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
            mediaAssetIds,
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

  function toggleMediaAsset(mediaAssetId: string) {
    const removing = mediaAssetIds.includes(mediaAssetId);
    setMediaAssetIds((current) =>
      removing ? current.filter((id) => id !== mediaAssetId) : [...current, mediaAssetId],
    );
    if (!removing) return;
    setPlatformOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).map(([accountId, draft]) => [
          accountId,
          {
            ...draft,
            mediaAssetIds: draft.mediaAssetIds.filter((id) => id !== mediaAssetId),
            thumbnailMediaAssetId:
              draft.thumbnailMediaAssetId === mediaAssetId ? '' : draft.thumbnailMediaAssetId,
            thumbnailMode:
              draft.thumbnailMediaAssetId === mediaAssetId ? 'AUTO' : draft.thumbnailMode,
          },
        ]),
      ),
    );
  }

  async function save() {
    if (!workspace || !post) return;
    const selectedMedia = post.media.filter((asset) => mediaAssetIds.includes(asset.id));
    const platformOverridePayload = buildPlatformOverridePayload();
    const validationError = validatePostComposer({
      title,
      body,
      linkUrl,
      selectedAccounts,
      mediaAssets: selectedMedia,
      platformOverrides: buildValidationOverrides(),
      requireTargets: post.status === 'SCHEDULED',
      requirePublishableContent: post.status === 'SCHEDULED',
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        title: normalizeOptionalSocialText(title),
        body: normalizeOptionalSocialText(body),
        linkUrl: linkUrl.trim() || undefined,
        hashtags: splitAndNormalizeHashtags(hashtags),
        platformOverrides: platformOverridePayload,
      };
      await postsApi.update(
        workspace.id,
        post.id,
        isPublishedEdit ? payload : { ...payload, socialAccountIds: selectedIds, mediaAssetIds },
      );
      toast.success('Đã lưu thay đổi.');
      router.push('/posts');
    } catch (saveError) {
      toast.error(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  function buildValidationOverrides() {
    return selectedAccounts
      .map((account) => {
        const draft = overrideFor(account);
        if (!isPlatformOverrideActive(account.platform, draft)) return null;
        const selectedMedia =
          draft.mediaAssetIds.length > 0 && post
            ? post.media.filter((asset) => draft.mediaAssetIds.includes(asset.id))
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
          mediaAssetIds:
            canEditTargets && draft.mediaAssetIds.length > 0 ? draft.mediaAssetIds : undefined,
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

  return (
    <div className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-slate-950">Sửa bài đăng</h1>
          <p className="mt-1 text-sm text-slate-600">
            Chỉnh nội dung chung trước, chỉ mở tùy chỉnh riêng cho target cần khác biệt.
          </p>
        </header>

        <InlineError message={error} />

        {loading ? (
          <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
            Đang tải bài viết...
          </p>
        ) : (
          <div className="space-y-5 rounded-lg border border-sky-200 bg-sky-50/40 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-950">Nội dung chung</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Các target sẽ kế thừa phần này nếu không bật tùy chỉnh riêng.
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {selectedIds.length} tài khoản đã chọn
              </span>
            </div>

            <Field label="Tiêu đề nội bộ">
              <TextInput
                disabled={!canEditContent}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>

            <Field label="Nội dung">
              <textarea
                className="min-h-48 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100"
                disabled={!canEditContent}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Link đích">
                <TextInput
                  disabled={!canEditContent}
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
                  disabled={!canEditContent}
                  value={hashtags}
                  onChange={(event) => setHashtags(event.target.value)}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Nền tảng dùng hashtag trong mô tả sẽ được hệ thống tự gắn khi publish.
                </p>
              </Field>
            </div>

            {post?.media.length ? (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-800">Media đã gắn</p>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {post.media.map((asset) => {
                    const sources =
                      asset.type === 'VIDEO' && asset.status !== 'ARCHIVED'
                        ? mediaThumbnailSources(asset)
                        : mediaPreviewSources(asset);
                    return (
                      <label
                        key={asset.id}
                        className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-2 text-sm"
                      >
                        <button
                          className="relative h-16 w-24 shrink-0 overflow-hidden rounded bg-slate-950 text-xs font-semibold text-white transition hover:-translate-y-px hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                          onClick={(event) => {
                            event.preventDefault();
                            setPreviewAsset(asset);
                          }}
                          title="Xem media"
                          type="button"
                        >
                          {(asset.type === 'IMAGE' || asset.status === 'ARCHIVED') &&
                          sources.length > 0 ? (
                            <FallbackImage
                              alt={asset.originalFileName ?? 'media'}
                              className="h-full w-full object-cover"
                              sources={sources}
                            />
                          ) : asset.type === 'VIDEO' ? (
                            sources.length > 0 ? (
                              <FallbackImage
                                alt={asset.originalFileName ?? 'video thumbnail'}
                                className="h-full w-full object-cover"
                                sources={sources}
                              />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center bg-slate-950 text-[11px] font-semibold text-white">
                                VIDEO
                              </span>
                            )
                          ) : (
                            <span className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500">
                              {asset.type}
                            </span>
                          )}
                          <span className="absolute inset-0 flex items-center justify-center bg-slate-950/20 opacity-0 transition hover:opacity-100">
                            <Eye className="h-5 w-5" />
                          </span>
                          {asset.status === 'ARCHIVED' ? (
                            <span className="absolute bottom-1 left-1 rounded bg-slate-950/75 px-1 text-[9px] font-semibold text-white">
                              ARCHIVED
                            </span>
                          ) : null}
                        </button>
                        <span className="flex min-w-0 flex-1 items-start gap-2">
                          <input
                            checked={mediaAssetIds.includes(asset.id)}
                            className="mt-1"
                            disabled={!canEditTargets}
                            type="checkbox"
                            onChange={() => toggleMediaAsset(asset.id)}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-slate-900">
                              {asset.originalFileName ?? asset.id}
                            </span>
                            <span className="block text-xs text-slate-500">
                              {asset.mimeType ?? asset.type}
                            </span>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="border-t border-slate-200 pt-4">
              <PlatformComposerPanels
                accounts={selectedAccounts}
                common={{ title, body, linkUrl, hashtags }}
                disabled={!canEditContent}
                drafts={platformOverrides}
                mediaLocked={!canEditTargets}
                mediaAssets={post?.media.filter((asset) => mediaAssetIds.includes(asset.id)) ?? []}
                workspaceId={workspace.id}
                onChange={updateOverride}
              />
            </div>
          </div>
        )}
      </section>

      <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        {isPublishedEdit ? (
          <section className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">Bài đã publish</p>
            <p className="mt-1 text-amber-800">
              Chỉ sửa nội dung, caption, link và options. Media và target đang được khóa.
            </p>
          </section>
        ) : null}
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
                        disabled={!canEditTargets}
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
          </div>
        </section>

        <div className="grid gap-2">
          <PrimaryButton
            busy={saving}
            disabled={!canUpdate || !canEditContent || loading}
            onClick={save}
            type="button"
          >
            Lưu thay đổi
          </PrimaryButton>
          <SecondaryButton onClick={() => router.push('/posts')} type="button">
            Quay lại
          </SecondaryButton>
        </div>
      </aside>
      <MediaPreviewDialog asset={previewAsset} onClose={() => setPreviewAsset(null)} />
    </div>
  );
}

function MediaPreviewDialog({
  asset,
  onClose,
}: {
  asset: MediaAssetView | null;
  onClose: () => void;
}) {
  const source = asset?.displayUrl ?? asset?.thumbnailUrl ?? asset?.readUrl;
  if (!asset || !source) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6">
      <div className="w-full max-w-4xl overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="truncate text-sm font-semibold text-slate-950">
            {asset.originalFileName ?? 'Media preview'}
          </p>
          <button
            aria-label="Đóng"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-700 transition hover:bg-slate-50"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="bg-slate-950 p-3">
          {asset.type === 'VIDEO' && asset.status !== 'ARCHIVED' ? (
            <video className="max-h-[72vh] w-full rounded bg-black" controls src={source} />
          ) : (
            <FallbackImage
              alt={asset.originalFileName ?? 'media'}
              className="max-h-[72vh] w-full rounded object-contain"
              sources={mediaPreviewSources(asset)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function canEditPostContent(status: ContentPostView['status']) {
  return CONTENT_EDITABLE_POST_STATUSES.includes(
    status as (typeof CONTENT_EDITABLE_POST_STATUSES)[number],
  );
}

function canEditPostTargets(status: ContentPostView['status']) {
  return TARGET_EDITABLE_POST_STATUSES.includes(
    status as (typeof TARGET_EDITABLE_POST_STATUSES)[number],
  );
}

function isPublishedPostStatus(status: ContentPostView['status']) {
  return status === 'PUBLISHED' || status === 'PARTIALLY_PUBLISHED';
}
