import type { Prisma } from '../generated/client';
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
