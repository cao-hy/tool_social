import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

describe('Real Transactional Outbox (P0-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normal initial publish atomically commits: PlatformPost state, OutboundOperation, OutboxEvent in ONE DB transaction', async () => {
    const txMock = {
      contentPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'post_1',
          workspaceId: 'workspace_1',
          status: 'DRAFT',
          platformPosts: [
            {
              id: 'platform_post_1',
              socialAccountId: 'account_1',
              status: 'DRAFT',
            },
          ],
        }),
        update: vi.fn(),
      },
      postSchedule: { deleteMany: vi.fn() },
      platformPost: { updateMany: vi.fn() },
      outboundOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'op_1' }),
        upsert: vi.fn().mockResolvedValue({ id: 'op_1' }),
      },
      outboxEvent: {
        create: vi.fn().mockResolvedValue({ id: 'event_1' }),
      },
    };

    const prisma = {
      $transaction: vi.fn(async (cb) => {
        return cb(txMock);
      }),
    };

    const mockRedis = { getClient: vi.fn().mockReturnValue({}) };
    const postsService = new (PostsService as any)(
      prisma as any,
      mockRedis as any,
      {},
      {},
      {},
      {},
      {},
    );
    // Inject mocks
    postsService.prisma = prisma as any;
    postsService.removeScheduledJobs = vi.fn();
    postsService.dispatchPublishOutboxEvent = vi.fn();
    postsService.audit = { record: vi.fn() };
    postsService.get = vi.fn().mockResolvedValue({ id: 'post_1' });

    await postsService.publishNow(
      'workspace_1',
      'post_1',
      'user_1',
      { socialAccountIds: ['account_1'] },
      { requestId: 'req_1' } as any,
    );

    // Verify exactly ONE transaction is used
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Verify PlatformPost state change
    expect(txMock.platformPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contentPostId: 'post_1',
          socialAccountId: { in: ['account_1'] },
        }),
        data: expect.objectContaining({ status: 'QUEUED' }),
      }),
    );

    // Verify OutboundOperation is created via upsert
    expect(txMock.outboundOperation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'platform_post_1',
        }),
      }),
    );

    // Verify OutboxEvent is created
    expect(txMock.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            queueName: 'publish-post',
            payload: expect.objectContaining({
              platformPostId: 'platform_post_1',
              operationId: 'op_1',
            }),
          }),
        }),
      }),
    );
  });
});
