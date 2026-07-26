import { QUEUE_NAMES, type QueueName } from '@socialhub/shared';
import { Queue, Worker, type Job, type Processor } from 'bullmq';
import type Redis from 'ioredis';
import { buildWorkerOptions } from './queue-options';
import { logger } from '../logger';

export type QueueProcessor = Processor<unknown, unknown, string>;

/**
 * Đăng ký và quản lý vòng đời của toàn bộ queue.
 *
 * Ở Phase 1, các queue được TẠO nhưng chưa có processor nghiệp vụ. Điều này có
 * chủ đích: nó chứng minh cấu hình queue, kết nối Redis, cơ chế tắt êm và
 * chính sách retry đều hoạt động — trước khi có bất kỳ logic nghiệp vụ nào có
 * thể che khuất lỗi hạ tầng. Processor thật được thêm từ Phase 5.
 */
export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();

  constructor(
    private readonly connection: Redis,
    private readonly concurrencyMultiplier = 1,
  ) {}

  createQueues(): void {
    for (const name of QUEUE_NAMES) {
      this.queues.set(name, new Queue(name, { connection: this.connection }));
    }
    logger.info({ queues: QUEUE_NAMES.length }, 'Đã khởi tạo queue');
  }

  getQueue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" chưa được khởi tạo`);
    return queue;
  }

  getQueueNames(): QueueName[] {
    return [...this.queues.keys()];
  }

  registerWorker(name: QueueName, processor: QueueProcessor): Worker {
    const worker = new Worker(name, processor, {
      connection: this.connection,
      ...buildWorkerOptions(name, this.concurrencyMultiplier),
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
      logger.error(
        {
          queue: name,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          maxAttempts: job?.opts.attempts,
          err: { name: error.name, message: error.message },
        },
        'Job thất bại',
      );
    });

    worker.on('completed', (job: Job) => {
      logger.debug({ queue: name, jobId: job.id }, 'Job hoàn tất');
    });

    worker.on('stalled', (jobId: string) => {
      // Cảnh báo, không phải lỗi: job stalled thường do process bị giết giữa
      // chừng. Nhưng nếu nó xảy ra thường xuyên thì đó là dấu hiệu job chạy quá
      // lâu mà không báo tiến độ, và cần chia nhỏ.
      logger.warn({ queue: name, jobId }, 'Job bị treo, sẽ được giao lại');
    });

    this.workers.set(name, worker);
    return worker;
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * Tắt êm — bắt buộc, không phải tùy chọn.
   *
   * Nếu không có bước này, MỖI LẦN DEPLOY sẽ giết những job đang chạy giữa
   * chừng. Với job publish, "giữa chừng" có thể là "đã gọi API nền tảng nhưng
   * chưa kịp lưu externalPostId" — dẫn thẳng tới đăng trùng ở lần retry.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    logger.info('Bắt đầu tắt êm: ngừng nhận job mới…');

    const closeAll = Promise.all([
      ...[...this.workers.values()].map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
    ]);

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs),
    );

    const result = await Promise.race([closeAll.then(() => 'closed' as const), timeout]);

    if (result === 'timeout') {
      logger.warn({ timeoutMs }, 'Hết thời gian chờ khi tắt — vẫn còn job đang chạy');
    } else {
      logger.info('Đã tắt êm hoàn tất');
    }

    this.workers.clear();
    this.queues.clear();
  }
}
