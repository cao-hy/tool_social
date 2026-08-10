import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPostProcessor } from '../processors/publish-post';
import { Keyring, encryptToken } from '@socialhub/security';

describe('Atomic Local Commit (P0-04) & Durable Remote Result Recovery (P0-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proves domain projection + REMOTE_CONFIRMED -> LOCAL_COMMITTED are in ONE PostgreSQL transaction, and recovers from durable checkpoint with 0 remote calls', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const publishPost = vi.fn();
    const adapterFactory = {
      forWorkspace: vi.fn().mockResolvedValue({
        adapters: new Map([['YOUTUBE', { publishPost, validatePost: () => ({ valid: true }) }]]),
        release: vi.fn(),
      }),
    };
    const mockLocks = {
      withLock: vi.fn(async (_key, _ttl, fn) => fn()),
    };

    const txMock = {
      platformPost: { update: vi.fn() },
      auditLog: { create: vi.fn() },
      notification: { create: vi.fn() },
      outboundOperation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'post_1',
          workspaceId: 'workspace_1',
          platform: 'YOUTUBE',
          socialAccountId: 'account_1',
          socialAccount: {
            id: 'account_1',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            token: { accessToken: encryptToken('access-token', keyring).ciphertext },
            scopes: [],
          },
          media: [],
          contentPost: { media: [], createdById: 'user_1' },
          status: 'QUEUED',
          publishFence: 0,
        }),
        findUnique: vi.fn().mockResolvedValue({
          contentPostId: 'content_1',
          status: 'QUEUED',
          externalPostId: null,
          platformState: {},
        }),
        update: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      contentPost: { update: vi.fn() },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      outboundOperation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'op_1',
          state: 'REMOTE_CONFIRMED',
          attemptId: 'attempt_1',
          fence: 1,
          remoteCheckpoint: {
            externalPostId: 'remote_123',
            externalUrl: 'https://youtube.com/watch?v=123',
            publishedAt: new Date().toISOString(),
          },
        }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_1',
          state: 'REMOTE_CONFIRMED',
          attemptId: 'attempt_1',
          fence: 1,
          remoteCheckpoint: {
            externalPostId: 'remote_123',
            externalUrl: 'https://youtube.com/watch?v=123',
            publishedAt: new Date().toISOString(),
          },
        }),
        upsert: vi.fn().mockResolvedValue({ id: 'op_1' }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (cb) => {
        return cb(txMock);
      }),
      socialToken: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const processor = createPublishPostProcessor({
      prisma: prisma as any,
      keyring,
      adapterFactory: adapterFactory as any,
      locks: mockLocks as any,
      storage: {} as any,
    });

    const result = await processor({
      data: {
        platformPostId: 'post_1',
        workspaceId: 'workspace_1',
      },
      id: 'job_1',
    });

    expect(result).toEqual({ published: true, externalPostId: 'remote_123' });

    // Remote call count on recovery = 0
    expect(publishPost).not.toHaveBeenCalled();

    // Proves ONE PostgreSQL transaction is used
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Assert domain projection inside tx
    expect(txMock.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED', externalPostId: 'remote_123' }),
      }),
    );
    expect(txMock.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'op_1',
          state: 'REMOTE_CONFIRMED',
        }),
        data: expect.objectContaining({ state: 'LOCAL_COMMITTED' }),
      }),
    );
  });
});
