import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishPostProcessor } from '../processors/publish-post';
import { createCreatePlatformCommentProcessor } from '../processors/create-platform-comment';
import { createReplyPlatformCommentProcessor } from '../processors/reply-platform-comment';
import { Keyring, encryptToken } from '@socialhub/security';

describe('Worker disconnect safety (P1-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('worker refuses target mutation for non-CONNECTED account or if disconnectGeneration changed', async () => {
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
      contentPost: {
        update: vi.fn(),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'DISCONNECTING',
          disconnectGeneration: 2,
        }),
      },
      outboundOperation: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'op_1' }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: vi.fn() },
      notification: { create: vi.fn() },
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
      });
    } catch {
      // Ignore
    }

    // Worker reaches pre-dispatch check -> provider mutation call count = 0
    expect(publishPost).not.toHaveBeenCalled();
    expect(prisma.platformPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('worker rechecks disconnect generation after acquiring outbound ownership and before provider dispatch', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const publishPost = vi.fn();
    const adapterFactory = {
      forWorkspace: vi.fn().mockResolvedValue({
        adapters: new Map([['YOUTUBE', { publishPost, validatePost: () => ({ valid: true }) }]]),
        release: vi.fn(),
      }),
    };
    const outboundUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'post_1',
          workspaceId: 'workspace_1',
          contentPostId: 'content_1',
          platform: 'YOUTUBE',
          socialAccountId: 'account_1',
          socialAccount: {
            id: 'account_1',
            name: 'YouTube',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            externalAccountId: 'external_1',
            externalPageId: null,
            token: { accessToken: encryptToken('access-token', keyring).ciphertext },
            scopes: [],
          },
          media: [],
          contentPost: { id: 'content_1', media: [], createdById: 'user_1', title: 'Post' },
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
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ status: 'CONNECTED', disconnectGeneration: 1 })
          .mockResolvedValueOnce({ status: 'DISCONNECTING', disconnectGeneration: 2 }),
      },
      outboundOperation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'op_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        }),
        updateMany: outboundUpdateMany,
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const processor = createPublishPostProcessor({
      prisma: prisma as any,
      keyring,
      adapterFactory: adapterFactory as any,
      locks: { withLock: vi.fn(async (_key, _ttl, fn) => fn()) } as any,
      storage: {} as any,
    });

    await expect(
      processor({
        data: { platformPostId: 'post_1', workspaceId: 'workspace_1' },
        id: 'job_1',
      }),
    ).resolves.toEqual({ published: false, reason: 'account_disconnected' });

    expect(publishPost).not.toHaveBeenCalled();
    expect(outboundUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'DISPATCHING' }),
      }),
    );
    expect(outboundUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'op_1', state: 'DISPATCHING' }),
        data: expect.objectContaining({ state: 'PREPARED' }),
      }),
    );
  });

  it('create comment refuses provider mutation when disconnect begins before dispatch', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const createComment = vi.fn();
    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'YOUTUBE',
            externalAccountId: 'external_1',
            externalPageId: null,
            name: 'Channel',
            avatarUrl: null,
            status: 'CONNECTED',
            disconnectGeneration: 1,
            token: { accessToken: encryptToken('access-token', keyring).ciphertext },
            scopes: [],
          },
          contentPost: {},
        }),
      },
      commentCreateCommand: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'command_1',
          workspaceId: 'workspace_1',
          platformPostId: 'post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        }),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'DISCONNECTING',
          disconnectGeneration: 2,
        }),
      },
      outboundOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'operation_1',
          workspaceId: 'workspace_1',
          operationType: 'CREATE_COMMENT',
          resourceType: 'CommentCreateCommand',
          resourceId: 'command_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const processor = createCreatePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn().mockResolvedValue({
          adapters: {
            requireCapability: vi.fn().mockReturnValue({
              createComment,
              refreshToken: vi.fn(),
            }),
          },
          release: vi.fn(),
        }),
      } as never,
    });

    await expect(
      processor({
        id: 'job_1',
        data: {
          commandId: 'command_1',
          platformPostId: 'post_1',
          socialAccountId: 'account_1',
          workspaceId: 'workspace_1',
          message: 'hello',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          operationId: 'operation_1',
        },
      }),
    ).rejects.toThrow('ACCOUNT_DISCONNECTED');

    expect(createComment).not.toHaveBeenCalled();
  });

  it('reply refuses provider mutation when disconnect begins before dispatch', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const replyToComment = vi.fn();
    const prisma = {
      comment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'comment_1',
          workspaceId: 'workspace_1',
          platformPostId: 'post_1',
          externalCommentId: 'remote_comment_1',
          parent: null,
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'YOUTUBE',
            externalAccountId: 'external_1',
            externalPageId: null,
            name: 'Channel',
            avatarUrl: null,
            status: 'CONNECTED',
            disconnectGeneration: 1,
            token: { accessToken: encryptToken('access-token', keyring).ciphertext },
          },
          platformPost: {},
        }),
      },
      commentReply: {
        findFirst: vi.fn().mockResolvedValue({ id: 'reply_1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'DISCONNECTING',
          disconnectGeneration: 2,
        }),
      },
      outboundOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'operation_1',
          workspaceId: 'workspace_1',
          operationType: 'REPLY_COMMENT',
          resourceType: 'CommentReply',
          resourceId: 'reply_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const processor = createReplyPlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn().mockResolvedValue({
          adapters: {
            requireCapability: vi.fn().mockReturnValue({
              replyToComment,
              refreshToken: vi.fn(),
            }),
          },
          release: vi.fn(),
        }),
      } as never,
    });

    await expect(
      processor({
        id: 'job_1',
        data: {
          commentId: 'comment_1',
          workspaceId: 'workspace_1',
          message: 'reply',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          replyRecordId: 'reply_1',
          operationId: 'operation_1',
        },
      }),
    ).rejects.toThrow('ACCOUNT_DISCONNECTED');

    expect(replyToComment).not.toHaveBeenCalled();
  });
});
