import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconciliationProcessor } from '../processors/reconciliation.processor';

const getFreshAccessTokenMock = vi.hoisted(() => vi.fn(async () => 'fresh-access-token'));

vi.mock('../processors/token-refresh', () => ({
  getFreshAccessToken: getFreshAccessTokenMock,
}));

function createPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'platform-post-1',
    workspaceId: 'workspace-1',
    contentPostId: 'content-post-1',
    socialAccountId: 'account-1',
    platform: 'FACEBOOK',
    status: 'REMOTE_RESULT_UNKNOWN',
    publishAttemptId: 'attempt-1',
    reconciliationAttempts: 0,
    platformState: {
      remoteCheckpoint: {
        phase: 'PUBLISH_INITIALIZED',
        remotePublishId: 'remote-publish-1',
      },
    },
    socialAccount: {
      id: 'account-1',
      workspaceId: 'workspace-1',
      platform: 'FACEBOOK',
      externalAccountId: 'external-account-1',
      externalPageId: null,
      token: { id: 'token-1' },
    },
    contentPost: { id: 'content-post-1' },
    ...overrides,
  };
}

function createOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'operation-1',
    workspaceId: 'workspace-1',
    operationType: 'PUBLISH_POST',
    resourceType: 'PlatformPost',
    resourceId: 'platform-post-1',
    state: 'REMOTE_UNKNOWN',
    attemptId: 'attempt-1',
    fence: 3,
    ...overrides,
  };
}

function createHarness({
  post = createPost(),
  operation = createOperation(),
  reconcilePublish = vi.fn(async () => ({
    result: 'INDETERMINATE' as const,
    reason: 'Chưa xác định được kết quả phía remote.',
  })),
  childStatuses = ['REMOTE_RESULT_UNKNOWN'],
  operationUpdateCount = 1,
}: {
  post?: ReturnType<typeof createPost>;
  operation?: ReturnType<typeof createOperation> | null;
  reconcilePublish?: ReturnType<typeof vi.fn>;
  childStatuses?: string[];
  operationUpdateCount?: number;
} = {}) {
  const updates: unknown[] = [];
  const adapter = { reconcilePublish };
  const prisma = {
    $transaction: vi.fn(async (fn) => fn(prisma)),
    outboundOperation: {
      findUnique: vi.fn(async () => operation),
      findFirst: vi.fn(async () => operation),
      updateMany: vi.fn(async () => ({ count: operationUpdateCount })),
    },
    platformPost: {
      findUnique: vi.fn(async () => post),
      update: vi.fn(async (args) => {
        updates.push(args);
        return { ...post, ...args.data };
      }),
      findMany: vi.fn(async () => childStatuses.map((status) => ({ status }))),
    },
    contentPost: {
      update: vi.fn(async (args) => args),
    },
  };
  const platformResolver = {
    withWorkspace: vi.fn(async (_workspaceId, callback) =>
      callback({ adapters: new Map([['FACEBOOK', adapter]]) }),
    ),
  };
  const processor = createReconciliationProcessor({
    prisma: prisma as never,
    keyring: {} as never,
    platformResolver: platformResolver as never,
  });

  return { processor, prisma, platformResolver, reconcilePublish, updates };
}

