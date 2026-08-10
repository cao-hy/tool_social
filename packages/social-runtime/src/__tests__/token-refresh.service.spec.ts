import { describe, expect, it, vi } from 'vitest';
import { encryptToken, Keyring } from '@socialhub/security';
import { InMemoryTokenRefreshLock, TokenRefreshService } from '../token-refresh.service';

function keyring() {
  return new Keyring([{ version: 'v1', key: Buffer.alloc(32, 7) }], 'v1');
}

describe('TokenRefreshService', () => {
  it('returns the concurrent winner token when refresh CAS loses', async () => {
    const keys = keyring();
    const oldAccess = encryptToken('old-access', keys);
    const oldRefresh = encryptToken('old-refresh', keys);
    const winnerAccess = encryptToken('winner-access', keys);
    const adapterRefresh = vi.fn(async () => ({
      accessToken: 'stale-loser-access',
      refreshToken: 'stale-loser-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: null,
    }));
    const oldAccount = {
      id: 'account_1',
      workspaceId: 'workspace_1',
      platform: 'YOUTUBE',
      tokenVersion: 1,
      token: {
        accessToken: oldAccess.ciphertext,
        refreshToken: oldRefresh.ciphertext,
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      },
    };
    const winnerAccount = {
      ...oldAccount,
      tokenVersion: 2,
      token: {
        ...oldAccount.token,
        accessToken: winnerAccess.ciphertext,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    };
    const socialAccountFindUnique = vi
      .fn()
      .mockResolvedValueOnce(oldAccount)
      .mockResolvedValueOnce(winnerAccount);
    const tx = {
      socialAccount: {
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      socialToken: {
        update: vi.fn(),
      },
    };
    const prisma = {
      socialAccount: { findUnique: socialAccountFindUnique },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const service = new TokenRefreshService(prisma as never, keys, new InMemoryTokenRefreshLock(), {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          adapters: new Map([['YOUTUBE', { refreshToken: adapterRefresh }]]),
          proxy: undefined,
          release: async () => undefined,
        } as never),
      ),
    });

    await expect(service.getValidAccessToken('account_1')).resolves.toBe('winner-access');
    expect(adapterRefresh).toHaveBeenCalledTimes(1);
    expect(tx.socialToken.update).not.toHaveBeenCalled();
  });

  it('T28 five concurrent refresh requests produce one durable winner and losers reuse it', async () => {
    const keys = keyring();
    const expiredAccess = encryptToken('expired-access', keys);
    const expiredRefresh = encryptToken('refresh-token', keys);
    let currentAccount = {
      id: 'account_1',
      workspaceId: 'workspace_1',
      platform: 'YOUTUBE',
      tokenVersion: 1,
      token: {
        accessToken: expiredAccess.ciphertext,
        refreshToken: expiredRefresh.ciphertext,
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      },
    };
    const adapterRefresh = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        accessToken: 'winner-access',
        refreshToken: 'winner-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        refreshTokenExpiresAt: null,
      };
    });
    const prisma = {
      socialAccount: {
        findUnique: vi.fn(async () => currentAccount),
      },
      $transaction: vi.fn(async (fn) =>
        fn({
          socialAccount: {
            updateMany: vi.fn(async ({ where }) => {
              if (where.tokenVersion !== currentAccount.tokenVersion) return { count: 0 };
              currentAccount = {
                ...currentAccount,
                tokenVersion: currentAccount.tokenVersion + 1,
              };
              return { count: 1 };
            }),
          },
          socialToken: {
            update: vi.fn(async ({ data }) => {
              currentAccount = {
                ...currentAccount,
                token: {
                  ...currentAccount.token,
                  accessToken: data.accessToken,
                  refreshToken: data.refreshToken,
                  accessTokenExpiresAt: data.accessTokenExpiresAt,
                },
              };
            }),
          },
        }),
      ),
    };
    const service = new TokenRefreshService(prisma as never, keys, new InMemoryTokenRefreshLock(), {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          adapters: new Map([['YOUTUBE', { refreshToken: adapterRefresh }]]),
          proxy: undefined,
          release: async () => undefined,
        } as never),
      ),
    });

    await expect(
      Promise.all(Array.from({ length: 5 }, () => service.getValidAccessToken('account_1'))),
    ).resolves.toEqual([
      'winner-access',
      'winner-access',
      'winner-access',
      'winner-access',
      'winner-access',
    ]);

    expect(adapterRefresh).toHaveBeenCalledTimes(1);
    expect(currentAccount.tokenVersion).toBe(2);
  });
});
