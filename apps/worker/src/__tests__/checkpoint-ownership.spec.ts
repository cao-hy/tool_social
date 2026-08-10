import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Keyring, encryptToken } from '@socialhub/security';
import { createPublishPostProcessor } from '../processors/publish-post';

describe('Checkpoint Ownership (P1-02)', () => {
  const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops and does not restart mutation if checkpoint persistence fails', async () => {
    // We want to simulate a failure when storeRemoteCheckpoint is called.
    const outboundOperationUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 }) // First call for beginOutboundAttempt
      .mockResolvedValueOnce({ count: 0 }) // Second call for storeRemoteCheckpoint
      .mockResolvedValueOnce({ count: 1 }); // Third call marks REMOTE_UNKNOWN
    const platformPostUpdate = vi.fn();

    const prisma = {
      platformPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'post_1',
          workspaceId: 'workspace_1',
          platform: 'YOUTUBE',
          socialAccountId: 'account_1',
          publishGeneration: 1,
          socialAccount: {
            status: 'CONNECTED',
            disconnectGeneration: 1,
            token: { accessToken: encryptToken('access-token', keyring).ciphertext },
            scopes: [],
          },
          media: [],
          contentPost: {
            createdById: 'user_1',
            media: [],
          },
        }),
        update: platformPostUpdate,
        findUnique: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      contentPost: {
        update: vi.fn(),
      },
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
        updateMany: outboundOperationUpdateMany, // Returns count: 0 for checkpoint update!
      },
      backgroundJob: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (cb) => cb(prisma)),
      notification: {
        create: vi.fn(),
      },
    };

    const adapter = {
      validatePost: () => ({ valid: true }),
      publishPost: vi.fn().mockImplementation(async (context) => {
        await context.onRemoteCheckpoint({ status: 'uploading' });
        return { externalPostId: 'ext_1', url: 'http://youtube.com/ext_1' };
      }),
    };

    const adapterFactory = {
      forWorkspace: vi.fn().mockResolvedValue({
        adapters: new Map([['YOUTUBE', adapter]]),
        proxy: null,
        release: vi.fn(),
      }),
    };

    const job = {
      id: 'job_1',
      name: 'publish-post',
      attemptsMade: 1,
      opts: { attempts: 1 },
      data: {
        platformPostId: 'post_1',
        workspaceId: 'workspace_1',
      },
      updateProgress: vi.fn(),
      log: vi.fn(),
    } as any;

    const ctx: any = {
      prisma: prisma as any,
      adapterFactory: adapterFactory as any,
      keyring,
      locks: {
        acquire: vi.fn().mockResolvedValue(true),
        extend: vi.fn(),
        release: vi.fn(),
        withLock: vi.fn(async (_key, _ttl, fn) => fn()),
      } as any,
      storage: {
        client: {} as any,
        bucket: 'test-bucket',
      },
    } as any;

    const processor = createPublishPostProcessor(ctx);

    await expect(processor(job)).resolves.toEqual({
      published: false,
      reason: 'REMOTE_RESULT_UNKNOWN',
    });

    // It should have called updateMany to update checkpoint
    expect(outboundOperationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'op_1',
          state: 'DISPATCHING',
          attemptId: expect.any(String),
          fence: 1,
        }),
        data: expect.objectContaining({
          remoteCheckpoint: expect.objectContaining({ status: 'uploading' }),
        }),
      }),
    );
    expect(outboundOperationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'REMOTE_UNKNOWN',
          lastErrorCode: 'REMOTE_RESULT_UNKNOWN',
        }),
      }),
    );
    expect(platformPostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REMOTE_RESULT_UNKNOWN',
          errorCode: 'REMOTE_RESULT_UNKNOWN',
        }),
      }),
    );
    expect(platformPostUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });
});
