import type { PrismaClientInstance } from '@socialhub/db';
import { buildJobId, type QueuePayload } from '@socialhub/shared';
import type { Queue } from 'bullmq';
import { logger } from '../logger';
import { buildJobOptions } from '../queue/queue-options';

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_LOOKAHEAD_MS = 60_000;
const SCAN_BATCH_SIZE = 100;

type PublishPostPayload = QueuePayload<'publish-post'>;

export interface ScheduledPostScannerInput {
  prisma: PrismaClientInstance;
  publishQueue: Queue;
  enabled: boolean;
  intervalMs?: number;
  lookaheadMs?: number;
}

export interface ScheduledPostScannerHandle {
  stop(): void;
}

export async function scanScheduledPostsOnce(input: {
  prisma: PrismaClientInstance;
  publishQueue: Queue;
  now?: Date;
  lookaheadMs?: number;
}): Promise<{ schedulesScanned: number; jobsQueued: number }> {
  const now = input.now ?? new Date();
  const upperBound = new Date(now.getTime() + (input.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS));

  const schedules = await input.prisma.postSchedule.findMany({
    where: {
      cancelledAt: null,
      scheduledAt: { lte: upperBound },
      contentPost: {
        deletedAt: null,
        status: 'SCHEDULED',
        platformPosts: {
          some: { status: { in: ['PENDING', 'QUEUED'] } },
        },
      },
    },
    include: {
      contentPost: {
        select: {
          id: true,
          workspaceId: true,
          platformPosts: {
            where: { status: { in: ['PENDING', 'QUEUED'] } },
            select: { id: true },
          },
        },
      },
    },
    orderBy: { scheduledAt: 'asc' },
    take: SCAN_BATCH_SIZE,
  });

  let jobsQueued = 0;
  const touchedContentPostIds = new Set<string>();

  for (const schedule of schedules) {
    const delay = Math.max(0, schedule.scheduledAt.getTime() - now.getTime());

    for (const platformPost of schedule.contentPost.platformPosts) {
      const payload: PublishPostPayload = {
        platformPostId: platformPost.id,
        workspaceId: schedule.contentPost.workspaceId,
        correlationId: `scheduled-scan:${schedule.id}`,
      };
      const jobId = buildJobId('publish-post', payload);

      await input.publishQueue.add('publish-post', payload, {
        ...buildJobOptions('publish-post', jobId),
        delay,
      });
      jobsQueued += 1;
      touchedContentPostIds.add(schedule.contentPost.id);
    }
  }

  if (touchedContentPostIds.size > 0) {
    await input.prisma.postSchedule.updateMany({
      where: { contentPostId: { in: [...touchedContentPostIds] } },
      data: { enqueuedAt: now },
    });
  }

  return { schedulesScanned: schedules.length, jobsQueued };
}

export function startScheduledPostScanner(
  input: ScheduledPostScannerInput,
): ScheduledPostScannerHandle {
  if (!input.enabled) {
    logger.info('Scheduled post scanner đang tắt bởi SCHEDULER_ENABLED=false');
    return { stop: () => undefined };
  }

  const intervalMs = input.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const lookaheadMs = input.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (running) {
      scheduleNext();
      return;
    }

    running = true;
    try {
      const result = await scanScheduledPostsOnce({
        prisma: input.prisma,
        publishQueue: input.publishQueue,
        lookaheadMs,
      });

      if (result.jobsQueued > 0) {
        logger.info(result, 'Đã quét và bù job publish theo lịch');
      } else {
        logger.debug(result, 'Không có bài lên lịch cần bù job');
      }
    } catch (error) {
      logger.error({ err: error }, 'Scheduled post scanner thất bại');
    } finally {
      running = false;
      scheduleNext();
    }
  };

  void tick();
  logger.info({ intervalMs, lookaheadMs }, 'Scheduled post scanner đã bật');

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
