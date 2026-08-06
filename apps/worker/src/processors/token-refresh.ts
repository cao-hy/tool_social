import {
  isPlatformError,
  type SocialPlatformAdapter,
  type TokenSet,
} from '@socialhub/platform-adapters';
import type { PrismaClientInstance } from '@socialhub/db';
import { decryptToken, encryptToken, type Keyring } from '@socialhub/security';
import type { Platform } from '@socialhub/shared';
import type { JobLockService } from '../queue/job-lock';

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;

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

  if (!account.token.refreshToken || !adapter.refreshToken) {
    await markDisconnected(
      prisma,
      account.id,
      'Token đã hết hạn và nền tảng này không có refresh token. Hãy kết nối lại tài khoản.',
    );
    throw new Error('Token đã hết hạn. Hãy kết nối lại tài khoản.');
  }

  const refreshToken = decryptToken(account.token.refreshToken, keyring);

  const doRefresh = async () => {
    // Đọc lại từ DB xem token đã được refresh chưa (lớp bảo vệ thứ 2)
    const currentToken = await prisma.socialToken.findUnique({ where: { id: account.token.id } });
    if (
      currentToken?.accessTokenExpiresAt &&
      currentToken.accessTokenExpiresAt.getTime() > Date.now() + REFRESH_THRESHOLD_MS
    ) {
      return decryptToken(currentToken.accessToken, keyring);
    }

    try {
      return await adapter.refreshToken(refreshToken);
    } catch (error) {
      if (isPlatformError(error) && error.kind === 'AUTH_INVALID') {
        await markDisconnected(prisma, account.id, error.message);
      }
      throw error;
    }
  };

  const lockKey = `token-refresh:${account.id}`;
  let tokenSet: TokenSet | string;
  if (input.locks) {
    const result = await input.locks.withLock(lockKey, 15000, doRefresh);
    if (!result) throw new Error('Tiến trình khác đang refresh token, vui lòng thử lại sau.');
    tokenSet = result;
  } else {
    tokenSet = await doRefresh();
  }

  if (typeof tokenSet === 'string') return tokenSet;

  const encryptedAccessToken = encryptToken(tokenSet.accessToken, keyring);
  const encryptedRefreshToken = tokenSet.refreshToken
    ? encryptToken(tokenSet.refreshToken, keyring)
    : null;

  await prisma.$transaction([
    prisma.socialToken.update({
      where: { id: account.token.id },
      data: {
        accessToken: encryptedAccessToken.ciphertext,
        refreshToken: encryptedRefreshToken?.ciphertext ?? account.token.refreshToken,
        encryptionKeyVersion: encryptedAccessToken.keyVersion,
        accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
        refreshTokenExpiresAt:
          tokenSet.refreshTokenExpiresAt ?? account.token.refreshTokenExpiresAt,
        lastRefreshedAt: new Date(),
        refreshFailedCount: 0,
      },
    }),
    prisma.socialAccount.update({
      where: { id: account.id },
      data: { status: 'CONNECTED', lastErrorAt: null, lastErrorMessage: null },
    }),
  ]);

  return tokenSet.accessToken;
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
