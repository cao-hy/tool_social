import { describe, expect, it, vi } from 'vitest';
import { RemoteRequestError } from '@socialhub/shared';
import { Keyring, encryptToken } from '@socialhub/security';
import { createPublishPostProcessor } from '../processors/publish-post';

function basePost(keyring: Keyring) {
  return {
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
      title: 'Post',
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
  };
}

describe('T37 route release on publish failure boundaries', () => {
  it.each([
    [
      'BEFORE_CONNECT',
      async () => {
        throw new RemoteRequestError('connect failed', 'BEFORE_CONNECT', false);
      },
      false,
    ],
    [
      'REMOTE_UNKNOWN',
      async () => {
        throw new RemoteRequestError('response lost', 'AWAITING_RESPONSE', true);
      },
      false,
    ],
    [
      'unexpected error',
      async () => {
        throw new Error('unexpected provider error');
      },
      false,
    ],
    [
      'local commit failure',
      async () => ({
        externalPostId: 'remote_1',
        externalUrl: 'https://youtube.example/remote_1',
        publishedAt: new Date('2026-08-10T00:00:00.000Z'),
      }),
      true,
    ],
  ] as const)(
    '%s releases prepared route exactly once',
    async (_name, publishImpl, failLocalCommit) => {
      const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
      const release = vi.fn();
      const outboundUpdateMany = vi.fn(async ({ where, data }) => {
        if (where.state === 'PREPARED') return { count: 1 };
        if (where.state === 'DISPATCHING' && data.state === 'REMOTE_CONFIRMED') return { count: 1 };
        if (where.state === 'DISPATCHING') return { count: 1 };
        return { count: 0 };
      });
      const processor = createPublishPostProcessor({
        prisma: {
          platformPost: {
            findFirst: vi.fn(async () => basePost(keyring)),
            findUnique: vi.fn(async () => ({ contentPostId: 'content_1', platformState: {} })),
            update: vi.fn(async () => ({})),
            updateMany: vi.fn(async () => ({ count: 1 })),
            findMany: vi.fn(async () => []),
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
          notification: { create: vi.fn(async () => ({})) },
          $transaction: vi.fn(async (callback) => {
            if (failLocalCommit) throw new Error('local commit failed');
            return callback({});
          }),
        } as never,
        keyring,
        adapterFactory: {
          forWorkspace: vi.fn(async () => ({
            adapters: new Map([
              ['YOUTUBE', { validatePost: () => ({ valid: true }), publishPost: publishImpl }],
            ]),
            proxy: { config: { enabled: true, countryLock: null }, egressPolicy: 'PROXY_REQUIRED' },
            release,
          })),
        } as never,
        locks: { withLock: vi.fn(async (_key, _ttl, callback) => callback()) } as never,
        storage: {} as never,
      });

      await processor({
        id: 'job_1',
        attemptsMade: 0,
        opts: { attempts: 2 },
        data: { platformPostId: 'post_1', workspaceId: 'workspace_1' },
      }).catch(() => undefined);

      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('stale owner before route preparation does not prepare or release a route', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const release = vi.fn();
    const publishPost = vi.fn();
    const processor = createPublishPostProcessor({
      prisma: {
        platformPost: {
          findFirst: vi.fn(async () => basePost(keyring)),
          findUnique: vi.fn(async () => ({ contentPostId: 'content_1', platformState: {} })),
          update: vi.fn(async () => ({})),
          updateMany: vi.fn(async () => ({ count: 1 })),
          findMany: vi.fn(async () => []),
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
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
        backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      } as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: new Map([['YOUTUBE', { validatePost: () => ({ valid: true }), publishPost }]]),
          proxy: { config: { enabled: true, countryLock: null }, egressPolicy: 'PROXY_REQUIRED' },
          release,
        })),
      } as never,
      locks: { withLock: vi.fn(async (_key, _ttl, callback) => callback()) } as never,
      storage: {} as never,
    });

    await processor({
      id: 'job_1',
      attemptsMade: 0,
      opts: { attempts: 2 },
      data: { platformPostId: 'post_1', workspaceId: 'workspace_1' },
    }).catch(() => undefined);

    expect(publishPost).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
