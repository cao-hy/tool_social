import type { SocialPlatformAdapter } from '@socialhub/platform-adapters';
import type { Keyring } from '@socialhub/security';
import { decryptToken } from '@socialhub/security';
import { InMemoryTokenRefreshLock, TokenRefreshService } from '@socialhub/social-runtime';
import type { Platform } from '@socialhub/shared';
import { AppError } from '../common/errors/app-error';
import type { AdapterRegistryFactory } from './adapter-registry.factory';
import type { PrismaService } from './prisma/prisma.service';

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const tokenRefreshLock = new InMemoryTokenRefreshLock();

export async function getFreshAccessTokenViaCentralService(
  input: {
    prisma: PrismaService;
    keyring: Keyring;
    adapterFactory: AdapterRegistryFactory;
    account: {
      id: string;
      workspaceId: string;
      platform: Platform;
      token: {
        accessToken: string;
        refreshToken: string | null;
        accessTokenExpiresAt: Date | null;
      } | null;
    };
  },
  _adapter?: SocialPlatformAdapter,
): Promise<string> {
  if (!input.account.token) {
    throw AppError.conflict('Social account chưa có token để kiểm tra.');
  }

  if (
    !input.account.token.accessTokenExpiresAt ||
    input.account.token.accessTokenExpiresAt.getTime() > Date.now() + REFRESH_THRESHOLD_MS
  ) {
    return decryptToken(input.account.token.accessToken, input.keyring);
  }

  if (!input.account.token.refreshToken) {
    throw AppError.conflict('Token đã hết hạn. Hãy ngắt kết nối rồi kết nối lại tài khoản.');
  }

  const service = new TokenRefreshService(
    input.prisma,
    input.keyring,
    tokenRefreshLock,
    input.adapterFactory,
  );
  return await service.getValidAccessToken(input.account.id);
}
