import { randomUUID } from 'node:crypto';
import {
  QUEUE_NAMES,
  workspaceRealtimeChannel,
  type QueueName,
  type WorkspaceRealtimeEvent,
} from '@socialhub/shared';
import { scrubSecretsFromText } from '@socialhub/security';
import { Queue, Worker, type Job, type Processor } from 'bullmq';
import type Redis from 'ioredis';
import { buildWorkerOptions } from './queue-options';
import { logger } from '../logger';

export type QueueProcessor = Processor<unknown, unknown, string>;

const POST_MUTATION_QUEUES = new Set<QueueName>([
  'publish-post',
  'update-platform-post',
  'delete-platform-post',
  'retry-failed-post',
  'sync-external-posts',
  'reconcile-platform-post',
]);

const MEDIA_MUTATION_QUEUES = new Set<QueueName>(['generate-thumbnail', 'cleanup-unused-media']);

const METRICS_MUTATION_QUEUES = new Set<QueueName>(['sync-post-metrics', 'sync-account-metrics']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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

  publishRealtime(
    workspaceId: string | undefined,
    partial: Omit<WorkspaceRealtimeEvent, 'id' | 'workspaceId' | 'timestamp'>,
  ): void {
    if (!workspaceId) return;
    const event: WorkspaceRealtimeEvent = {
      id: randomUUID(),
      workspaceId,
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this.connection
      .publish(workspaceRealtimeChannel(workspaceId), JSON.stringify(event))
      .catch((err: unknown) => {
        logger.debug({ err, workspaceId, type: event.type }, 'Không publish được sự kiện realtime');
      });
  }

  registerWorker(name: QueueName, processor: QueueProcessor): Worker {
    const worker = new Worker(name, processor, {
      connection: this.connection,
      ...buildWorkerOptions(name, this.concurrencyMultiplier),
    });

    worker.on('active', (job: Job) => {
      const data = asRecord(job.data);
      const workspaceId = asString(data?.workspaceId);
      this.publishRealtime(workspaceId, {
        type: 'job.active',
        queueName: name,
        jobId: job.id,
        platformPostId: asString(data?.platformPostId),
        contentPostId: asString(data?.contentPostId) ?? asString(data?.postId),
        mediaAssetId: asString(data?.mediaAssetId),
        socialAccountId: asString(data?.socialAccountId),
      });
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
      const cleanMessage = scrubSecretsFromText(error.message);
      logger.error(
        {
          queue: name,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          maxAttempts: job?.opts.attempts,
          err: { name: error.name, message: cleanMessage },
        },
        'Job thất bại',
      );

      const data = asRecord(job?.data);
      const workspaceId = asString(data?.workspaceId);
      const isFinalAttempt = (job?.attemptsMade ?? 1) >= (job?.opts.attempts ?? 1);

      this.publishRealtime(workspaceId, {
        type: 'job.failed',
        queueName: name,
        jobId: job?.id,
        platformPostId: asString(data?.platformPostId),
        contentPostId: asString(data?.contentPostId) ?? asString(data?.postId),
        mediaAssetId: asString(data?.mediaAssetId),
        socialAccountId: asString(data?.socialAccountId),
        errorMessage: cleanMessage,
      });

      if (isFinalAttempt && name === 'create-platform-comment') {
        this.publishRealtime(workspaceId, {
          type: 'comment.create_failed',
          queueName: name,
          jobId: job?.id,
          platformPostId: asString(data?.platformPostId),
          commandId: asString(data?.commandId),
          errorMessage: cleanMessage,
        });
      } else if (isFinalAttempt && name === 'reply-platform-comment') {
        this.publishRealtime(workspaceId, {
          type: 'comment.reply_failed',
          queueName: name,
          jobId: job?.id,
          commentId: asString(data?.commentId),
          replyRecordId: asString(data?.replyRecordId),
          errorMessage: cleanMessage,
        });
      } else if (isFinalAttempt && name === 'moderate-platform-comment') {
        this.publishRealtime(workspaceId, {
          type: 'comment.moderation_failed',
          queueName: name,
          jobId: job?.id,
          commentId: asString(data?.commentId),
          platformPostId: asString(data?.platformPostId),
          errorMessage: cleanMessage,
        });
        this.publishRealtime(workspaceId, {
          type: 'comments.synced',
          queueName: name,
          jobId: job?.id,
          platformPostId: asString(data?.platformPostId),
        });
        this.publishRealtime(workspaceId, {
          type: 'posts.changed',
          queueName: name,
          jobId: job?.id,
          platformPostId: asString(data?.platformPostId),
        });
      } else if (POST_MUTATION_QUEUES.has(name)) {
        this.publishRealtime(workspaceId, {
          type: 'posts.changed',
          queueName: name,
          jobId: job?.id,
          contentPostId: asString(data?.contentPostId) ?? asString(data?.postId),
          platformPostId: asString(data?.platformPostId),
        });
        if (
          isFinalAttempt &&
          (name === 'publish-post' ||
            name === 'retry-failed-post' ||
            name === 'update-platform-post' ||
            name === 'delete-platform-post')
        ) {
          this.publishRealtime(workspaceId, {
            type: 'notification.created',
            queueName: name,
            jobId: job?.id,
            platformPostId: asString(data?.platformPostId),
          });
          if (name === 'publish-post' || name === 'retry-failed-post') {
            this.publishRealtime(workspaceId, {
              type: 'accounts.changed',
              queueName: name,
              jobId: job?.id,
            });
          }
        }
      } else if (MEDIA_MUTATION_QUEUES.has(name)) {
        this.publishRealtime(workspaceId, {
          type: 'media.updated',
          queueName: name,
          jobId: job?.id,
          mediaAssetId: asString(data?.mediaAssetId),
          errorMessage: cleanMessage,
        });
      } else if (name === 'refresh-social-token') {
        this.publishRealtime(workspaceId, {
          type: 'accounts.changed',
          queueName: name,
          jobId: job?.id,
          socialAccountId: asString(data?.socialAccountId),
          errorMessage: cleanMessage,
        });
      } else if (METRICS_MUTATION_QUEUES.has(name)) {
        this.publishRealtime(workspaceId, {
          type: 'metrics.synced',
          queueName: name,
          jobId: job?.id,
          socialAccountId: asString(data?.socialAccountId),
          errorMessage: cleanMessage,
        });
      }
    });

    worker.on('completed', (job: Job, returnValue: unknown) => {
      logger.debug({ queue: name, jobId: job.id }, 'Job hoàn tất');

      const data = asRecord(job.data);
      const res = asRecord(returnValue);
      const workspaceId = asString(data?.workspaceId);

      if (name === 'create-platform-comment') {
        if (res?.created === true) {
          this.publishRealtime(workspaceId, {
            type: 'comment.created',
            queueName: name,
            jobId: job.id,
            contentPostId: asString(res.contentPostId),
            platformPostId: asString(res.platformPostId) ?? asString(data?.platformPostId),
            commentId: asString(res.commentId),
            commandId: asString(res.commandId) ?? asString(data?.commandId),
            platform: asString(res.platformCode) ?? asString(res.platform),
          });
          this.publishRealtime(workspaceId, {
            type: 'job.completed',
            queueName: name,
            jobId: job.id,
          });
        } else {
          const errMsg = scrubSecretsFromText(
            asString(res?.errorMessage) ?? asString(res?.reason) ?? 'Không thể tạo bình luận.',
          );
          this.publishRealtime(workspaceId, {
            type: 'comment.create_failed',
            queueName: name,
            jobId: job.id,
            platformPostId: asString(res?.platformPostId) ?? asString(data?.platformPostId),
            commandId: asString(res?.commandId) ?? asString(data?.commandId),
            errorMessage: errMsg,
          });
          this.publishRealtime(workspaceId, {
            type: 'job.failed',
            queueName: name,
            jobId: job.id,
            errorMessage: errMsg,
          });
        }
        return;
      }

      if (name === 'reply-platform-comment') {
        if (res?.replied === true) {
          this.publishRealtime(workspaceId, {
            type: 'comment.replied',
            queueName: name,
            jobId: job.id,
            contentPostId: asString(res.contentPostId),
            platformPostId: asString(res.platformPostId),
            commentId: asString(res.commentId) ?? asString(data?.commentId),
            replyRecordId: asString(res.replyRecordId) ?? asString(data?.replyRecordId),
            platform: asString(res.platformCode) ?? asString(res.platform),
          });
          this.publishRealtime(workspaceId, {
            type: 'job.completed',
            queueName: name,
            jobId: job.id,
          });
        } else {
          const errMsg = scrubSecretsFromText(
            asString(res?.errorMessage) ?? asString(res?.reason) ?? 'Không thể trả lời bình luận.',
          );
          this.publishRealtime(workspaceId, {
            type: 'comment.reply_failed',
            queueName: name,
            jobId: job.id,
            commentId: asString(res?.commentId) ?? asString(data?.commentId),
            replyRecordId: asString(res?.replyRecordId) ?? asString(data?.replyRecordId),
            errorMessage: errMsg,
          });
          this.publishRealtime(workspaceId, {
            type: 'job.failed',
            queueName: name,
            jobId: job.id,
            errorMessage: errMsg,
          });
        }
        return;
      }

      if (name === 'moderate-platform-comment') {
        this.publishRealtime(workspaceId, {
          type: 'comment.moderated',
          queueName: name,
          jobId: job.id,
          contentPostId: asString(res?.contentPostId),
          platformPostId: asString(res?.platformPostId) ?? asString(data?.platformPostId),
          commentId: asString(res?.commentId) ?? asString(data?.commentId),
          platform: asString(res?.platform),
        });
        this.publishRealtime(workspaceId, {
          type: 'comments.synced',
          queueName: name,
          jobId: job.id,
          platformPostId: asString(res?.platformPostId) ?? asString(data?.platformPostId),
        });
        this.publishRealtime(workspaceId, {
          type: 'posts.changed',
          queueName: name,
          jobId: job.id,
          contentPostId: asString(res?.contentPostId),
          platformPostId: asString(res?.platformPostId) ?? asString(data?.platformPostId),
        });
        this.publishRealtime(workspaceId, {
          type: 'job.completed',
          queueName: name,
          jobId: job.id,
        });
        return;
      }

      this.publishRealtime(workspaceId, {
        type: 'job.completed',
        queueName: name,
        jobId: job.id,
        mediaAssetId: asString(data?.mediaAssetId),
        socialAccountId: asString(data?.socialAccountId),
      });

      if (name === 'sync-comments') {
        this.publishRealtime(workspaceId, {
          type: 'comments.synced',
          queueName: name,
          jobId: job.id,
          platformPostId: asString(data?.platformPostId),
          socialAccountId: asString(data?.socialAccountId),
        });
        this.publishRealtime(workspaceId, {
          type: 'posts.changed',
          queueName: name,
          jobId: job.id,
          platformPostId: asString(data?.platformPostId),
        });
        this.publishRealtime(workspaceId, {
          type: 'accounts.changed',
          queueName: name,
          jobId: job.id,
          socialAccountId: asString(data?.socialAccountId),
        });
        if (res?.reason === 'capability_unsupported') {
          this.publishRealtime(workspaceId, {
            type: 'notification.created',
            queueName: name,
            jobId: job.id,
          });
        }
      } else if (POST_MUTATION_QUEUES.has(name)) {
        this.publishRealtime(workspaceId, {
          type: 'posts.changed',
          queueName: name,
          jobId: job.id,
          contentPostId: asString(data?.contentPostId) ?? asString(data?.postId),
          platformPostId: asString(data?.platformPostId),
        });
        if (name === 'publish-post' || name === 'retry-failed-post') {
          this.publishRealtime(workspaceId, {
            type: 'notification.created',
            queueName: name,
            jobId: job.id,
            platformPostId: asString(data?.platformPostId),
          });
          if (res?.published === false) {
            this.publishRealtime(workspaceId, {
              type: 'accounts.changed',
              queueName: name,
              jobId: job.id,
            });
          }
        } else if (name === 'sync-external-posts') {
          this.publishRealtime(workspaceId, {
            type: 'accounts.changed',
            queueName: name,
            jobId: job.id,
            socialAccountId: asString(data?.socialAccountId),
          });
        } else if (
          name === 'delete-platform-post' &&
          typeof res?.mediaMarkedForCleanup === 'number' &&
          res.mediaMarkedForCleanup > 0
        ) {
          this.publishRealtime(workspaceId, {
            type: 'media.updated',
            queueName: name,
            jobId: job.id,
          });
        }
      } else if (MEDIA_MUTATION_QUEUES.has(name)) {
        this.publishRealtime(workspaceId, {
          type: 'media.updated',
          queueName: name,
          jobId: job.id,
          mediaAssetId: asString(data?.mediaAssetId),
        });
      } else if (name === 'refresh-social-token') {
        this.publishRealtime(workspaceId, {
          type: 'accounts.changed',
          queueName: name,
          jobId: job.id,
          socialAccountId: asString(data?.socialAccountId),
        });
      } else if (METRICS_MUTATION_QUEUES.has(name)) {
        this.publishRealtime(workspaceId, {
          type: 'metrics.synced',
          queueName: name,
          jobId: job.id,
          socialAccountId: asString(data?.socialAccountId),
        });
        if (name === 'sync-post-metrics') {
          this.publishRealtime(workspaceId, {
            type: 'posts.changed',
            queueName: name,
            jobId: job.id,
            platformPostId: asString(data?.platformPostId),
          });
        } else if (name === 'sync-account-metrics') {
          this.publishRealtime(workspaceId, {
            type: 'accounts.changed',
            queueName: name,
            jobId: job.id,
            socialAccountId: asString(data?.socialAccountId),
          });
        }
      }
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
