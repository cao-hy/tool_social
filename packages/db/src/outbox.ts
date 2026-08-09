import type { OutboundOperation, Prisma } from '../generated/client';
import type { QueueJobOptions, QueueName, QueuePayload } from '@socialhub/shared';

export interface QueueOutboxPayload<Q extends QueueName = QueueName> {
  queueName: Q;
  jobName: Q;
  jobId: string;
  payload: QueuePayload<Q>;
  options: QueueJobOptions;
}

export function operationRequestKey(input: {
  operationType: string;
  resourceType: string;
  resourceId: string;
  operationGeneration: number;
}): string {
  return [
    input.operationType,
    input.resourceType,
    input.resourceId,
    String(input.operationGeneration),
  ].join(':');
}

export async function findOrCreateOutboundOperation(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    operationType: Prisma.OutboundOperationCreateInput['operationType'];
    resourceType: string;
    resourceId: string;
    operationGeneration: number;
    payloadHash?: string | null;
  },
) {
  const requestKey = operationRequestKey(input);
  return await tx.outboundOperation.upsert({
    where: {
      operationType_resourceType_resourceId_operationGeneration: {
        operationType: input.operationType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        operationGeneration: input.operationGeneration,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      operationType: input.operationType,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      operationGeneration: input.operationGeneration,
      requestKey,
      payloadHash: input.payloadHash ?? null,
      state: 'PREPARED',
    },
    update: {},
  });
}

export type GenerationDecision =
  | { action: 'REUSE_ACTIVE'; operationId: string }
  | { action: 'CREATE_NEXT'; nextGeneration: number }
  | { action: 'REJECT'; reason: string };

export function canCreateNextGeneration(
  latestOperation: Pick<OutboundOperation, 'id' | 'operationGeneration' | 'state'> | null,
): GenerationDecision {
  if (!latestOperation) return { action: 'CREATE_NEXT', nextGeneration: 1 };

  switch (latestOperation.state) {
    case 'PREPARED':
      return { action: 'REUSE_ACTIVE', operationId: latestOperation.id };
    case 'CONFIRMED_ABSENT':
      return {
        action: 'CREATE_NEXT',
        nextGeneration: latestOperation.operationGeneration + 1,
      };
    case 'FAILED':
      return {
        action: 'REJECT',
        reason: 'Latest operation is FAILED and cannot prove the remote mutation was absent.',
      };
    case 'DISPATCHING':
    case 'REMOTE_UNKNOWN':
    case 'REMOTE_CONFIRMED':
    case 'LOCAL_COMMITTED':
    case 'MANUAL_REVIEW':
      return {
        action: 'REJECT',
        reason: `Cannot create a new generation while latest operation is ${latestOperation.state}.`,
      };
    default: {
      const exhaustive: never = latestOperation.state;
      return { action: 'REJECT', reason: `Unhandled operation state ${String(exhaustive)}` };
    }
  }
}

export function mutationJobId<Q extends QueueName>(
  queueName: Q,
  payload: QueuePayload<Q> & { operationId?: string },
): string {
  return payload.operationId ? `${queueName}-outbound-${payload.operationId}` : '';
}

export async function latestOutboundOperation(
  tx: Prisma.TransactionClient,
  input: {
    operationType: Prisma.OutboundOperationCreateInput['operationType'];
    resourceType: string;
    resourceId: string;
  },
) {
  return await tx.outboundOperation.findFirst({
    where: input,
    orderBy: { operationGeneration: 'desc' },
  });
}

export async function createQueueOutboxEvent<Q extends QueueName>(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId?: string | null;
    queueName: Q;
    jobName?: Q;
    jobId: string;
    payload: QueuePayload<Q>;
    options: QueueJobOptions;
    aggregateType: string;
    aggregateId: string;
  },
) {
  const payload: QueueOutboxPayload<Q> = {
    queueName: input.queueName,
    jobName: input.jobName ?? input.queueName,
    jobId: input.jobId,
    payload: input.payload,
    options: input.options,
  };

  return await tx.outboxEvent.create({
    data: {
      workspaceId: input.workspaceId ?? undefined,
      topic: input.queueName,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}
