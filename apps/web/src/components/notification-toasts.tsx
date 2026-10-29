'use client';

import { useCallback, useEffect, useRef } from 'react';
import { notificationsApi } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-store';
import { notificationBodyText, notificationToastMessage } from '@/lib/notification-format';
import type { NotificationView } from '@/lib/types';
import { useToast } from './toast-provider';
import { useWorkspaceEventSubscription } from './workspace-events-provider';

const FALLBACK_POLL_INTERVAL_MS = 5_000;
const SSE_POLL_INTERVAL_MS = 30_000;
const INITIAL_TOAST_WINDOW_MS = 2 * 60_000;
const MAX_INITIAL_TOASTS = 3;
const notifiedNotificationIds = new Set<string>();

export function NotificationToasts() {
  const { activeWorkspace } = useAuth();
  const toast = useToast();
  const knownIdsRef = useRef<Set<string>>(new Set());
  const initializedWorkspaceRef = useRef<string | null>(null);

  const poll = useCallback(async () => {
    if (!activeWorkspace) return;

    try {
      const result = await notificationsApi.list(activeWorkspace.id, {
        unreadOnly: true,
        limit: 20,
      });

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
          (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
        );

      for (const item of fresh) {
        knownIdsRef.current.add(item.id);
        pushNotificationToast(item, toast);
      }
    } catch {
      // Poll notification không được làm hỏng trải nghiệm chính nếu API tạm lỗi.
    }
  }, [activeWorkspace, toast]);

  const { connected: sseConnected } = useWorkspaceEventSubscription((event) => {
    if (
      event.type === 'notification.created' ||
      event.type === 'posts.changed' ||
      event.type === 'job.failed' ||
      event.type === 'stream.reconnected'
    ) {
      void poll();
    }
    if (event.type === 'comment.create_failed' && event.errorMessage) {
      toast.error(`Gửi bình luận thất bại: ${event.errorMessage}`);
    } else if (event.type === 'comment.reply_failed' && event.errorMessage) {
      toast.error(`Phản hồi bình luận thất bại: ${event.errorMessage}`);
    } else if (event.type === 'comment.moderation_failed' && event.errorMessage) {
      toast.error(`Thao tác bình luận thất bại: ${event.errorMessage}`);
    }
  });

  useEffect(() => {
    if (!activeWorkspace) return;

    void poll();
    const intervalMs = sseConnected ? SSE_POLL_INTERVAL_MS : FALLBACK_POLL_INTERVAL_MS;
    const interval = window.setInterval(() => void poll(), intervalMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [activeWorkspace, poll, sseConnected]);

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

  if (item.type === 'POST_FAILED') {
    const customFailureTitle =
      item.title === 'Cập nhật bài đã đăng thất bại' ||
      item.title === 'Xóa bài trên mạng xã hội thất bại';
    if (customFailureTitle) {
      toast.error(notificationBodyText(item) ?? item.title, item.title);
      return;
    }
    toast.error(notificationToastMessage(item), 'Publish thất bại');
    return;
  }

  toast.success(notificationToastMessage(item), 'Publish thành công');
}
