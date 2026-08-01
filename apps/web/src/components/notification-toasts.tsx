'use client';

import { useEffect, useRef } from 'react';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { notificationToastMessage } from '@/lib/notification-format';
import type { NotificationView } from '@/lib/types';
import { useToast } from './toast-provider';

const POLL_INTERVAL_MS = 5_000;
const INITIAL_TOAST_WINDOW_MS = 2 * 60_000;
const MAX_INITIAL_TOASTS = 3;
const notifiedNotificationIds = new Set<string>();

export function NotificationToasts() {
  const { activeWorkspace } = useAuth();
  const toast = useToast();
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
          result.items
            .filter(shouldToastOnInitialPoll)
            .sort(
              (left, right) =>
                new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
            )
            .slice(-MAX_INITIAL_TOASTS)
            .forEach((item) => pushNotificationToast(item, toast));
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
          pushNotificationToast(item, toast);
        }
      } catch {
        // Poll notification không được làm hỏng trải nghiệm chính nếu API tạm lỗi.
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWorkspace, toast]);

  return null;
}

function shouldToastOnInitialPoll(item: NotificationView) {
  if (!isToastWorthShowing(item)) return false;
  const createdAt = new Date(item.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return false;
  const ageMs = Date.now() - createdAt;
  return ageMs >= 0 && ageMs <= INITIAL_TOAST_WINDOW_MS;
}

function isToastWorthShowing(item: NotificationView) {
  return ['POST_FAILED', 'POST_PUBLISHED'].includes(item.type);
}

function pushNotificationToast(item: NotificationView, toast: ReturnType<typeof useToast>) {
  if (notifiedNotificationIds.has(item.id) || !isToastWorthShowing(item)) return;
  notifiedNotificationIds.add(item.id);

  const message = notificationToastMessage(item);
  if (item.type === 'POST_FAILED') {
    toast.error(message, 'Publish thất bại');
    return;
  }

  toast.success(message, 'Publish thành công');
}
