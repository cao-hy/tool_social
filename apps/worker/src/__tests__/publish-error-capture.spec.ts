import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPostProcessor } from '../processors/publish-post';
import { Keyring, encryptToken } from '@socialhub/security';
import { RemoteRequestError } from '@socialhub/shared';
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
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          fence: 0,
          attemptId: null,
        }),
        create: vi.fn().mockResolvedValue({ id: 'op_1' }),
        upsert: vi.fn().mockResolvedValue({
          id: 'op_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          fence: 0,
          attemptId: null,
        }),
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

  it('Pinterest create Pin may-have-reached error becomes REMOTE_UNKNOWN with durable reconcile and no target retry', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    let platformPostStatus = 'QUEUED';
    let operation = {
      id: 'op_1',
      workspaceId: 'workspace_1',
      operationType: 'PUBLISH_POST',
      resourceType: 'PlatformPost',
      resourceId: 'post_1',
      state: 'PREPARED',
      fence: 0,
      attemptId: null as string | null,
      remoteStartedAt: null as Date | null,
    };
    const publishPost = vi
      .fn()
      .mockRejectedValue(
        new RemoteRequestError(
          "/v5/pins didn't finish after 7 seconds",
          'AWAITING_RESPONSE',
          true,
          undefined,
          'media-1',
        ),
      );
    const outboxUpsert = vi.fn().mockResolvedValue({});
    const platformPostUpdate = vi.fn(async ({ data }) => {
      if (typeof data.status === 'string') platformPostStatus = data.status;
      return {};
    });
    const operationUpdateMany = vi.fn(async ({ where, data }) => {
      if (where.state === 'PREPARED' && operation.state === 'PREPARED') {
        operation = {
          ...operation,
          state: 'DISPATCHING',
          attemptId: data.attemptId,
          fence: data.fence,
          remoteStartedAt: data.remoteStartedAt,
        };
        return { count: 1 };
      }
      if (data.state === 'REMOTE_UNKNOWN' && operation.state === 'DISPATCHING') {
        operation = {
          ...operation,
          state: 'REMOTE_UNKNOWN',
          fence: operation.fence + 1,
        };
        return { count: 1 };
      }
      if (data.state === 'PREPARED') {
        throw new Error('target mutation error must not rollback to PREPARED');
      }
      return { count: 0 };
    });

    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'post_1',
          workspaceId: 'workspace_1',
          contentPostId: 'content_1',
          platform: 'PINTEREST',
          socialAccountId: 'account_1',
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'PINTEREST',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            externalAccountId: 'user_1',
            externalPageId: 'board_1',
            token: {
              accessToken: encryptToken('access-token', keyring).ciphertext,
              accessTokenExpiresAt: null,
              refreshToken: null,
              refreshTokenExpiresAt: null,
            },
            scopes: [],
            name: 'Pinterest',
          },
          media: [],
          contentPost: {
            id: 'content_1',
            createdById: 'user_1',
            title: 'Pin',
            body: 'Body',
            linkUrl: null,
            hashtags: [],
            media: [],
            platformPosts: [],
          },
          status: platformPostStatus,
          platformState: {},
          publishFence: 0,
        })),
        update: platformPostUpdate,
        updateMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          contentPostId: 'content_1',
          status: 'REMOTE_RESULT_UNKNOWN',
          externalPostId: null,
          platformState: {},
        }),
        findMany: vi.fn().mockResolvedValue([{ status: 'REMOTE_RESULT_UNKNOWN' }]),
      },
      contentPost: { update: vi.fn() },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      outboundOperation: {
        findUnique: vi.fn(async () => operation),
        updateMany: operationUpdateMany,
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      outboxEvent: {
        upsert: outboxUpsert,
      },
      $transaction: vi.fn(async (cb) => cb(prisma)),
    };

    const processor = createPublishPostProcessor({
      prisma: prisma as any,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn().mockResolvedValue({
          adapters: new Map([
            ['PINTEREST', { publishPost, validatePost: () => ({ valid: true }) }],
          ]),
          release: vi.fn(),
        }),
      } as any,
      locks: { withLock: vi.fn(async (_key, _ttl, fn) => fn()) } as any,
      storage: {} as any,
    });

    const job = {
      data: {
        platformPostId: 'post_1',
        workspaceId: 'workspace_1',
        operationId: 'op_1',
      },
      id: 'job_1',
      attemptsMade: 0,
      opts: { attempts: 5 },
    };

    await expect(processor(job as any)).resolves.toEqual({
      published: false,
      reason: 'REMOTE_RESULT_UNKNOWN',
    });
    await expect(processor({ ...job, id: 'job_2', attemptsMade: 1 } as any)).resolves.toEqual({
      published: false,
      reason: 'REMOTE_RESULT_UNKNOWN',
    });

    expect(publishPost).toHaveBeenCalledTimes(1);
    expect(operationUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'PREPARED' }),
      }),
    );
    expect(platformPostStatus).toBe('REMOTE_RESULT_UNKNOWN');
    expect(outboxUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          topic: 'reconcile-platform-post',
          dedupeKey: expect.stringMatching(/^reconcile-publish:op_1:/),
        }),
      }),
    );
  });
});
