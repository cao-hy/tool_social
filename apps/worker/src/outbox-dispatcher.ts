import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClientInstance, QueueOutboxPayload } from '@socialhub/db';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { logger } from './logger';
import type { QueueRegistry } from './queue/queue-registry';

const outboxQueuePayloadSchema = z.object({
  queueName: z.string().min(1),
  jobName: z.string().min(1),
  jobId: z.string().min(1),
  payload: z.unknown(),
  options: z.object({ jobId: z.string().min(1) }).passthrough(),
});

type ClaimedOutboxEvent = {
  id: string;
  topic: string;
  payload: Prisma.JsonValue;
};

export function startOutboxDispatcher(input: {
  prisma: PrismaClientInstance;
  registry: QueueRegistry;
  batchSize?: number;
  pollIntervalMs?: number;
  claimLeaseMs?: number;
}) {
  const dispatcherId = `worker:${process.pid}:${randomUUID()}`;
  const batchSize = input.batchSize ?? 20;
  const pollIntervalMs = input.pollIntervalMs ?? 3000;
  const claimLeaseMs = input.claimLeaseMs ?? 60000;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const events = await claimPendingEvents(input.prisma, {
        dispatcherId,
        batchSize,
        claimLeaseMs,
      });
      for (const event of events) {
        await dispatchClaimedOutboxEvent(input.prisma, input.registry, event);
      }
    } catch (err) {
      logger.error({ err }, 'Outbox dispatcher tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), pollIntervalMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function claimPendingEvents(
  prisma: PrismaClientInstance,
  input: { dispatcherId: string; batchSize: number; claimLeaseMs: number },
): Promise<ClaimedOutboxEvent[]> {
  const reclaimBefore = new Date(Date.now() - input.claimLeaseMs);
  return await prisma.$transaction(async (tx) => {
    return await tx.$queryRaw<ClaimedOutboxEvent[]>`
      WITH picked AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE "dispatchedAt" IS NULL
          AND ("claimedAt" IS NULL OR "claimedAt" < ${reclaimBefore})
        ORDER BY "createdAt" ASC
        LIMIT ${input.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" e
      SET "claimedAt" = NOW(),
          "claimedBy" = ${input.dispatcherId}
      FROM picked
      WHERE e."id" = picked."id"
      RETURNING e."id", e."topic", e."payload"
    `;
  });
}

export async function dispatchClaimedOutboxEvent(
  prisma: PrismaClientInstance,
  registry: QueueRegistry,
  event: ClaimedOutboxEvent,
): Promise<void> {
  try {
    const parsed = outboxQueuePayloadSchema.parse(event.payload) as unknown as QueueOutboxPayload;
    const queue = registry.getQueue(parsed.queueName as Parameters<QueueRegistry['getQueue']>[0]);
    await (queue as Queue).add(parsed.jobName, parsed.payload, parsed.options);
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        dispatchedAt: new Date(),
        claimedAt: null,
        claimedBy: null,
        lastError: null,
      },
    });
  } catch (error) {
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        dispatchAttempts: { increment: 1 },
        claimedAt: null,
        claimedBy: null,
        lastError: safeErrorMessage(error),
      },
    });
    logger.warn(
      { err: error, outboxEventId: event.id, topic: event.topic },
      'Outbox enqueue failed',
    );
  }
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown outbox dispatch error';
  return [error.name, error.message].filter(Boolean).join(': ').slice(0, 1000);
}
