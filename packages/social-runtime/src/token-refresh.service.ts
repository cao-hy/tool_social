import type { PrismaClientInstance } from '@socialhub/db';
import type { Keyring } from '@socialhub/security';
import { decryptToken, encryptToken } from '@socialhub/security';
import type { WorkspacePlatformResolver } from './types';

export interface TokenRefreshLock {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
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
    const acquired = await this.lock.acquire(lockKey, token, 15000);

    if (!acquired) {
      let attempts = 0;
      while (attempts < 10) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(1.2, attempts)));
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
    }

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

      const decryptedRefreshToken = decryptToken(account.token.refreshToken, this.keyring);
      const adapterContext = await this.platformResolver.forWorkspace(account.workspaceId);

      try {
        const adapter = adapterContext.adapters.get(account.platform);
        if (!adapter || !adapter.refreshToken) {
          throw new Error(
            `Adapter for platform ${account.platform} does not support token refresh`,
          );
        }

        const refreshed = await adapter.refreshToken(decryptedRefreshToken);

        const encryptedAccessToken = encryptToken(refreshed.accessToken, this.keyring);
        const encryptedRefreshToken = refreshed.refreshToken
          ? encryptToken(refreshed.refreshToken, this.keyring)
          : null;

        const updatedAccount = await this.prisma.socialAccount.updateMany({
          where: {
            id: accountId,
            tokenVersion: account.tokenVersion ?? 0,
          },
          data: {
            tokenVersion: { increment: 1 },
          },
        });

        if (updatedAccount.count === 0) {
          const latestAcc = await this.prisma.socialAccount.findUnique({
            where: { id: accountId },
            include: { token: true },
          });
          if (latestAcc?.token?.accessToken) {
            return decryptToken(latestAcc.token.accessToken, this.keyring);
          }
        }

        await this.prisma.socialToken.update({
          where: { socialAccountId: accountId },
          data: {
            accessToken: encryptedAccessToken.ciphertext,
            refreshToken: encryptedRefreshToken ? encryptedRefreshToken.ciphertext : undefined,
            encryptionKeyVersion: encryptedAccessToken.keyVersion,
            accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
            refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
            lastRefreshedAt: new Date(),
            refreshFailedCount: 0,
          },
        });

        return refreshed.accessToken;
      } finally {
        await adapterContext.release();
      }
    } finally {
      if (acquired) {
        await this.lock.release(lockKey, token).catch(() => {});
      }
    }
  }
}
