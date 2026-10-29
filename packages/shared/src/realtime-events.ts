import type { Platform } from './platform';
import type { QueueName } from './queues';

export function workspaceRealtimeChannel(workspaceId: string): string {
  return `socialhub:ws:${workspaceId}:events`;
}

export type WorkspaceRealtimeEventType =
  | 'stream.reconnected'
  | 'job.queued'
  | 'job.active'
  | 'job.completed'
  | 'job.failed'
  | 'comment.created'
  | 'comment.create_failed'
  | 'comment.replied'
  | 'comment.reply_failed'
  | 'comment.moderated'
  | 'comment.moderation_failed'
  | 'comments.synced'
  | 'posts.changed'
  | 'notification.created'
  | 'notifications.changed'
  | 'media.updated'
  | 'accounts.changed'
  | 'metrics.synced'
  | 'network.changed';

export interface WorkspaceRealtimeEvent {
  id: string;
  workspaceId: string;
  type: WorkspaceRealtimeEventType;
  timestamp: string;
  queueName?: QueueName | string;
  jobId?: string;
  contentPostId?: string;
  platformPostId?: string;
  commentId?: string;
  commandId?: string;
  replyRecordId?: string;
  mediaAssetId?: string;
  socialAccountId?: string;
  notificationId?: string;
  platform?: Platform | string;
  message?: string;
  errorMessage?: string;
}
