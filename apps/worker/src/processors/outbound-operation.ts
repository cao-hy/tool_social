import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClientInstance } from '@socialhub/db';

export class StaleOperationError extends Error {
  constructor(message = 'Outbound operation ownership is stale') {
    super(message);
    this.name = 'StaleOperationError';
  }
}

export type OutboundAttemptOwnership = {
  operationId: string;
  attemptId: string;
  fence: number;
};

export type OperationStartResult =
  | { action: 'DISPATCH_REMOTE'; ownership: OutboundAttemptOwnership }
  | { action: 'LOCAL_COMMIT'; ownership: OutboundAttemptOwnership }
  | { action: 'RECONCILE'; reason: string }
  | { action: 'NOOP'; reason: string };

export async function beginOutboundAttempt(
  prisma: PrismaClientInstance,
  operationId: string | undefined,
): Promise<OperationStartResult> {
  if (!operationId) {
    return { action: 'NOOP', reason: 'operation_id_required' };
  }

  const operation = await prisma.outboundOperation.findUnique({ where: { id: operationId } });
  if (!operation) return { action: 'NOOP', reason: 'operation_not_found' };

  switch (operation.state) {
    case 'LOCAL_COMMITTED':
      return { action: 'NOOP', reason: operation.state };
    case 'REMOTE_CONFIRMED':
      if (!operation.attemptId)
        return { action: 'NOOP', reason: 'REMOTE_CONFIRMED_WITHOUT_ATTEMPT' };
      return {
        action: 'LOCAL_COMMIT',
        ownership: {
          operationId: operation.id,
          attemptId: operation.attemptId,
          fence: operation.fence,
        },
      };
    case 'REMOTE_UNKNOWN':
    case 'MANUAL_REVIEW':
      return { action: 'RECONCILE', reason: operation.state };
    case 'CONFIRMED_ABSENT':
    case 'FAILED':
      return { action: 'NOOP', reason: operation.state };
    case 'DISPATCHING': {
      const updated = await prisma.outboundOperation.updateMany({
        where: {
          id: operation.id,
          state: 'DISPATCHING',
          attemptId: operation.attemptId,
          fence: operation.fence,
        },
        data: {
          state: 'REMOTE_UNKNOWN',
          fence: { increment: 1 },
          requiresManualReview: true,
          lastErrorCode: 'ABANDONED_DISPATCHING',
          lastErrorMessage:
            'Worker redelivered an operation that was already dispatching; remote outcome is unknown.',
        },
      });
      if (updated.count !== 1) throw new StaleOperationError();
      return { action: 'NOOP', reason: 'REMOTE_UNKNOWN' };
    }
    case 'PREPARED': {
      const attemptId = randomUUID();
      const fence = operation.fence + 1;
      const updated = await prisma.outboundOperation.updateMany({
        where: { id: operation.id, state: 'PREPARED', fence: operation.fence, attemptId: null },
        data: {
          state: 'DISPATCHING',
          attemptId,
          fence,
          dispatchAttempts: { increment: 1 },
          remoteStartedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (updated.count !== 1) throw new StaleOperationError();
      return {
        action: 'DISPATCH_REMOTE',
        ownership: { operationId: operation.id, attemptId, fence },
      };
    }
    default: {
      const exhaustive: never = operation.state;
      return { action: 'NOOP', reason: String(exhaustive) };
    }
  }
}

export async function rollbackBeforeConnect(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  input: { code: string; message: string },
): Promise<boolean> {
  if (!ownership.operationId) return true;
  const updated = await prisma.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'DISPATCHING',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: {
      state: 'PREPARED',
      attemptId: null,
      remoteStartedAt: null,
      lastErrorCode: input.code,
      lastErrorMessage: input.message,
    },
  });
  if (updated.count === 1) return true;

  await prisma.outboundOperation.findUnique({
    where: { id: ownership.operationId },
    select: { id: true, state: true, attemptId: true, fence: true },
  });
  return false;
}

export async function markRemoteUnknown(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  input: { code: string; message: string; providerRequestId?: string },
): Promise<void> {
  if (!ownership.operationId) return;
  const updated = await prisma.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'DISPATCHING',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: {
      state: 'REMOTE_UNKNOWN',
      requiresManualReview: true,
      providerRequestId: input.providerRequestId,
      lastErrorCode: input.code,
      lastErrorMessage: input.message,
    },
  });
  if (updated.count !== 1) throw new StaleOperationError();
}

export async function markRemoteConfirmed(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  input: { remoteId: string; providerRequestId?: string; checkpoint?: unknown },
): Promise<void> {
  if (!ownership.operationId) return;
  const updated = await prisma.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'DISPATCHING',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: {
      state: 'REMOTE_CONFIRMED',
      remoteId: input.remoteId,
      providerRequestId: input.providerRequestId,
      remoteCheckpoint:
        input.checkpoint === undefined
          ? undefined
          : input.checkpoint === null
            ? Prisma.JsonNull
            : (input.checkpoint as Prisma.InputJsonValue),
      remoteConfirmedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  if (updated.count !== 1) throw new StaleOperationError();
}

export async function markLocalCommitted(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
): Promise<void> {
  if (!ownership.operationId) return;
  await markLocalCommittedInTransaction(prisma, ownership);
}

export async function markLocalCommittedInTransaction(
  tx: Pick<PrismaClientInstance, 'outboundOperation'>,
  ownership: OutboundAttemptOwnership,
): Promise<void> {
  const updated = await tx.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'REMOTE_CONFIRMED',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: { state: 'LOCAL_COMMITTED', completedAt: new Date() },
  });
  if (updated.count !== 1) throw new StaleOperationError();
}
