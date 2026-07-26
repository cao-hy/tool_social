import { QUEUE_SETTINGS, type QueueName } from '@socialhub/shared';
import type { JobsOptions, WorkerOptions } from 'bullmq';

/**
 * Cấu hình mặc định cho job — prompt §10.
 *
 * `removeOnComplete` / `removeOnFail` là bắt buộc, không phải tối ưu vặt:
 * Redis giữ toàn bộ lịch sử job trong bộ nhớ. Một hệ thống đồng bộ metric mỗi
 * giờ cho hàng trăm bài đăng sẽ làm đầy Redis trong vài ngày nếu không dọn.
 * Bản ghi bền vững nằm ở bảng `BackgroundJob` trong Postgres, nên xóa khỏi
 * Redis không mất khả năng điều tra sự cố.
 */
export function buildJobOptions(queue: QueueName, jobId: string): JobsOptions {
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
  };
}

export function buildWorkerOptions(
  queue: QueueName,
  concurrencyMultiplier = 1,
): Pick<WorkerOptions, 'concurrency' | 'maxStalledCount' | 'stalledInterval'> {
  const settings = QUEUE_SETTINGS[queue];

  return {
    concurrency: Math.max(1, Math.round(settings.concurrency * concurrencyMultiplier)),
    // Job "stalled" là job mà worker đã nhận nhưng không báo tiến độ (thường do
    // process bị giết giữa chừng). Cho phép 1 lần phục hồi; nhiều hơn thì gần
    // như chắc chắn job đó đang làm treo worker và cần điều tra thay vì lặp lại.
    maxStalledCount: 1,
    stalledInterval: 30_000,
  };
}
