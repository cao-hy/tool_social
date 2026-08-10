import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPostProcessor } from '../processors/publish-post';
import { Keyring, encryptToken } from '@socialhub/security';
import { createPlatformError } from '@socialhub/platform-adapters';

describe('Publish Error Capture (P1-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('catches error and saves errorCode / errorMessage on PlatformPost', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const publishPost = vi
      .fn()
      .mockRejectedValue(
        createPlatformError('RATE_LIMITED', 'YOUTUBE', 'API Rate Limit', { retryable: false }),
      );
    const adapterFactory = {
      forWorkspace: vi.fn().mockResolvedValue({
        adapters: new Map([['YOUTUBE', { publishPost, validatePost: () => ({ valid: true }) }]]),
        release: vi.fn(),
      }),
    };
    const mockLocks = {
      withLock: vi.fn(async (_key, _ttl, fn) => fn()),
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
        update: vi.fn(),
        updateMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          contentPostId: 'content_1',
          status: 'QUEUED',
          externalPostId: null,
          platformState: {},
        }),
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
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'op_1', state: 'PREPARED', fence: 0, attemptId: null }),
        create: vi.fn().mockResolvedValue({ id: 'op_1' }),
        upsert: vi
          .fn()
          .mockResolvedValue({ id: 'op_1', state: 'PREPARED', fence: 0, attemptId: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (cb) => {
        return cb(prisma);
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

    try {
      await processor({
        data: {
          platformPostId: 'post_1',
          workspaceId: 'workspace_1',
        },
        id: 'job_1',
        attemptsMade: 1,
        opts: { attempts: 1 },
      } as any);
    } catch {
      // Ignore the UnrecoverableError thrown by the processor
    }

    // Verify error capture
    expect(prisma.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post_1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'RATE_LIMITED',
          errorMessage: 'API Rate Limit',
        }),
      }),
    );
  });
});
