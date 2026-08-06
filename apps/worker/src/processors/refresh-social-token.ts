import { AdapterRegistry, isPlatformError } from '@socialhub/platform-adapters';
import { createPrismaClient, type PrismaClientInstance } from '@socialhub/db';
import { decryptToken, encryptToken, type Keyring } from '@socialhub/security';
import { z } from 'zod';
import type { ProxyConfig } from '@socialhub/shared';
import { logger } from '../logger';
import { loadWorkspaceProxyConfig } from '../utils/proxy';
import type { JobLockService } from '../queue/job-lock';

const refreshSocialTokenPayloadSchema = z.object({
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
});

export function createRefreshSocialTokenProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapters: AdapterRegistry;
  createAdapters?: (proxyConfig: ProxyConfig) => AdapterRegistry;
  locks?: JobLockService;
}) {
  return async (job: { data: unknown; id?: string }) => {
    const payload = refreshSocialTokenPayloadSchema.parse(job.data);

    const token = await input.prisma.socialToken.findUnique({
      where: { socialAccountId: payload.socialAccountId },
      include: { socialAccount: true },
    });

    if (!token || token.socialAccount.workspaceId !== payload.workspaceId) {
      logger.warn({ jobId: job.id, payload }, 'Không tìm thấy social token để refresh');
      return { refreshed: false, reason: 'not_found' };
    }

    const proxyConfig = await loadWorkspaceProxyConfig(
      input.prisma,
      input.keyring,
      payload.workspaceId,
    );
    const adapters = input.createAdapters?.(proxyConfig) ?? input.adapters;
    const adapter = adapters.get(token.socialAccount.platform);
    if (!token.refreshToken || !adapter.refreshToken) {
      await input.prisma.socialAccount.update({
        where: { id: token.socialAccountId },
        data: {
          status: 'NEEDS_RECONNECT',
          lastErrorAt: new Date(),
          lastErrorMessage: 'Refresh token chưa được nền tảng này xác minh hoặc chưa có.',
        },
      });
      return { refreshed: false, reason: 'refresh_not_available' };
    }

    await input.prisma.auditLog.create({
      data: {
        workspaceId: payload.workspaceId,
        action: 'SOCIAL_TOKEN_ACCESSED',
        resourceType: 'SocialToken',
        resourceId: token.id,
        metadata: { purpose: 'refresh-social-token', jobId: job.id },
      },
    });

    try {
      const refreshToken = decryptToken(token.refreshToken, input.keyring);
      const doRefresh = async () => adapter.refreshToken(refreshToken);

      const lockKey = `token-refresh:${token.socialAccountId}`;
      let tokenSet;
      if (input.locks) {
        const result = await input.locks.withLock(lockKey, 15000, doRefresh);
        if (!result) {
          logger.warn({ jobId: job.id, payload }, 'Tiến trình khác đang refresh token');
          return { refreshed: false, reason: 'locked' };
        }
        tokenSet = result;
      } else {
        tokenSet = await doRefresh();
      }

      const encryptedAccessToken = encryptToken(tokenSet.accessToken, input.keyring);
      const encryptedRefreshToken = tokenSet.refreshToken
        ? encryptToken(tokenSet.refreshToken, input.keyring)
        : null;

      await input.prisma.$transaction([
        input.prisma.socialToken.update({
          where: { id: token.id },
          data: {
            accessToken: encryptedAccessToken.ciphertext,
            refreshToken: encryptedRefreshToken?.ciphertext ?? token.refreshToken,
            encryptionKeyVersion: encryptedAccessToken.keyVersion,
            accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt ?? token.refreshTokenExpiresAt,
            lastRefreshedAt: new Date(),
            refreshFailedCount: 0,
          },
        }),
        input.prisma.socialAccount.update({
          where: { id: token.socialAccountId },
          data: { status: 'CONNECTED', lastErrorAt: null, lastErrorMessage: null },
        }),
        input.prisma.auditLog.create({
          data: {
            workspaceId: payload.workspaceId,
            action: 'SOCIAL_TOKEN_REFRESHED',
            resourceType: 'SocialAccount',
            resourceId: token.socialAccountId,
            metadata: { platform: token.socialAccount.platform, jobId: job.id },
          },
        }),
      ]);

      return { refreshed: true };
    } catch (error) {
      if (isPlatformError(error) && error.kind === 'AUTH_INVALID') {
        await input.prisma.socialAccount.update({
          where: { id: token.socialAccountId },
          data: {
            status: 'DISCONNECTED',
            lastErrorAt: new Date(),
            lastErrorMessage: error.message,
          },
        });
        return { refreshed: false, reason: 'auth_invalid' };
      }

      await input.prisma.socialToken.update({
        where: { id: token.id },
        data: { refreshFailedCount: { increment: 1 } },
      });
      throw error;
    }
  };
}

export function createWorkerPrisma(databaseUrl: string, logQueries: boolean): PrismaClientInstance {
  return createPrismaClient({ databaseUrl, logQueries });
}
