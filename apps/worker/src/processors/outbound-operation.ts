import { randomUUID } from 'node:crypto';
import { Prisma, type OutboundOperationType, type PrismaClientInstance } from '@socialhub/db';

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

type ExpectedOperationBinding = {
  workspaceId: string;
  operationType: OutboundOperationType;
  resourceType: string;
  resourceId: string;
};

const DEFAULT_ABANDONED_DISPATCHING_MS = 15 * 60 * 1000;

export async function beginOutboundAttempt(
  prisma: PrismaClientInstance,
  operationId: string | undefined,
  options?: {
    expected?: ExpectedOperationBinding;
    abandonedDispatchingMs?: number;
  },
): Promise<OperationStartResult> {
  if (!operationId) {
    return { action: 'NOOP', reason: 'operation_id_required' };
  }

  const operation = await prisma.outboundOperation.findUnique({ where: { id: operationId } });
  if (!operation) return { action: 'NOOP', reason: 'operation_not_found' };
  if (options?.expected && !operationMatches(operation, options.expected)) {
    return { action: 'NOOP', reason: 'operation_resource_mismatch' };
  }

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
      const abandonedDispatchingMs =
        options?.abandonedDispatchingMs ?? DEFAULT_ABANDONED_DISPATCHING_MS;
      const startedAt = operation.remoteStartedAt?.getTime();
      const isStale = startedAt !== undefined && Date.now() - startedAt >= abandonedDispatchingMs;
      if (!isStale) return { action: 'NOOP', reason: 'DISPATCHING' };
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
      return { action: 'RECONCILE', reason: 'REMOTE_UNKNOWN' };
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

function operationMatches(
  operation: {
    workspaceId: string;
    operationType: OutboundOperationType;
    resourceType: string;
    resourceId: string;
  },
  expected: ExpectedOperationBinding,
): boolean {
  return (
    operation.workspaceId === expected.workspaceId &&
    operation.operationType === expected.operationType &&
    operation.resourceType === expected.resourceType &&
    operation.resourceId === expected.resourceId
  );
}

export async function markPreTargetFailed(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  input: { code: string; message: string },
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
      state: 'FAILED',
      lastErrorCode: input.code,
      lastErrorMessage: input.message,
    },
  });
  if (updated.count !== 1) throw new StaleOperationError();
}

export async function recordRouteMetadata(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  input: {
    routeConfigVersion?: number | null;
    routeProxyFingerprint?: string | null;
    routeCountryCode?: string | null;
  },
): Promise<void> {
  if (!ownership.operationId) return;
  if (
    input.routeConfigVersion == null &&
    input.routeProxyFingerprint == null &&
    input.routeCountryCode == null
  ) {
    return;
  }
  const updated = await prisma.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'DISPATCHING',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: {
      routeConfigVersion: input.routeConfigVersion ?? undefined,
      routeProxyFingerprint: input.routeProxyFingerprint ?? undefined,
      routeCountryCode: input.routeCountryCode ?? undefined,
    },
  });
  if (updated.count !== 1) throw new StaleOperationError();
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
  input: {
    code: string;
    message: string;
    providerRequestId?: string;
    requiresManualReview?: boolean;
    checkpoint?: unknown;
  },
): Promise<void> {
  if (!ownership.operationId) return;
  const existing = input.checkpoint
    ? await prisma.outboundOperation.findUnique({
        where: { id: ownership.operationId },
        select: { remoteCheckpoint: true },
      })
    : null;
  const updated = await prisma.outboundOperation.updateMany({
    where: {
      id: ownership.operationId,
      state: 'DISPATCHING',
      attemptId: ownership.attemptId,
      fence: ownership.fence,
    },
    data: {
      state: 'REMOTE_UNKNOWN',
      requiresManualReview: input.requiresManualReview ?? true,
      providerRequestId: input.providerRequestId,
      remoteCheckpoint:
        input.checkpoint === undefined
          ? undefined
          : ({
              ...jsonObject(existing?.remoteCheckpoint),
              ...(input.checkpoint as Record<string, unknown>),
            } as Prisma.InputJsonValue),
      lastErrorCode: input.code,
      lastErrorMessage: input.message,
    },
  });
  if (updated.count !== 1) throw new StaleOperationError();
}

export async function transitionRemoteUnknownToManualReview(
  prisma: Pick<PrismaClientInstance, 'outboundOperation'>,
  operationId: string,
  input: { code: string; message: string },
): Promise<boolean> {
  if (!operationId) return false;
  const updated = await prisma.outboundOperation.updateMany({
    where: { id: operationId, state: 'REMOTE_UNKNOWN' },
    data: {
      state: 'MANUAL_REVIEW',
      requiresManualReview: true,
      fence: { increment: 1 },
      lastErrorCode: input.code,
      lastErrorMessage: input.message,
    },
  });
  return updated.count === 1;
}

export async function markRemoteConfirmed(
  prisma: PrismaClientInstance,
  ownership: OutboundAttemptOwnership,
  input: { remoteId: string; providerRequestId?: string; checkpoint?: unknown },
): Promise<void> {
  if (!ownership.operationId) return;
  const existing = input.checkpoint
    ? await prisma.outboundOperation.findUnique({
        where: { id: ownership.operationId },
        select: { remoteCheckpoint: true },
      })
    : null;
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
            : ({
                ...jsonObject(existing?.remoteCheckpoint),
                ...(input.checkpoint as Record<string, unknown>),
              } as Prisma.InputJsonValue),
      remoteConfirmedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  if (updated.count !== 1) throw new StaleOperationError();
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
