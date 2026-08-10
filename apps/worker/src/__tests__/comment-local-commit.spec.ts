import { describe, expect, it, vi } from 'vitest';
import { Keyring, encryptToken } from '@socialhub/security';
import { createCreatePlatformCommentProcessor } from '../processors/create-platform-comment';
import { createReplyPlatformCommentProcessor } from '../processors/reply-platform-comment';

describe('Comment/reply REMOTE_CONFIRMED recovery (D1/E/G)', () => {
  it('create comment redelivery performs local commit only from durable checkpoint', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const createComment = vi.fn();
    const tx = {
      comment: {
        upsert: vi.fn().mockResolvedValue({ id: 'comment_local_1' }),
      },
      commentCreateCommand: {
        update: vi.fn().mockResolvedValue({}),
      },
      outboundOperation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'platform_post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'YOUTUBE',
            externalAccountId: 'external_account_1',
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
          platformPostId: 'platform_post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        }),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      outboundOperation: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'operation_1',
            state: 'REMOTE_CONFIRMED',
            attemptId: 'attempt_1',
            fence: 2,
          })
          .mockResolvedValueOnce({
            remoteCheckpoint: {
              externalCommentId: 'remote_comment_1',
              postedAt: '2026-08-10T00:00:00.000Z',
            },
          }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
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
          platformPostId: 'platform_post_1',
          socialAccountId: 'account_1',
          workspaceId: 'workspace_1',
          message: 'hello',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          operationId: 'operation_1',
        },
      }),
    ).resolves.toMatchObject({
      created: true,
      externalCommentId: 'remote_comment_1',
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(tx.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'operation_1',
          state: 'REMOTE_CONFIRMED',
          attemptId: 'attempt_1',
          fence: 2,
        },
        data: expect.objectContaining({ state: 'LOCAL_COMMITTED' }),
      }),
    );
  });

  it('reply redelivery performs local commit only from durable checkpoint', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const replyToComment = vi.fn();
    const tx = {
      commentReply: {
        update: vi.fn().mockResolvedValue({}),
      },
      comment: {
        update: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
      },
      outboundOperation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      comment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'comment_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          externalCommentId: 'remote_comment_1',
          parent: null,
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'YOUTUBE',
            externalAccountId: 'external_account_1',
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
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      outboundOperation: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'operation_1',
            state: 'REMOTE_CONFIRMED',
            attemptId: 'attempt_1',
            fence: 2,
          })
          .mockResolvedValueOnce({
            remoteCheckpoint: {
              externalReplyId: 'remote_reply_1',
              sentAt: '2026-08-10T00:00:00.000Z',
            },
          }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
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
    ).resolves.toMatchObject({
      replied: true,
      externalReplyId: 'remote_reply_1',
    });

    expect(replyToComment).not.toHaveBeenCalled();
    expect(tx.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'operation_1',
          state: 'REMOTE_CONFIRMED',
          attemptId: 'attempt_1',
          fence: 2,
        },
        data: expect.objectContaining({ state: 'LOCAL_COMMITTED' }),
      }),
    );
  });

  it('reply local commit failure after REMOTE_CONFIRMED does not overwrite reply as FAILED', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const replyToComment = vi.fn();
    const topLevelReplyUpdate = vi.fn();
    const tx = {
      commentReply: {
        update: vi.fn().mockRejectedValue(new Error('local commit unavailable')),
      },
      comment: {
        update: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
      },
      outboundOperation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      comment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'comment_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          externalCommentId: 'remote_comment_1',
          parent: null,
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'YOUTUBE',
            externalAccountId: 'external_account_1',
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
        update: topLevelReplyUpdate,
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      outboundOperation: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'operation_1',
            state: 'REMOTE_CONFIRMED',
            attemptId: 'attempt_1',
            fence: 2,
          })
          .mockResolvedValueOnce({
            remoteCheckpoint: {
              externalReplyId: 'remote_reply_1',
              sentAt: '2026-08-10T00:00:00.000Z',
            },
          })
          .mockResolvedValueOnce({
            state: 'REMOTE_CONFIRMED',
          }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
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
        attemptsMade: 0,
        opts: { attempts: 2 },
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
    ).rejects.toThrow('local commit unavailable');

    expect(replyToComment).not.toHaveBeenCalled();
    expect(topLevelReplyUpdate).not.toHaveBeenCalled();
  });
});
