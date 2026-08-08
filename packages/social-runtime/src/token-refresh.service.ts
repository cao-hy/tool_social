import type { PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { decryptToken, encryptToken } from '@socialhub/security';
import type { WorkspacePlatformResolver } from './types';

export interface TokenRefreshLock {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  extend(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
}

export class TokenRefreshBusyError extends Error {
  constructor(accountId: string) {
    super(`Timeout waiting for token refresh lock on account ${accountId}`);
    this.name = 'TokenRefreshBusyError';
  }
}

export class RefreshCasLostError extends Error {
  constructor() {
    super('Token refresh CAS lost to concurrent winner');
    this.name = 'RefreshCasLostError';
  }
}

export class TokenRefreshService {
  constructor(
    private readonly prisma: PrismaClientInstance,
    private readonly keyring: Keyring,
    private readonly lock: TokenRefreshLock,
    private readonly platformResolver: WorkspacePlatformResolver,
  ) {}

  async getValidAccessToken(accountId: string): Promise<string> {
    const lockKey = `token-refresh:${accountId}`;
    const token = Math.random().toString(36).substring(2);
    const LOCK_TTL = 120000;
    const HEARTBEAT_MS = 30000;

    const acquired = await this.lock.acquire(lockKey, token, LOCK_TTL);

    if (!acquired) {
      let attempts = 0;
      while (attempts < 15) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(1.2, attempts) + Math.random() * 50));
        const acc = await this.prisma.socialAccount.findUnique({
          where: { id: accountId },
          include: { token: true },
        });
        if (
          acc?.token?.accessToken &&
          acc.token.accessTokenExpiresAt &&
          acc.token.accessTokenExpiresAt.getTime() > Date.now() + 60000
        ) {
          return decryptToken(acc.token.accessToken, this.keyring);
        }
        attempts++;
      }
      throw new TokenRefreshBusyError(accountId);
    }

    let lockOwned = true;
    const heartbeatTimer = setInterval(async () => {
      try {
        const extended = await this.lock.extend(lockKey, token, LOCK_TTL);
        if (!extended) lockOwned = false;
      } catch {
        lockOwned = false;
      }
    }, HEARTBEAT_MS);

    try {
      const account = await this.prisma.socialAccount.findUnique({
        where: { id: accountId },
        include: { token: true },
      });
      if (!account) throw new Error(`SocialAccount not found: ${accountId}`);
      if (!account.token) throw new Error(`SocialToken not found for account: ${accountId}`);

      if (
        account.token.accessTokenExpiresAt &&
        account.token.accessTokenExpiresAt.getTime() > Date.now() + 60000
      ) {
        return decryptToken(account.token.accessToken, this.keyring);
      }

      if (!account.token.refreshToken) {
        throw new Error(`SocialAccount ${accountId} missing refresh token`);
      }

      if (!lockOwned) {
        throw new Error('Lost token refresh lock ownership before provider call');
      }

      const decryptedRefreshToken = decryptToken(account.token.refreshToken, this.keyring);

      return await this.platformResolver.withWorkspace(
        account.workspaceId,
        async ({ adapters }) => {
          const adapter = adapters.get(account.platform);
          if (!adapter || !adapter.refreshToken) {
            throw new Error(
              `Adapter for platform ${account.platform} does not support token refresh`,
            );
          }

          if (!lockOwned) {
            console.warn(`[TOKEN_REFRESH_LOCK_LOST_IN_FLIGHT] Account ${accountId}`);
          }

          const refreshed = await adapter.refreshToken(decryptedRefreshToken);

          const encryptedAccessToken = encryptToken(refreshed.accessToken, this.keyring);
          const encryptedRefreshToken = refreshed.refreshToken
            ? encryptToken(refreshed.refreshToken, this.keyring)
            : null;

          const oldVersion = account.tokenVersion ?? 0;

          try {
            await this.prisma.$transaction(async (tx) => {
              const won = await tx.socialAccount.updateMany({
                where: {
                  id: accountId,
                  tokenVersion: oldVersion,
                },
                data: {
                  tokenVersion: { increment: 1 },
                },
              });

              if (won.count !== 1) {
                throw new RefreshCasLostError();
              }

              await tx.socialToken.update({
                where: { socialAccountId: accountId },
                data: {
                  accessToken: encryptedAccessToken.ciphertext,
                  refreshToken: encryptedRefreshToken
                    ? encryptedRefreshToken.ciphertext
                    : undefined,
                  encryptionKeyVersion: encryptedAccessToken.keyVersion,
                  accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
                  refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
                  lastRefreshedAt: new Date(),
                  refreshFailedCount: 0,
                },
              });
            });
          } catch (err) {
            if (err instanceof RefreshCasLostError) {
              const latestAcc = await this.prisma.socialAccount.findUnique({
                where: { id: accountId },
                include: { token: true },
              });
              if (latestAcc?.token?.accessToken) {
                return decryptToken(latestAcc.token.accessToken, this.keyring);
              }
            }
            throw err;
          }

          return refreshed.accessToken;
        },
      );
    } finally {
      clearInterval(heartbeatTimer);
      if (acquired) {
        await this.lock.release(lockKey, token).catch(() => {});
      }
    }
  }
}
