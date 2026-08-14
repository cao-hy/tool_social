import { describe, expect, it, vi } from 'vitest';
import { Keyring, encryptToken } from '@socialhub/security';
import { createPublishPostProcessor } from '../processors/publish-post';

describe('Optional post-publish follow-up success protection', () => {
  it('T45 YouTube platform-state follow-up failure does not fail or republish primary publish', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const publishPost = vi.fn(async () => ({
      externalPostId: 'remote_video_1',
      externalUrl: 'https://youtube.example/watch?v=remote_video_1',
      publishedAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    const getVideoPlatformState = vi.fn(async () => {
      throw new Error('youtube processing status unavailable');
    });
    const txPlatformPostUpdate = vi.fn(async () => ({}));
    const platformPostUpdate = vi.fn(async () => ({}));
    const outboundUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'post_1',
          workspaceId: 'workspace_1',
          contentPostId: 'content_1',
          platform: 'YOUTUBE',
          socialAccountId: 'account_1',
          socialAccount: {
            id: 'account_1',
            workspaceId: 'workspace_1',
            platform: 'YOUTUBE',
            externalAccountId: 'external_account_1',
            externalPageId: null,
            name: 'Channel',
            status: 'CONNECTED',
            disconnectGeneration: 1,
            token: { accessToken: encryptToken('access-token', keyring).ciphertext },
            scopes: [],
          },
          media: [],
          contentPost: {
            id: 'content_1',
            media: [],
            createdById: 'user_1',
            title: 'Video',
            body: 'Body',
            hashtags: [],
            linkUrl: null,
            platformPosts: [],
          },
          status: 'QUEUED',
          externalPostId: null,
          caption: null,
          title: null,
          description: null,
          linkUrl: null,
          options: {},
          publishFence: 0,
        })),
        findUnique: vi.fn(async () => ({ contentPostId: 'content_1', platformState: {} })),
        update: platformPostUpdate,
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [{ status: 'PUBLISHED' }]),
      },
      contentPost: { update: vi.fn(async () => ({})) },
      socialAccount: {
        findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
      },
      outboundOperation: {
        findFirst: vi.fn(async () => ({
          id: 'operation_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        })),
        findUnique: vi.fn(async () => ({
          id: 'operation_1',
          workspaceId: 'workspace_1',
          operationType: 'PUBLISH_POST',
          resourceType: 'PlatformPost',
          resourceId: 'post_1',
          state: 'PREPARED',
          attemptId: null,
          fence: 0,
        })),
        updateMany: outboundUpdateMany,
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) =>
        callback({
          platformPost: { update: txPlatformPostUpdate },
          auditLog: { create: vi.fn(async () => ({})) },
          notification: { create: vi.fn(async () => ({})) },
          outboundOperation: { updateMany: vi.fn(async () => ({ count: 1 })) },
        }),
      ),
    };
    const release = vi.fn();
    const processor = createPublishPostProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: new Map([
            [
              'YOUTUBE',
              {
                platform: 'YOUTUBE',
                validatePost: () => ({ valid: true }),
                publishPost,
                getVideoPlatformState,
              },
            ],
          ]),
          proxy: null,
          release,
        })),
      } as never,
      locks: { withLock: vi.fn(async (_key, _ttl, callback) => callback()) } as never,
      storage: {} as never,
    });

    await expect(
      processor({
        id: 'job_1',
        data: { platformPostId: 'post_1', workspaceId: 'workspace_1' },
      }),
    ).resolves.toEqual({ published: true, externalPostId: 'remote_video_1' });

    expect(publishPost).toHaveBeenCalledTimes(1);
    expect(getVideoPlatformState).toHaveBeenCalledTimes(1);
    expect(txPlatformPostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PUBLISHED',
          externalPostId: 'remote_video_1',
        }),
      }),
    );
    expect(platformPostUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
