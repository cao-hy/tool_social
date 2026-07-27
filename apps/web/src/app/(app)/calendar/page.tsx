'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { InlineError, SecondaryButton } from '@/components/form-controls';
import { MediaPreview } from '@/components/media-preview';
import { postsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import type { ContentPostView } from '@/lib/types';

export default function CalendarPage() {
  const auth = useAuth();
  const workspace = auth.activeWorkspace;
  const [posts, setPosts] = useState<ContentPostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPosts() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await postsApi.list(workspace.id, { limit: 100 });
      setPosts(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPosts();
  }, [workspace]);

  const scheduledPosts = useMemo(
    () =>
      posts
        .filter((post) => post.scheduledAt)
        .sort(
          (left, right) =>
            new Date(left.scheduledAt ?? 0).getTime() - new Date(right.scheduledAt ?? 0).getTime(),
        ),
    [posts],
  );

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Calendar</h1>
          <p className="mt-1 text-sm text-slate-600">Các bài đã lên lịch theo giờ local.</p>
        </div>
        <div className="flex gap-2">
          <SecondaryButton disabled={loading} onClick={() => void loadPosts()} type="button">
            Làm mới
          </SecondaryButton>
          <Link
            className="inline-flex h-10 items-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white"
            href="/posts/new"
          >
            Tạo post
          </Link>
        </div>
      </header>

      <InlineError message={error} />

      <section className="grid gap-3 xl:grid-cols-2">
        {scheduledPosts.map((post) => (
          <article key={post.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-sm font-semibold text-brand-700">
              {new Date(post.scheduledAt ?? '').toLocaleString()}
            </p>
            <h2 className="mt-2 text-base font-semibold text-slate-950">
              {post.title ?? 'Untitled post'}
            </h2>
            <p className="mt-2 line-clamp-2 text-sm text-slate-600">
              {post.body ?? 'Không có nội dung.'}
            </p>
            {post.media.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {post.media.slice(0, 4).map((asset) => (
                  <MediaPreview key={asset.id} asset={asset} />
                ))}
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {post.platformPosts.map((item) => (
                <span
                  key={item.id}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600"
                >
                  {item.socialAccountName}: {item.status}
                </span>
              ))}
            </div>
          </article>
        ))}
        {!loading && scheduledPosts.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
            Chưa có bài nào được lên lịch. Bài chỉ xuất hiện ở đây sau khi bạn bấm "Lên lịch" trong
            trang Create Post.
          </p>
        ) : null}
      </section>
    </div>
  );
}
