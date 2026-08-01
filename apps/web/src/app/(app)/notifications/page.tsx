'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineError, SecondaryButton } from '@/components/form-controls';
import { useToast } from '@/components/toast-provider';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { getErrorMessage } from '@/lib/errors';
import {
  notificationBodyText,
  notificationDisplayMeta,
  platformBadgeClass,
} from '@/lib/notification-format';
import type { NotificationView } from '@/lib/types';

export default function NotificationsPage() {
  const auth = useAuth();
  const toast = useToast();
  const workspace = auth.activeWorkspace;
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadNotifications() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await notificationsApi.list(workspace.id, { unreadOnly, limit: 100 });
      setItems(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotifications();
  }, [workspace, unreadOnly]);

  async function markRead(notificationId: string) {
    if (!workspace) return;
    setUpdating(notificationId);
    setError(null);
    try {
      await notificationsApi.markRead(workspace.id, notificationId);
      await loadNotifications();
      toast.success('Đã đánh dấu notification là đã đọc.');
    } catch (updateError) {
      toast.error(getErrorMessage(updateError));
    } finally {
      setUpdating(null);
    }
  }

  async function markAllRead() {
    if (!workspace) return;
    setUpdating('all');
    setError(null);
    try {
      await notificationsApi.markAllRead(workspace.id);
      await loadNotifications();
      toast.success('Đã đánh dấu tất cả notification là đã đọc.');
    } catch (updateError) {
      toast.error(getErrorMessage(updateError));
    } finally {
      setUpdating(null);
    }
  }

  if (!workspace) {
    return <p className="text-sm text-slate-600">Tài khoản này chưa thuộc workspace nào.</p>;
  }

  const unreadCount = items.filter((item) => !item.readAt).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Notifications</h1>
          <p className="mt-1 text-sm text-slate-600">
            Kết quả publish, lỗi token và các cảnh báo cần xử lý.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton
            disabled={loading}
            onClick={() => setUnreadOnly((current) => !current)}
            type="button"
          >
            {unreadOnly ? 'Hiện tất cả' : 'Chỉ unread'}
          </SecondaryButton>
          <SecondaryButton
            disabled={loading}
            onClick={() => void loadNotifications()}
            type="button"
          >
            Làm mới
          </SecondaryButton>
          <SecondaryButton
            disabled={updating !== null || unreadCount === 0}
            onClick={() => void markAllRead()}
            type="button"
          >
            Đánh dấu đã đọc
          </SecondaryButton>
        </div>
      </header>

      <InlineError message={error} />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="divide-y divide-slate-200">
          {items.map((item) => {
            const meta = notificationDisplayMeta(item);
            const body = notificationBodyText(item);
            return (
              <article key={item.id} className="flex flex-col gap-3 p-5 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {!item.readAt ? (
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                        Unread
                      </span>
                    ) : null}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                      {item.type}
                    </span>
                    {meta.platformLabel ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${platformBadgeClass(meta.platform)}`}
                      >
                        {meta.platformLabel}
                      </span>
                    ) : null}
                    <span className="text-xs text-slate-500">
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <h2 className="mt-2 text-base font-semibold text-slate-950">{item.title}</h2>
                  {body ? <p className="mt-1 text-sm text-slate-600">{body}</p> : null}
                  {meta.postTitle ? (
                    <p className="mt-1 text-xs text-slate-500">Bài: {meta.postTitle}</p>
                  ) : null}
                  {item.linkUrl ? (
                    <Link
                      className="mt-2 inline-block text-sm font-medium text-brand-700"
                      href={item.linkUrl}
                    >
                      Mở liên quan
                    </Link>
                  ) : null}
                </div>
                <SecondaryButton
                  disabled={Boolean(item.readAt) || updating !== null}
                  onClick={() => void markRead(item.id)}
                  type="button"
                >
                  {updating === item.id ? 'Đang cập nhật...' : 'Đã đọc'}
                </SecondaryButton>
              </article>
            );
          })}

          {!loading && items.length === 0 ? (
            <p className="p-6 text-sm text-slate-600">Chưa có notification nào.</p>
          ) : null}
          {loading ? <p className="p-6 text-sm text-slate-600">Đang tải notifications...</p> : null}
        </div>
      </section>
    </div>
  );
}
