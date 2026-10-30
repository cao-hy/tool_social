import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

describe('PostsService Single-Store Isolation Guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createServiceWithTx(txMock: Record<string, unknown>) {
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
        cb(txMock),
      ),
    };
    const service = new (PostsService as unknown as new (...args: unknown[]) => PostsService)(
      prisma,
      { getClient: vi.fn().mockReturnValue({}) },
      { API_BASE_URL: 'http://localhost:4000', WEB_BASE_URL: 'http://localhost:3000' },
      {},
      {},
      { record: vi.fn() },
      {},
    );
    (service as unknown as { get: ReturnType<typeof vi.fn> }).get = vi
      .fn()
      .mockResolvedValue({ id: 'post_1', storeId: 'store_a' });
    return service;
  }

  it('rejects post creation when selected social accounts span multiple Stores', async () => {
    const txMock = {
      store: { findFirst: vi.fn().mockResolvedValue({ id: 'store_a' }) },
      contentPost: { create: vi.fn().mockResolvedValue({ id: 'post_1' }) },
      socialAccount: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'acc_a', name: 'Page Store A', platform: 'FACEBOOK', storeId: 'store_a' },
          { id: 'acc_b', name: 'Page Store B', platform: 'INSTAGRAM', storeId: 'store_b' },
        ]),
      },
      platformPost: { deleteMany: vi.fn(), create: vi.fn() },
      contentPostMedia: { deleteMany: vi.fn(), createMany: vi.fn() },
    };

    const service = createServiceWithTx(txMock);

    await expect(
      service.create(
        'workspace_1',
        'user_1',
        {
          storeId: 'store_a',
          body: 'Hello world',
          hashtags: [],
          socialAccountIds: ['acc_a', 'acc_b'],
          mediaAssetIds: [],
          platformOverrides: [],
        },
        { requestId: 'req_1' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(txMock.platformPost.create).not.toHaveBeenCalled();
  });

  it('rejects post creation when attaching a MediaAsset belonging to another Store', async () => {
    const txMock = {
      store: { findFirst: vi.fn().mockResolvedValue({ id: 'store_a' }) },
      contentPost: { create: vi.fn().mockResolvedValue({ id: 'post_1' }) },
      socialAccount: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'acc_a', name: 'Page Store A', platform: 'FACEBOOK', storeId: 'store_a' },
          ]),
      },
      platformPost: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'pp_1' }),
      },
      mediaAsset: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'media_b', workspaceId: 'workspace_1', storeId: 'store_b', status: 'READY' },
          ]),
      },
      contentPostMedia: { deleteMany: vi.fn(), createMany: vi.fn() },
    };

    const service = createServiceWithTx(txMock);

    await expect(
      service.create(
        'workspace_1',
        'user_1',
        {
          storeId: 'store_a',
          body: 'Hello world',
          hashtags: [],
          socialAccountIds: ['acc_a'],
          mediaAssetIds: ['media_b'],
          platformOverrides: [],
        },
        { requestId: 'req_2' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(txMock.contentPostMedia.createMany).not.toHaveBeenCalled();
  });
});