describe('createReconciliationProcessor', () => {
  beforeEach(() => {
    getFreshAccessTokenMock.mockClear();
  });

  it('INDETERMINATE lần đầu update attempts rồi throw để BullMQ retry', async () => {
    const { processor, prisma } = createHarness();

    await expect(
      processor({
        data: {
          platformPostId: 'platform-post-1',
          workspaceId: 'workspace-1',
          publishAttemptId: 'attempt-1',
          operationId: 'operation-1',
        },
      }),
    ).rejects.toThrow('Chưa xác định được kết quả phía remote.');

    expect(prisma.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'operation-1',
          state: 'REMOTE_UNKNOWN',
          attemptId: 'attempt-1',
          fence: 3,
        },
        data: expect.objectContaining({
          reconciliationAttempts: { increment: 1 },
          requiresManualReview: false,
        }),
      }),
    );
    expect(prisma.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'platform-post-1' },
        data: expect.objectContaining({
          reconciliationAttempts: 1,
          requiresManualReview: false,
        }),
      }),
    );
  });

  it('INDETERMINATE lần thứ 5 chuyển sang manual review và không throw', async () => {
    const { processor, prisma } = createHarness({
      post: createPost({ reconciliationAttempts: 4 }),
    });

    await expect(
      processor({
        data: {
          platformPostId: 'platform-post-1',
          workspaceId: 'workspace-1',
          publishAttemptId: 'attempt-1',
          operationId: 'operation-1',
        },
      }),
    ).resolves.toMatchObject({ status: 'MANUAL_REVIEW_REQUIRED' });

    expect(prisma.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reconciliationAttempts: 5,
          requiresManualReview: true,
        }),
      }),
    );
  });

  it('FOUND chuyển PlatformPost thành PUBLISHED và cập nhật parent status', async () => {
    const { processor, prisma, reconcilePublish } = createHarness({
      reconcilePublish: vi.fn(async () => ({
        result: 'FOUND' as const,
        remotePostId: 'remote-post-1',
        remoteUrl: 'https://social.test/post/remote-post-1',
      })),
      childStatuses: ['PUBLISHED'],
    });

    await expect(
      processor({
        data: {
          platformPostId: 'platform-post-1',
          workspaceId: 'workspace-1',
          publishAttemptId: 'attempt-1',
          operationId: 'operation-1',
        },
      }),
    ).resolves.toMatchObject({
      status: 'RESOLVED_PUBLISHED',
      externalPostId: 'remote-post-1',
    });

    expect(reconcilePublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publishAttemptId: 'attempt-1',
        remoteCheckpoint: expect.objectContaining({ remotePublishId: 'remote-publish-1' }),
      }),
    );
    expect(prisma.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PUBLISHED',
          externalPostId: 'remote-post-1',
          requiresManualReview: false,
        }),
      }),
    );
    expect(prisma.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'LOCAL_COMMITTED',
          remoteId: 'remote-post-1',
        }),
      }),
    );
    expect(prisma.contentPost.update).toHaveBeenCalled();
  });

  it('CONFIRMED_ABSENT chuyển PlatformPost thành FAILED và cập nhật parent status', async () => {
    const { processor, prisma } = createHarness({
      reconcilePublish: vi.fn(async () => ({ result: 'CONFIRMED_ABSENT' as const })),
      childStatuses: ['FAILED'],
    });

    await expect(
      processor({
        data: {
          platformPostId: 'platform-post-1',
          workspaceId: 'workspace-1',
          publishAttemptId: 'attempt-1',
          operationId: 'operation-1',
        },
      }),
    ).resolves.toMatchObject({ status: 'RESOLVED_FAILED' });

    expect(prisma.platformPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'CONFIRMED_ABSENT',
        }),
      }),
    );
    expect(prisma.contentPost.update).toHaveBeenCalled();
  });

  it('bỏ qua reconciliation job thuộc publish attempt cũ', async () => {
    const { processor, platformResolver } = createHarness({
      operation: createOperation({ attemptId: 'attempt-2' }),
    });

    await expect(
      processor({
        data: {
          platformPostId: 'platform-post-1',
          workspaceId: 'workspace-1',
          publishAttemptId: 'attempt-1',
          operationId: 'operation-1',
        },
      }),
    ).resolves.toMatchObject({ status: 'STALE_ATTEMPT' });

    expect(platformResolver.withWorkspace).not.toHaveBeenCalled();
  });

  it('discard stale reconciliation result when operation fence changed', async () => {
    const { processor, prisma } = createHarness({
      reconcilePublish: vi.fn(async () => ({
        result: 'FOUND' as const,
        remotePostId: 'remote-post-1',
        remoteUrl: 'https://social.test/post/remote-post-1',
      })),
      operationUpdateCount: 0,
    });

    await expect(
      processor({
        data: {
          platformPostId: 'platform-post-1',
          workspaceId: 'workspace-1',
          publishAttemptId: 'attempt-1',
          operationId: 'operation-1',
        },
      }),
    ).resolves.toMatchObject({ status: 'STALE_OPERATION' });

    expect(prisma.platformPost.update).not.toHaveBeenCalled();
    expect(prisma.contentPost.update).not.toHaveBeenCalled();
  });
});
