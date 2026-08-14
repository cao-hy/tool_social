import type { WorkspaceAdapterContext } from '@socialhub/social-runtime';
import { createPrismaClient, type PrismaClientInstance } from '@socialhub/db';
import { type Keyring } from '@socialhub/security';
import {
  InMemoryTokenRefreshLock,
  TokenRefreshService,
  type TokenRefreshLock,
} from '@socialhub/social-runtime';
import { z } from 'zod';

import { logger } from '../logger';

import type { JobLockService } from '../queue/job-lock';

const refreshSocialTokenPayloadSchema = z.object({
  socialAccountId: z.string().min(1),
  workspaceId: z.string().min(1),
});

const localTokenRefreshLock = new InMemoryTokenRefreshLock();

export function createRefreshSocialTokenProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  adapterFactory: { forWorkspace(workspaceId: string): Promise<WorkspaceAdapterContext> };
  tokenRefreshLock?: TokenRefreshLock;
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

    if (!token.refreshToken) {
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
      const service = new TokenRefreshService(
        input.prisma,
        input.keyring,
        input.tokenRefreshLock ?? localTokenRefreshLock,
        {
          withWorkspace: async (workspaceId, fn) => {
            const adapterCtx = await input.adapterFactory.forWorkspace(workspaceId);
            try {
              return await fn(adapterCtx);
            } finally {
              await adapterCtx.release();
            }
          },
        },
      );
      await service.getValidAccessToken(token.socialAccountId);
      await input.prisma.auditLog.create({
        data: {
          workspaceId: payload.workspaceId,
          action: 'SOCIAL_TOKEN_REFRESHED',
          resourceType: 'SocialAccount',
          resourceId: token.socialAccountId,
          metadata: { platform: token.socialAccount.platform, jobId: job.id },
        },
      });
      return { refreshed: true };
    } catch (error) {
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
