import { PLATFORM_LABELS, type Platform } from '@socialhub/shared';
import type { NotificationView } from './types';

export interface NotificationDisplayMeta {
  accountName: string | null;
  code: string | null;
  platform: Platform | null;
  platformLabel: string | null;
  postTitle: string | null;
}

export function notificationDisplayMeta(item: NotificationView): NotificationDisplayMeta {
  const data = notificationData(item.data);
  const platform = readPlatform(data.platform);

  return {
    accountName: readString(data.accountName) ?? readString(data.socialAccountName),
    code: readString(data.code) ?? readString(data.errorCode),
    platform,
    platformLabel: platform ? PLATFORM_LABELS[platform] : null,
    postTitle: readString(data.postTitle),
  };
}

export function notificationBodyText(item: NotificationView): string | null {
  const meta = notificationDisplayMeta(item);
  if (!item.body) return meta.platformLabel;
  if (!meta.platformLabel) return item.body;
  if (item.body.includes(meta.platformLabel)) return item.body;
  return `${meta.platformLabel} · ${item.body}`;
}

export function notificationToastMessage(item: NotificationView): string {
  const body = notificationBodyText(item);
  return body ? `${item.title}: ${body}` : item.title;
}

export function platformBadgeClass(platform: Platform | null): string {
  switch (platform) {
    case 'FACEBOOK':
      return 'bg-blue-50 text-blue-700';
    case 'INSTAGRAM':
      return 'bg-pink-50 text-pink-700';
    case 'PINTEREST':
      return 'bg-red-50 text-red-700';
    case 'YOUTUBE':
      return 'bg-amber-50 text-amber-700';
    case 'TIKTOK':
      return 'bg-slate-950 text-white';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function notificationData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPlatform(value: unknown): Platform | null {
  return typeof value === 'string' && value in PLATFORM_LABELS ? (value as Platform) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
