import { type SocialPlatformAdapter } from '@socialhub/platform-adapters';
import type { PrismaClientInstance } from '@socialhub/db';
import { decryptToken, type Keyring } from '@socialhub/security';
import { InMemoryTokenRefreshLock, TokenRefreshService } from '@socialhub/social-runtime';
import type { Platform } from '@socialhub/shared';
import type { JobLockService } from '../queue/job-lock';

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const localTokenRefreshLock = new InMemoryTokenRefreshLock();

export async function getFreshAccessToken(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  locks?: JobLockService;
  adapter: SocialPlatformAdapter;
  account: {
    id: string;
    workspaceId: string;
    platform: Platform;
    token: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
      accessTokenExpiresAt: Date | null;
      refreshTokenExpiresAt: Date | null;
    } | null;
  };
}): Promise<string> {
  const { account, adapter, keyring, prisma } = input;
  if (!account.token) throw new Error('Social account chưa có token.');

  if (
    !account.token.accessTokenExpiresAt ||
    account.token.accessTokenExpiresAt.getTime() > Date.now() + REFRESH_THRESHOLD_MS
  ) {
    return decryptToken(account.token.accessToken, keyring);
  }

  if (!account.token.refreshToken) {
    await markDisconnected(
      prisma,
      account.id,
      'Token đã hết hạn và nền tảng này không có refresh token. Hãy kết nối lại tài khoản.',
    );
    throw new Error('Token đã hết hạn. Hãy kết nối lại tài khoản.');
  }

  const service = new TokenRefreshService(prisma, keyring, localTokenRefreshLock, {
    withWorkspace: async (_workspaceId, fn) =>
      fn({
        adapters: {
          get: (platform: Platform) => (platform === account.platform ? adapter : undefined),
        } as never,
        proxy: undefined as never,
        release: async () => undefined,
      }),
  });

  return await service.getValidAccessToken(account.id);
}

function markDisconnected(
  prisma: PrismaClientInstance,
  socialAccountId: string,
  message: string,
): Promise<unknown> {
  return prisma.socialAccount.update({
    where: { id: socialAccountId },
    data: {
      status: 'DISCONNECTED',
      lastErrorAt: new Date(),
      lastErrorMessage: message,
    },
  });
}
