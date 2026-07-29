import type { PrismaClientInstance } from '@socialhub/db';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { scanScheduledPostsOnce } from '../schedulers/scheduled-post-scanner';

describe('scheduled post scanner', () => {
  it('bù job publish cho bài đã đến lịch nhưng queue bị thiếu job', async () => {
    const now = new Date('2026-07-28T03:00:00.000Z');
    const prisma = {
      postSchedule: {
        findMany: vi.fn(async () => [
          {
            id: 'schedule_1',
            scheduledAt: new Date('2026-07-28T02:59:00.000Z'),
            contentPost: {
              id: 'post_1',
              workspaceId: 'workspace_1',
              platformPosts: [{ id: 'platform_post_1' }, { id: 'platform_post_2' }],
            },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as unknown as PrismaClientInstance;
    const publishQueue = {
      add: vi.fn(async () => undefined),
    } as unknown as Queue;

    const result = await scanScheduledPostsOnce({ prisma, publishQueue, now, lookaheadMs: 60_000 });

    expect(result).toEqual({ schedulesScanned: 1, jobsQueued: 2 });
    expect(prisma.postSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cancelledAt: null,
          scheduledAt: { lte: new Date('2026-07-28T03:01:00.000Z') },
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenNthCalledWith(
      1,
      'publish-post',
      {
        platformPostId: 'platform_post_1',
        workspaceId: 'workspace_1',
        correlationId: 'scheduled-scan:schedule_1',
      },
      expect.objectContaining({
        jobId: 'publish-post-platform_post_1',
        attempts: 5,
        delay: 0,
      }),
    );
    expect(publishQueue.add).toHaveBeenNthCalledWith(
      2,
      'publish-post',
      {
        platformPostId: 'platform_post_2',
        workspaceId: 'workspace_1',
        correlationId: 'scheduled-scan:schedule_1',
      },
      expect.objectContaining({
        jobId: 'publish-post-platform_post_2',
        attempts: 5,
        delay: 0,
      }),
    );
    expect(prisma.postSchedule.updateMany).toHaveBeenCalledWith({
      where: { contentPostId: { in: ['post_1'] } },
      data: { enqueuedAt: now },
    });
  });

  it('không ghi enqueuedAt khi không có schedule nào cần bù', async () => {
    const prisma = {
      postSchedule: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaClientInstance;
    const publishQueue = {
      add: vi.fn(async () => undefined),
    } as unknown as Queue;

    const result = await scanScheduledPostsOnce({
      prisma,
      publishQueue,
      now: new Date('2026-07-28T03:00:00.000Z'),
    });

    expect(result).toEqual({ schedulesScanned: 0, jobsQueued: 0 });
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(prisma.postSchedule.updateMany).not.toHaveBeenCalled();
  });
});
