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
  { action: 'DISPATCH'; ownership: OutboundAttemptOwnership } | { action: 'NOOP'; reason: string };

export async function beginOutboundAttempt(
  prisma: PrismaClientInstance,
  operationId: string | undefined,
): Promise<OperationStartResult> {
  if (!operationId) {
    return { action: 'DISPATCH', ownership: { operationId: '', attemptId: '', fence: 0 } };
  }

  const operation = await prisma.outboundOperation.findUnique({ where: { id: operationId } });
  if (!operation) return { action: 'NOOP', reason: 'operation_not_found' };

  switch (operation.state) {
    case 'LOCAL_COMMITTED':
    case 'REMOTE_CONFIRMED':
      return { action: 'NOOP', reason: operation.state };
    case 'REMOTE_UNKNOWN':
    case 'MANUAL_REVIEW':
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
      return { action: 'DISPATCH', ownership: { operationId: operation.id, attemptId, fence } };
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
  return updated.count === 1;
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
  const updated = await prisma.outboundOperation.updateMany({
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
