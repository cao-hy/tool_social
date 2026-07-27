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
import { postsApi, socialAccountsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
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

  async function save() {
    if (!workspace || !post) return;
    const selectedAccounts = accounts.filter((account) => selectedIds.includes(account.id));
    const selectedMedia = post.media.filter((asset) => mediaAssetIds.includes(asset.id));
    const validationError = validatePostComposer({
      title,
      body,
      linkUrl,
      selectedAccounts,
      mediaAssets: selectedMedia,
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
      });
      router.push('/posts');
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-6 xl:grid-cols-[1fr_360px]">
      <section className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold text-slate-950">Edit Post</h1>
          <p className="mt-1 text-sm text-slate-600">
            Chỉnh sửa draft, bài đã lên lịch hoặc bài thất bại.
          </p>
        </header>

        <InlineError message={error} />

        {loading ? (
          <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">
            Đang tải bài viết...
          </p>
        ) : (
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
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
          </div>
        )}
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
