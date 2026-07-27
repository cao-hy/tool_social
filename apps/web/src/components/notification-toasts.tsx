'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import type { NotificationView } from '@/lib/types';

const POLL_INTERVAL_MS = 10_000;
const TOAST_TTL_MS = 8_000;
const MAX_TOASTS = 3;

type ToastNotification = Pick<NotificationView, 'id' | 'type' | 'title' | 'body' | 'linkUrl'>;

export function NotificationToasts() {
  const { activeWorkspace } = useAuth();
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const initializedWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeWorkspace) return;

    let cancelled = false;

    async function poll() {
      if (!activeWorkspace || cancelled) return;

      try {
        const result = await notificationsApi.list(activeWorkspace.id, {
          unreadOnly: true,
          limit: 20,
        });

        if (cancelled) return;

        if (initializedWorkspaceRef.current !== activeWorkspace.id) {
          initializedWorkspaceRef.current = activeWorkspace.id;
          knownIdsRef.current = new Set(result.items.map((item) => item.id));
          return;
        }

        const fresh = result.items
          .filter((item) => !knownIdsRef.current.has(item.id))
          .sort(
            (left, right) =>
              new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
          );

        for (const item of fresh) {
          knownIdsRef.current.add(item.id);
        }

        if (fresh.length > 0) {
          setToasts((current) =>
            [
              ...fresh.map((item) => ({
                id: item.id,
                type: item.type,
                title: item.title,
                body: item.body,
                linkUrl: item.linkUrl,
              })),
              ...current,
            ].slice(0, MAX_TOASTS),
          );
        }
      } catch {
        // Toast polling không được phá trải nghiệm chính nếu API tạm lỗi.
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWorkspace]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) => window.setTimeout(() => dismiss(toast.id), TOAST_TTL_MS));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts]);

  function dismiss(notificationId: string) {
    setToasts((current) => current.filter((toast) => toast.id !== notificationId));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 grid w-[min(360px,calc(100vw-2rem))] gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-lg shadow-slate-900/10"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-brand-700">{toast.type}</p>
              <p className="mt-1 text-sm font-semibold text-slate-950">{toast.title}</p>
              {toast.body ? <p className="mt-1 text-sm text-slate-600">{toast.body}</p> : null}
            </div>
            <button
              aria-label="Đóng thông báo"
              className="h-7 w-7 rounded-md text-sm font-semibold text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              onClick={() => dismiss(toast.id)}
              type="button"
            >
              ×
            </button>
          </div>
          {toast.linkUrl ? (
            <Link
              className="mt-3 inline-block text-sm font-medium text-brand-700"
              href={toast.linkUrl}
              onClick={() => dismiss(toast.id)}
            >
              Mở liên quan
            </Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
