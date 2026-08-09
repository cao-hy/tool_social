import type { Prisma, PrismaClientInstance } from '@socialhub/db';
import type { RemotePublishCheckpoint } from '@socialhub/platform-adapters';
import type { Keyring } from '@socialhub/security';
import type { WorkspacePlatformResolver } from '@socialhub/social-runtime';
import { deriveContentPostStatus, type PlatformPostStatus } from '@socialhub/shared';
import { z } from 'zod';
import { logger } from '../logger';
import { getFreshAccessToken } from './token-refresh';

class ReconciliationIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationIndeterminateError';
  }
}

const reconcilePayloadSchema = z.object({
  platformPostId: z.string().min(1),
  workspaceId: z.string().min(1),
  publishAttemptId: z.string().min(1),
});

export function createReconciliationProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  platformResolver: WorkspacePlatformResolver;
}) {
  return async (job: { data: unknown; id?: string }) => {
    const payload = reconcilePayloadSchema.parse(job.data);
    logger.info({ payload, jobId: job.id }, 'Bắt đầu xử lý reconciliation job');

    const post = await input.prisma.platformPost.findUnique({
      where: { id: payload.platformPostId },
      include: {
        socialAccount: { include: { token: true } },
        contentPost: true,
      },
    });

    if (!post) {
      logger.warn({ payload }, 'Không tìm thấy PlatformPost cho reconciliation');
      return { status: 'POST_NOT_FOUND' };
    }

    if (post.status !== 'REMOTE_RESULT_UNKNOWN') {
      logger.info(
        { payload, currentStatus: post.status },
        'PlatformPost không còn ở trạng thái UNKNOWN',
      );
      return { status: 'SKIPPED', currentStatus: post.status };
    }

    if (post.publishAttemptId !== payload.publishAttemptId) {
      logger.info(
        {
          platformPostId: post.id,
          currentAttemptId: post.publishAttemptId,
          jobAttemptId: payload.publishAttemptId,
        },
        'Bỏ qua reconciliation job của publish attempt cũ',
      );
      return { status: 'STALE_ATTEMPT' };
    }

    if (post.reconciliationAttempts >= 5) {
      await input.prisma.platformPost.update({
        where: { id: post.id },
        data: {
          requiresManualReview: true,
          reconciliationError: 'Đã vượt quá 5 lần đối soát tự động.',
          lastReconciledAt: new Date(),
        },
      });
      return { status: 'MANUAL_REVIEW_REQUIRED' };
    }

    return await input.platformResolver.withWorkspace(payload.workspaceId, async ({ adapters }) => {
      const adapter = adapters.get(post.platform);
      if (!adapter || !adapter.reconcilePublish) {
        const attempts = post.reconciliationAttempts + 1;
        await input.prisma.platformPost.update({
          where: { id: post.id },
          data: {
            reconciliationAttempts: attempts,
            lastReconciledAt: new Date(),
            requiresManualReview: attempts >= 5,
            reconciliationError: 'Platform adapter chưa hỗ trợ đối soát tự động.',
          },
        });
        if (attempts < 5) {
          throw new ReconciliationIndeterminateError(
            'Platform adapter chưa hỗ trợ đối soát tự động.',
          );
        }
        return { status: 'MANUAL_REVIEW_REQUIRED' };
      }

      const accessToken = await getFreshAccessToken({
        prisma: input.prisma,
        keyring: input.keyring,
        adapter,
        account: {
          id: post.socialAccount.id,
          workspaceId: post.socialAccount.workspaceId,
          platform: post.socialAccount.platform,
          token: post.socialAccount.token,
        },
      });

      const ctx = {
        accessToken,
        externalAccountId: post.socialAccount.externalAccountId,
        externalPageId: post.socialAccount.externalPageId ?? undefined,
        correlationId: `reconcile:${post.id}:${payload.publishAttemptId}`,
      };

      const remoteCheckpoint = remoteCheckpointFromState(post.platformState);
      const result = await adapter.reconcilePublish(ctx, {
        platformPostId: post.id,
        publishAttemptId: payload.publishAttemptId,
        providerRequestId: remoteCheckpoint?.providerRequestId,
        remoteCheckpoint,
      });

      if (result.result === 'FOUND') {
        await input.prisma.platformPost.update({
          where: { id: post.id },
          data: {
            status: 'PUBLISHED',
            externalPostId: result.remotePostId,
            externalUrl: result.remoteUrl,
            publishedAt: new Date(),
            errorCode: null,
            errorMessage: null,
            reconciliationAttempts: { increment: 1 },
            lastReconciledAt: new Date(),
            requiresManualReview: false,
          },
        });
        await updateParentStatus(input.prisma, post.contentPostId);
        return { status: 'RESOLVED_PUBLISHED', externalPostId: result.remotePostId };
      }

      if (result.result === 'CONFIRMED_ABSENT') {
        await input.prisma.platformPost.update({
          where: { id: post.id },
          data: {
            status: 'FAILED',
            errorCode: 'CONFIRMED_ABSENT',
            errorMessage: 'Đối soát xác nhận bài chưa được đăng lên nền tảng.',
            reconciliationAttempts: { increment: 1 },
            lastReconciledAt: new Date(),
            requiresManualReview: false,
          },
        });
        await updateParentStatus(input.prisma, post.contentPostId);
        return { status: 'RESOLVED_FAILED' };
      }

      const nextAttempts = post.reconciliationAttempts + 1;
      await input.prisma.platformPost.update({
        where: { id: post.id },
        data: {
          reconciliationAttempts: nextAttempts,
          lastReconciledAt: new Date(),
          requiresManualReview: nextAttempts >= 5,
          reconciliationError: result.reason,
        },
      });
      if (nextAttempts < 5) {
        throw new ReconciliationIndeterminateError(
          result.reason ?? 'Không thể xác định kết quả publish phía nền tảng.',
        );
      }
      return { status: 'MANUAL_REVIEW_REQUIRED', reason: result.reason };
    });
  };
}

function remoteCheckpointFromState(
  platformState: Prisma.JsonValue | null,
): RemotePublishCheckpoint | undefined {
  if (!platformState || typeof platformState !== 'object' || Array.isArray(platformState)) {
    return undefined;
  }
  const state = platformState as Record<string, unknown>;
  const checkpoint = state.remoteCheckpoint;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return undefined;
  }
  const checkpointRecord = checkpoint as Record<string, unknown>;
  if (typeof checkpointRecord.phase !== 'string') return undefined;
  return {
    phase: checkpointRecord.phase,
    providerRequestId:
      typeof checkpointRecord.providerRequestId === 'string'
        ? checkpointRecord.providerRequestId
        : undefined,
    remotePublishId:
      typeof checkpointRecord.remotePublishId === 'string'
        ? checkpointRecord.remotePublishId
        : undefined,
    remoteMediaId:
      typeof checkpointRecord.remoteMediaId === 'string'
        ? checkpointRecord.remoteMediaId
        : undefined,
  };
}

async function updateParentStatus(prisma: PrismaClientInstance, contentPostId: string) {
  const allPlatforms = await prisma.platformPost.findMany({
    where: { contentPostId },
    select: { status: true },
  });
  const statuses = allPlatforms.map((p) => p.status as PlatformPostStatus);
  const derived = deriveContentPostStatus(statuses);

  await prisma.contentPost.update({
    where: { id: contentPostId },
    data: { status: derived },
  });
}
