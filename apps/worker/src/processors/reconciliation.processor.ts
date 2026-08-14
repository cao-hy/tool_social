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
  operationId: z.string().min(1).optional(),
});

export function createReconciliationProcessor(input: {
  prisma: PrismaClientInstance;
  keyring: Keyring;
  platformResolver: WorkspacePlatformResolver;
}) {
  return async (job: { data: unknown; id?: string }) => {
    const payload = reconcilePayloadSchema.parse(job.data);
    logger.info({ payload, jobId: job.id }, 'Bắt đầu xử lý reconciliation job');

    const operation = await resolveReconciliationOperation(input.prisma, payload);
    if (!operation) return { status: 'OPERATION_NOT_FOUND' };
    if (operation.state !== 'REMOTE_UNKNOWN') {
      return { status: 'SKIPPED', currentOperationState: operation.state };
    }

    const post = await input.prisma.platformPost.findUnique({
      where: { id: operation.resourceId },
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

    if (operation.attemptId !== payload.publishAttemptId) {
      logger.info(
        {
          platformPostId: post.id,
          currentAttemptId: operation.attemptId,
          jobAttemptId: payload.publishAttemptId,
        },
        'Bỏ qua reconciliation job của publish attempt cũ',
      );
      return { status: 'STALE_ATTEMPT' };
    }

    if (operation.reconciliationAttempts >= 5) {
      await transitionPublishToManualReview(input.prisma, operation, post.id, {
        reason: 'Đã vượt quá 5 lần đối soát tự động.',
      });
      return { status: 'MANUAL_REVIEW_REQUIRED' };
    }

    return await input.platformResolver.withWorkspace(payload.workspaceId, async ({ adapters }) => {
      const adapter = adapters.get(post.platform);
      if (!adapter || !adapter.reconcilePublish) {
        const attempts = operation.reconciliationAttempts + 1;
        await recordIndeterminateReconciliation(input.prisma, operation, post.id, {
          attempts,
          reason: 'Platform adapter chưa hỗ trợ đối soát tự động.',
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

      const remoteCheckpoint = remoteCheckpointFromOperation(operation.remoteCheckpoint);
      const result = await adapter
        .reconcilePublish(ctx, {
          platformPostId: post.id,
          publishAttemptId: payload.publishAttemptId,
          providerRequestId: remoteCheckpoint?.providerRequestId,
          remoteCheckpoint,
        })
        .catch((error) => ({
          result: 'INDETERMINATE' as const,
          reason:
            error instanceof Error
              ? error.message
              : 'Provider reconciliation failed with an unknown error.',
        }));

      if (result.result === 'FOUND') {
        const committedAt = new Date();
        const updated = await input.prisma.$transaction(async (tx) => {
          const remoteConfirmed = await tx.outboundOperation.updateMany({
            where: {
              id: operation.id,
              state: 'REMOTE_UNKNOWN',
              attemptId: operation.attemptId,
              fence: operation.fence,
            },
            data: {
              state: 'LOCAL_COMMITTED',
              remoteId: result.remotePostId,
              remoteCheckpoint: {
                externalPostId: result.remotePostId,
                externalUrl: result.remoteUrl,
                publishedAt: committedAt.toISOString(),
                reconciledBy: 'automatic',
                operationId: operation.id,
                attemptId: operation.attemptId,
                fence: operation.fence,
                recordedAt: committedAt.toISOString(),
              } as Prisma.InputJsonValue,
              remoteConfirmedAt: committedAt,
              completedAt: committedAt,
              requiresManualReview: false,
              reconciliationAttempts: { increment: 1 },
              lastReconciledAt: committedAt,
              lastErrorCode: null,
              lastErrorMessage: null,
            },
          });
          if (remoteConfirmed.count !== 1) return false;
          await tx.platformPost.update({
            where: { id: post.id },
            data: {
              status: 'PUBLISHED',
              externalPostId: result.remotePostId,
              externalUrl: result.remoteUrl,
              publishedAt: committedAt,
              errorCode: null,
              errorMessage: null,
              reconciliationAttempts: { increment: 1 },
              lastReconciledAt: committedAt,
              requiresManualReview: false,
            },
          });
          return true;
        });
        if (!updated) return { status: 'STALE_OPERATION' };
        await updateParentStatus(input.prisma, post.contentPostId);
        return { status: 'RESOLVED_PUBLISHED', externalPostId: result.remotePostId };
      }

      if (result.result === 'CONFIRMED_ABSENT') {
        const reconciledAt = new Date();
        const updated = await input.prisma.$transaction(async (tx) => {
          const absent = await tx.outboundOperation.updateMany({
            where: {
              id: operation.id,
              state: 'REMOTE_UNKNOWN',
              attemptId: operation.attemptId,
              fence: operation.fence,
            },
            data: {
              state: 'CONFIRMED_ABSENT',
              fence: { increment: 1 },
              requiresManualReview: false,
              reconciliationAttempts: { increment: 1 },
              lastReconciledAt: reconciledAt,
              lastErrorCode: 'CONFIRMED_ABSENT',
              lastErrorMessage: 'Đối soát xác nhận bài chưa được đăng lên nền tảng.',
            },
          });
          if (absent.count !== 1) return false;
          await tx.platformPost.update({
            where: { id: post.id },
            data: {
              status: 'FAILED',
              errorCode: 'CONFIRMED_ABSENT',
              errorMessage: 'Đối soát xác nhận bài chưa được đăng lên nền tảng.',
              reconciliationAttempts: { increment: 1 },
              lastReconciledAt: reconciledAt,
              requiresManualReview: false,
            },
          });
          return true;
        });
        if (!updated) return { status: 'STALE_OPERATION' };
        await updateParentStatus(input.prisma, post.contentPostId);
        return { status: 'RESOLVED_FAILED' };
      }

      const nextAttempts = operation.reconciliationAttempts + 1;
      const updated = await recordIndeterminateReconciliation(input.prisma, operation, post.id, {
        attempts: nextAttempts,
        reason: result.reason,
      });
      if (!updated) return { status: 'STALE_OPERATION' };
      if (nextAttempts < 5) {
        throw new ReconciliationIndeterminateError(
          result.reason ?? 'Không thể xác định kết quả publish phía nền tảng.',
        );
      }
      return { status: 'MANUAL_REVIEW_REQUIRED', reason: result.reason };
    });
  };
}

async function resolveReconciliationOperation(
  prisma: PrismaClientInstance,
  payload: z.infer<typeof reconcilePayloadSchema>,
) {
  if (payload.operationId) {
    return await prisma.outboundOperation.findUnique({ where: { id: payload.operationId } });
  }
  return await prisma.outboundOperation.findFirst({
    where: {
      workspaceId: payload.workspaceId,
      operationType: 'PUBLISH_POST',
      resourceType: 'PlatformPost',
      resourceId: payload.platformPostId,
      attemptId: payload.publishAttemptId,
    },
    orderBy: { operationGeneration: 'desc' },
  });
}

function remoteCheckpointFromOperation(
  checkpoint: Prisma.JsonValue | null,
): RemotePublishCheckpoint | undefined {
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

async function recordIndeterminateReconciliation(
  prisma: PrismaClientInstance,
  operation: {
    id: string;
    state: string;
    attemptId: string | null;
    fence: number;
  },
  platformPostId: string,
  input: { attempts: number; reason: string },
): Promise<boolean> {
  const reconciledAt = new Date();
  const manualReview = input.attempts >= 5;
  return await prisma.$transaction(async (tx) => {
    const indeterminate = await tx.outboundOperation.updateMany({
      where: {
        id: operation.id,
        state: 'REMOTE_UNKNOWN',
        attemptId: operation.attemptId,
        fence: operation.fence,
      },
      data: {
        state: manualReview ? 'MANUAL_REVIEW' : 'REMOTE_UNKNOWN',
        fence: manualReview ? { increment: 1 } : undefined,
        reconciliationAttempts: { increment: 1 },
        lastReconciledAt: reconciledAt,
        requiresManualReview: manualReview,
        lastErrorCode: 'RECONCILIATION_INDETERMINATE',
        lastErrorMessage: input.reason,
      },
    });
    if (indeterminate.count !== 1) return false;
    await tx.platformPost.update({
      where: { id: platformPostId },
      data: {
        reconciliationAttempts: input.attempts,
        lastReconciledAt: reconciledAt,
        requiresManualReview: manualReview,
        reconciliationError: input.reason,
      },
    });
    return true;
  });
}

async function transitionPublishToManualReview(
  prisma: PrismaClientInstance,
  operation: {
    id: string;
    state: string;
    attemptId: string | null;
    fence: number;
  },
  platformPostId: string,
  input: { reason: string },
): Promise<boolean> {
  const reviewedAt = new Date();
  return await prisma.$transaction(async (tx) => {
    const updated = await tx.outboundOperation.updateMany({
      where: {
        id: operation.id,
        state: 'REMOTE_UNKNOWN',
        attemptId: operation.attemptId,
        fence: operation.fence,
      },
      data: {
        state: 'MANUAL_REVIEW',
        fence: { increment: 1 },
        requiresManualReview: true,
        lastReconciledAt: reviewedAt,
        lastErrorCode: 'MANUAL_REVIEW_REQUIRED',
        lastErrorMessage: input.reason,
      },
    });
    if (updated.count !== 1) return false;
    await tx.platformPost.update({
      where: { id: platformPostId },
      data: {
        requiresManualReview: true,
        reconciliationError: input.reason,
        lastReconciledAt: reviewedAt,
      },
    });
    return true;
  });
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
