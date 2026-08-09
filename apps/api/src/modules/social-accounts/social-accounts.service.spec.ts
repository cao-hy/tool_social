import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken, Keyring } from '@socialhub/security';
import { SocialAccountsService } from './social-accounts.service';

const getJob = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ getJob, close })),
}));

describe('SocialAccountsService disconnect safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks DISCONNECTING before queue cleanup and still blocks dispatch if cleanup fails', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const access = encryptToken('access-token', keyring);
    const revokeToken = vi.fn();
    getJob.mockResolvedValueOnce({
      remove: vi.fn(async () => {
        throw new Error('redis unavailable');
      }),
    });
    const socialAccountUpdateMany = vi.fn(async () => ({ count: 1 }));
    const socialAccountUpdate = vi.fn(async () => ({}));
    const prisma = {
      socialAccount: {
        findFirst: vi.fn(async () => ({
          id: 'account_1',
          workspaceId: 'workspace_1',
          platform: 'YOUTUBE',
          token: { accessToken: access.ciphertext },
        })),
        updateMany: socialAccountUpdateMany,
        update: socialAccountUpdate,
      },
      platformPost: {
        findMany: vi.fn(async () => [{ id: 'platform_post_1' }]),
      },
      socialToken: {
        deleteMany: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (items) => Promise.all(items)),
    };
    const service = new SocialAccountsService(
      prisma as never,
      { getClient: vi.fn(() => ({})) } as never,
      {} as never,
      keyring,
      {
        withWorkspace: vi.fn(async (_workspaceId, fn) =>
          fn({ adapters: new Map([['YOUTUBE', { revokeToken }]]) }),
        ),
      } as never,
      { record: vi.fn() } as never,
    );

    await expect(
      service.disconnect('workspace_1', 'account_1', 'user_1', { requestId: 'req_1' }),
    ).resolves.toEqual({ disconnected: true });

    expect(socialAccountUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'account_1',
        workspaceId: 'workspace_1',
        deletedAt: null,
        status: { not: 'DISCONNECTED' },
      },
      data: {
        status: 'DISCONNECTING',
        disconnectGeneration: { increment: 1 },
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(socialAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'account_1' },
      data: { status: 'DISCONNECTED', deletedAt: expect.any(Date) },
    });
  });
});
