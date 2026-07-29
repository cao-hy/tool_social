'use client';

import { hasPermission, PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import { useParams, useRouter } from 'next/navigation';
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
import { postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  EMPTY_PLATFORM_OVERRIDE,
  isPlatformOverrideActive,
  platformOptions,
  platformOverrideFromOptions,
  type PlatformOverrideDraft,
} from '@/lib/platform-composer-options';
import { validatePostComposer } from '@/lib/post-validation';
import type { ContentPostView, SocialAccountView } from '@/lib/types';

export default function EditPostPage() {
  const auth = useAuth();
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
            loadedPost.platformPosts.map((item) => [
              item.socialAccountId,
              platformOverrideFromOptions({
                title: item.title ?? '',
                caption: item.caption ?? '',
                description: item.description ?? '',
                linkUrl: item.linkUrl ?? '',
                mediaAssetIds: item.media.map((asset) => asset.id),
                options: item.options,
              }),
            ]),
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
  const canEditState = post ? ['DRAFT', 'FAILED', 'SCHEDULED'].includes(post.status) : false;

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

  function updateOverride(accountId: string, patch: Partial<PlatformOverrideDraft>) {
    setPlatformOverrides((current) => ({
      ...current,
      [accountId]: { ...EMPTY_PLATFORM_OVERRIDE, ...current[accountId], ...patch },
    }));
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
      await postsApi.update(workspace.id, post.id, {
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        linkUrl: linkUrl.trim() || undefined,
        hashtags: hashtags
          .split(/[,\s]+/)
          .map((item) => item.replace(/^#/, '').trim())
          .filter(Boolean),
        socialAccountIds: selectedIds,
        mediaAssetIds,
        platformOverrides: platformOverridePayload,
      });
      router.push('/posts');
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  function buildValidationOverrides() {
    return selectedAccounts
      .map((account) => {
        const draft = overrideFor(account.id);
        if (!isPlatformOverrideActive(account.platform, draft)) return null;
        const selectedMedia =
          draft.mediaAssetIds.length > 0 && post
            ? post.media.filter((asset) => draft.mediaAssetIds.includes(asset.id))
            : undefined;
        return {
          socialAccountId: account.id,
          title: draft.title.trim() || undefined,
          caption: draft.caption.trim() || undefined,
          linkUrl: draft.linkUrl.trim() || undefined,
          mediaAssets: selectedMedia,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  function buildPlatformOverridePayload() {
    return selectedAccounts
      .map((account) => {
        const draft = overrideFor(account.id);
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
          <div className="space-y-5 rounded-lg border border-slate-200 bg-white p-5">
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
                disabled={!canEditState}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>

            <Field label="Nội dung">
              <textarea
                className="min-h-48 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100"
                disabled={!canEditState}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Link">
                <TextInput
                  disabled={!canEditState}
                  placeholder="https://..."
                  value={linkUrl}
                  onChange={(event) => setLinkUrl(event.target.value)}
                />
              </Field>
              <Field label="Hashtags">
                <TextInput
                  disabled={!canEditState}
                  value={hashtags}
                  onChange={(event) => setHashtags(event.target.value)}
                />
              </Field>
            </div>

            {post?.media.length ? (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-800">Media đã gắn</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {post.media.map((asset) => (
                    <label
                      key={asset.id}
                      className="rounded-md border border-slate-200 p-3 text-sm"
                    >
                      <MediaPreview asset={asset} />
                      <span className="mt-2 flex items-start gap-2">
                        <input
                          checked={mediaAssetIds.includes(asset.id)}
                          className="mt-1"
                          disabled={!canEditState}
                          type="checkbox"
                          onChange={() =>
                            setMediaAssetIds((current) =>
                              current.includes(asset.id)
                                ? current.filter((id) => id !== asset.id)
                                : [...current, asset.id],
                            )
                          }
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
                  ))}
                </div>
              </div>
            ) : null}

            <div className="border-t border-slate-200 pt-4">
              <PlatformComposerPanels
                accounts={selectedAccounts}
                common={{ title, body, linkUrl }}
                disabled={!canEditState}
                drafts={platformOverrides}
                mediaAssets={post?.media.filter((asset) => mediaAssetIds.includes(asset.id)) ?? []}
                onChange={updateOverride}
              />
            </div>
          </div>
        )}
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
                        disabled={!canEditState}
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
            disabled={!canUpdate || !canEditState || loading}
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
    </div>
  );
}
