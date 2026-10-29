import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@socialhub/platform-adapters';
import { Keyring, encryptToken } from '@socialhub/security';
import { createDeletePlatformPostProcessor } from '../processors/delete-platform-post';
import { createModeratePlatformCommentProcessor } from '../processors/moderate-platform-comment';
import { createUpdatePlatformPostProcessor } from '../processors/update-platform-post';

function makeLocks() {
  return {
    withLock: vi.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
  };
}

describe('Async Mutations Processors (Update Post, Delete Post, Moderate Comment)', () => {
  it('update-platform-post commits Desired State to PlatformPost & ContentPost only after remote editPost succeeds', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const editPost = vi.fn().mockResolvedValue({ updated: true, externalPostId: 'fb_post_1' });

    const tx = {
      platformPost: {
        findUnique: vi.fn().mockResolvedValue({
          platformState: { pendingUpdate: { state: 'PROCESSING' } },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      contentPost: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      outboundOperation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'pp_1',
          workspaceId: 'ws_1',
          contentPostId: 'cp_1',
          platform: 'FACEBOOK',
          status: 'PUBLISHED',
          externalPostId: 'fb_post_1',
          caption: 'old caption',
          title: 'old title',
          description: null,
          linkUrl: null,
          options: null,
          media: [],
          platformState: {
            pendingUpdate: {
              state: 'QUEUED',
              desired: {
                caption: 'new caption #sale',
                title: 'new title',
              },
            },
          },
          socialAccount: {
            id: 'sa_1',
            workspaceId: 'ws_1',
            platform: 'FACEBOOK',
            externalAccountId: 'page_1',
            externalPageId: 'page_1',
            name: 'PreAureum FB',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            scopes: ['pages_manage_posts'],
            token: {
              id: 'tok_1',
              accessToken: encryptToken('fb-token', keyring).ciphertext,
              refreshToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          },
          contentPost: {
            id: 'cp_1',
            title: 'old title',
            body: 'old caption',
            linkUrl: null,
            hashtags: [],
            deletedAt: null,
            media: [],
          },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      outboundOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_upd_1',
          workspaceId: 'ws_1',
          operationType: 'UPDATE_POST',
          resourceType: 'PlatformPost',
          resourceId: 'pp_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (cb) => cb(tx)),
    };

    const processor = createUpdatePlatformPostProcessor({
      prisma: prisma as never,
      keyring,
      locks: makeLocks() as never,
      adapterFactory: {
        forWorkspace: vi.fn().mockResolvedValue({
          adapters: {
            requireCapability: vi.fn().mockReturnValue({ editPost }),
          },
          release: vi.fn(),
        }),
      } as never,
    });

    const res = await processor({
      id: 'job_upd_1',
      data: {
        platformPostId: 'pp_1',
        contentPostId: 'cp_1',
        workspaceId: 'ws_1',
        requestedByUserId: 'user_1',
        correlationId: 'corr_upd_1',
        operationId: 'op_upd_1',
        desired: {
          title: 'new title',
          caption: 'new caption #sale',
          hashtags: ['sale'],
        },
        updateContentPostFields: {
          title: 'new title',
          body: 'new caption',
          hashtags: ['sale'],
        },
      },
    } as never);

    expect(res).toMatchObject({ updated: true, contentPostId: 'cp_1' });
    expect(editPost).toHaveBeenCalledTimes(1);
    expect(tx.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pp_1' },
        data: expect.objectContaining({ caption: 'new caption #sale', title: 'new title' }),
      }),
    );
    expect(tx.contentPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cp_1', workspaceId: 'ws_1' },
        data: expect.objectContaining({
          title: 'new title',
          body: 'new caption',
          hashtags: ['sale'],
        }),
      }),
    );
  });

  it('delete-platform-post treats remote 404 NOT_FOUND as idempotent success, deletes ContentPost and marks unused media DELETE_PENDING', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const deletePost = vi
      .fn()
      .mockRejectedValue(
        new PlatformError('NOT_FOUND', 'FACEBOOK', 'Post does not exist', { retryable: false }),
      );
    const cleanupQueueAdd = vi.fn().mockResolvedValue({});

    const tx = {
      platformPostMedia: { deleteMany: vi.fn().mockResolvedValue({}) },
      comment: { deleteMany: vi.fn().mockResolvedValue({}) },
      postMetric: { deleteMany: vi.fn().mockResolvedValue({}) },
      metricSnapshot: { deleteMany: vi.fn().mockResolvedValue({}) },
      platformPost: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'pp_1',
          platformState: { pendingDelete: { state: 'PROCESSING' } },
        }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([{ id: 'pp_1', status: 'DELETED' }]),
      },
      contentPost: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboundOperation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'pp_1',
          workspaceId: 'ws_1',
          contentPostId: 'cp_1',
          platform: 'FACEBOOK',
          status: 'PUBLISHED',
          externalPostId: 'fb_post_404',
          platformState: { pendingDelete: { state: 'QUEUED' } },
          media: [{ mediaAssetId: 'media_1' }],
          socialAccount: {
            id: 'sa_1',
            workspaceId: 'ws_1',
            platform: 'FACEBOOK',
            externalAccountId: 'page_1',
            externalPageId: 'page_1',
            name: 'PreAureum FB',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            scopes: ['pages_manage_posts'],
            token: {
              id: 'tok_1',
              accessToken: encryptToken('fb-token', keyring).ciphertext,
              refreshToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          },
          contentPost: {
            id: 'cp_1',
            title: 'Post to delete',
            body: 'Body',
            deletedAt: null,
            media: [{ mediaAssetId: 'media_1' }],
          },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      contentPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'cp_1',
          media: [{ mediaAssetId: 'media_1' }],
          platformPosts: [{ id: 'pp_1', options: null, media: [{ mediaAssetId: 'media_1' }] }],
        }),
      },
      contentPostMedia: { findMany: vi.fn().mockResolvedValue([]) },
      platformPostMedia: { findMany: vi.fn().mockResolvedValue([]) },
      mediaAsset: {
        findMany: vi.fn().mockResolvedValue([{ id: 'media_1' }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboundOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_del_1',
          workspaceId: 'ws_1',
          operationType: 'DELETE_POST',
          resourceType: 'PlatformPost',
          resourceId: 'pp_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 2,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (cb) => cb(tx)),
    };

    const processor = createDeletePlatformPostProcessor({
      prisma: prisma as never,
      keyring,
      locks: makeLocks() as never,
      cleanupMediaQueue: { add: cleanupQueueAdd } as never,
      adapterFactory: {
        forWorkspace: vi.fn().mockResolvedValue({
          adapters: {
            requireCapability: vi.fn().mockReturnValue({ deletePost }),
          },
          release: vi.fn(),
        }),
      } as never,
    });

    const res = await processor({
      id: 'job_del_1',
      data: {
        platformPostId: 'pp_1',
        contentPostId: 'cp_1',
        workspaceId: 'ws_1',
        requestedByUserId: 'user_1',
        correlationId: 'corr_del_1',
        operationId: 'op_del_1',
        deleteContentPostWhenDone: true,
      },
    } as never);

    expect(res).toMatchObject({
      deleted: true,
      contentDeleted: true,
      mediaMarkedForCleanup: 1,
    });
    expect(tx.contentPost.deleteMany).toHaveBeenCalledWith({
      where: { id: 'cp_1', workspaceId: 'ws_1' },
    });
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledTimes(1);
    expect(cleanupQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('moderate-platform-comment rolls back optimistic soft-delete when remote delete permanently fails', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const deleteComment = vi.fn().mockRejectedValue(
      new PlatformError('PERMISSION_DENIED', 'FACEBOOK', 'Missing moderation scope', {
        retryable: false,
      }),
    );
    const restoreUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    const prisma = {
      comment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'comment_1',
          workspaceId: 'ws_1',
          platform: 'FACEBOOK',
          platformPostId: 'pp_1',
          externalCommentId: 'fb_cmt_1',
          isFromPage: false,
          deletedAt: new Date(),
          platformPost: { id: 'pp_1', contentPostId: 'cp_1' },
          socialAccount: {
            id: 'sa_1',
            workspaceId: 'ws_1',
            platform: 'FACEBOOK',
            externalAccountId: 'page_1',
            externalPageId: 'page_1',
            name: 'PreAureum FB',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            scopes: ['pages_manage_engagement'],
            token: {
              id: 'tok_1',
              accessToken: encryptToken('fb-token', keyring).ciphertext,
              refreshToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          },
        }),
        updateMany: restoreUpdateMany,
      },
      outboundOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_mod_1',
          workspaceId: 'ws_1',
          operationType: 'MODERATE_COMMENT',
          resourceType: 'Comment',
          resourceId: 'comment_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 1,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      socialAccount: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'CONNECTED',
          disconnectGeneration: 1,
        }),
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (cb) =>
        cb({
          comment: { updateMany: restoreUpdateMany },
          outboundOperation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        }),
      ),
    };

    const processor = createModeratePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      locks: makeLocks() as never,
      adapterFactory: {
        forWorkspace: vi.fn().mockResolvedValue({
          adapters: {
            requireCapability: vi.fn().mockReturnValue({ deleteComment }),
          },
          release: vi.fn(),
        }),
      } as never,
    });

    await expect(
      processor({
        id: 'job_mod_1',
        attemptsMade: 0,
        opts: { attempts: 3 },
        data: {
          commentId: 'comment_1',
          platformPostId: 'pp_1',
          socialAccountId: 'sa_1',
          workspaceId: 'ws_1',
          requestedByUserId: 'user_1',
          correlationId: 'corr_mod_1',
          action: 'DELETE_COMMENT',
          operationId: 'op_mod_1',
        },
      } as never),
    ).rejects.toThrow('Missing moderation scope');

    expect(restoreUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws_1',
        OR: [{ id: 'comment_1' }, { parentId: 'comment_1' }],
      },
      data: { deletedAt: null },
    });
  });
});
