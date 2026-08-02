/**
 * Định nghĩa queue dùng chung giữa `apps/api` (producer) và `apps/worker`
 * (consumer). Đặt ở đây để hai bên không thể lệch tên queue hay lệch kiểu
 * payload — một lỗi im lặng rất khó phát hiện khi chỉ dùng chuỗi tự do.
 */

export const QUEUE_NAMES = [
  'publish-post',
  'sync-posts',
  'sync-comments',
  'sync-post-metrics',
  'sync-account-metrics',
  'refresh-social-token',
  'process-webhook',
  'retry-failed-post',
  'generate-thumbnail',
  'cleanup-unused-media',
  'sync-external-posts',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueSettings {
  /** Số job chạy song song trong một worker. */
  concurrency: number;
  /** Số lần thử tối đa, tính cả lần đầu. */
  attempts: number;
  /** Độ trễ nền của exponential backoff (ms). */
  backoffDelayMs: number;
}

export const QUEUE_SETTINGS: Record<QueueName, QueueSettings> = {
  'publish-post': { concurrency: 5, attempts: 5, backoffDelayMs: 5_000 },
  'sync-posts': { concurrency: 3, attempts: 3, backoffDelayMs: 10_000 },
  'sync-comments': { concurrency: 5, attempts: 3, backoffDelayMs: 10_000 },
  'sync-post-metrics': { concurrency: 5, attempts: 3, backoffDelayMs: 15_000 },
  'sync-account-metrics': { concurrency: 3, attempts: 3, backoffDelayMs: 15_000 },
  'refresh-social-token': { concurrency: 3, attempts: 3, backoffDelayMs: 30_000 },
  'process-webhook': { concurrency: 10, attempts: 5, backoffDelayMs: 5_000 },
  'retry-failed-post': { concurrency: 3, attempts: 1, backoffDelayMs: 0 },
  'generate-thumbnail': { concurrency: 1, attempts: 3, backoffDelayMs: 5_000 },
  'cleanup-unused-media': { concurrency: 1, attempts: 1, backoffDelayMs: 0 },
  'sync-external-posts': { concurrency: 2, attempts: 3, backoffDelayMs: 5_000 },
};

/**
 * Payload của từng job.
 *
 * Nguyên tắc: payload chỉ chứa ID và tham số điều khiển, KHÔNG chứa dữ liệu
 * nghiệp vụ đã sao chép và tuyệt đối không chứa token. Job có thể nằm trong
 * Redis hàng giờ; dữ liệu sao chép sẽ cũ, còn token thì không được rời khỏi DB
 * ở dạng có thể đọc (SECURITY.md §2.3).
 */
export interface QueuePayloads {
  'publish-post': { platformPostId: string; workspaceId: string; correlationId: string };
  'sync-posts': { socialAccountId: string; workspaceId: string; cursor?: string };
  'sync-comments': {
    platformPostId?: string;
    socialAccountId: string;
    workspaceId: string;
    since?: string;
  };
  'sync-post-metrics': { platformPostId: string; workspaceId: string };
  'sync-account-metrics': { socialAccountId: string; workspaceId: string };
  'refresh-social-token': { socialAccountId: string; workspaceId: string };
  'process-webhook': { webhookEventId: string };
  'retry-failed-post': { platformPostId: string; workspaceId: string; requestedByUserId: string };
  'generate-thumbnail': { mediaAssetId: string; workspaceId: string };
  'cleanup-unused-media': { olderThanDays: number };
  'sync-external-posts': {
    workspaceId: string;
    socialAccountId: string;
    requestedByUserId: string;
    cutoffDays: number;
    resumeFromJobId?: string;
  };
}

export type QueuePayload<Q extends QueueName> = QueuePayloads[Q];

export interface QueueJobOptions {
  jobId: string;
  attempts: number;
  backoff?: { type: 'exponential'; delay: number };
  removeOnComplete: { age: number; count: number };
  removeOnFail: { age: number };
  delay?: number;
}

/**
 * Khóa idempotency (dùng làm BullMQ jobId) — chặn job trùng ngay ở tầng queue.
 * Đây là lớp phòng thủ thứ nhất chống rủi ro R9 (double post); lớp thứ hai là
 * job lock trong Redis, lớp thứ ba là kiểm tra trạng thái trước khi gọi API.
 */
export function buildJobId<Q extends QueueName>(queue: Q, payload: QueuePayload<Q>): string {
  switch (queue) {
    case 'publish-post':
      return jobId(queue, (payload as QueuePayloads['publish-post']).platformPostId);
    case 'sync-posts': {
      const p = payload as QueuePayloads['sync-posts'];
      return jobId(queue, p.socialAccountId, p.cursor ?? 'start');
    }
    case 'sync-comments': {
      const p = payload as QueuePayloads['sync-comments'];
      return jobId(queue, p.platformPostId ?? p.socialAccountId, p.since ?? 'all');
    }
    case 'sync-post-metrics':
      return jobId(queue, (payload as QueuePayloads['sync-post-metrics']).platformPostId);
    case 'sync-account-metrics':
      return jobId(queue, (payload as QueuePayloads['sync-account-metrics']).socialAccountId);
    case 'refresh-social-token':
      return jobId(queue, (payload as QueuePayloads['refresh-social-token']).socialAccountId);
    case 'process-webhook':
      return jobId(queue, (payload as QueuePayloads['process-webhook']).webhookEventId);
    case 'retry-failed-post':
      return jobId(queue, (payload as QueuePayloads['retry-failed-post']).platformPostId);
    case 'generate-thumbnail':
      return jobId(queue, (payload as QueuePayloads['generate-thumbnail']).mediaAssetId);
    case 'cleanup-unused-media':
      return jobId(queue, String((payload as QueuePayloads['cleanup-unused-media']).olderThanDays));
    case 'sync-external-posts': {
      const p = payload as QueuePayloads['sync-external-posts'];
      return jobId(queue, p.socialAccountId, p.resumeFromJobId ?? 'start');
    }
    default: {
      const exhaustive: never = queue;
      throw new Error(`Queue chưa có quy tắc idempotency: ${String(exhaustive)}`);
    }
  }
}

function jobId(queue: QueueName, ...parts: string[]): string {
  return [queue, ...parts.map(encodeJobIdPart)].join('-');
}

export function buildQueueJobOptions<Q extends QueueName>(
  queue: Q,
  jobId: string,
  extra: Pick<QueueJobOptions, 'delay'> = {},
): QueueJobOptions {
  const settings = QUEUE_SETTINGS[queue];

  return {
    jobId,
    attempts: settings.attempts,
    backoff:
      settings.backoffDelayMs > 0
        ? { type: 'exponential', delay: settings.backoffDelayMs }
        : undefined,
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
    ...extra,
  };
}

function encodeJobIdPart(part: string): string {
  return encodeURIComponent(part).replace(/%/g, '_');
}
