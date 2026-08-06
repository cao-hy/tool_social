import { AdapterRegistry } from '@socialhub/platform-adapters';
import type { PrismaClientInstance } from '@socialhub/db';
import { buildJobId, type QueuePayload } from '@socialhub/shared';
import type { Queue } from 'bullmq';
import { z } from 'zod';

const processWebhookPayloadSchema = z.object({
  webhookEventId: z.string().min(1),
});

export function createProcessWebhookProcessor(input: {
  prisma: PrismaClientInstance;
  adapters: AdapterRegistry;
  syncCommentsQueue: Queue;
}) {
  return async (job: {
    data: unknown;
    id?: string;
    name?: string;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    const payload = processWebhookPayloadSchema.parse(job.data);
    const jobName = job.name ?? 'process-webhook';
    const jobId = job.id ?? `process-webhook:${payload.webhookEventId}`;
    const startedAt = new Date();

    await markJob(input.prisma, jobName, jobId, payload, job, 'RUNNING');

    try {
      const result = await processWebhook(input, payload.webhookEventId);
      await finishJob(input.prisma, jobName, jobId, startedAt, 'COMPLETED');
      return result;
    } catch (error) {
      const attempt = (job.attemptsMade ?? 0) + 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      await input.prisma.webhookEvent
        .update({
          where: { id: payload.webhookEventId },
          data: {
            status: attempt >= maxAttempts ? 'FAILED' : 'PROCESSING',
            errorMessage:
              error instanceof Error ? error.message : 'Lỗi không xác định khi xử lý webhook.',
          },
        })
        .catch(() => undefined);
      await finishJob(
        input.prisma,
        jobName,
        jobId,
        startedAt,
        attempt >= maxAttempts ? 'DEAD' : 'FAILED',
        {
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          errorMessage:
            error instanceof Error ? error.message : 'Lỗi không xác định khi xử lý webhook.',
          isDead: attempt >= maxAttempts,
        },
      );
      throw error;
    }
  };
}

async function processWebhook(
  input: { prisma: PrismaClientInstance; adapters: AdapterRegistry; syncCommentsQueue: Queue },
  webhookEventId: string,
) {
  const webhookEvent = await input.prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });
  if (!webhookEvent) return { processed: false, reason: 'event_not_found' };
  if (webhookEvent.status === 'PROCESSED' || webhookEvent.status === 'IGNORED') {
    return { processed: false, reason: 'already_processed' };
  }

  await input.prisma.webhookEvent.update({
    where: { id: webhookEvent.id },
    data: { status: 'PROCESSING', attemptCount: { increment: 1 }, errorMessage: null },
  });

  const adapter = input.adapters.get(webhookEvent.platform);
  if (!adapter.parseWebhookEvents) {
    await markWebhookDone(input.prisma, webhookEvent.id, 'IGNORED');
    return { processed: true, queued: 0, reason: 'parser_unsupported' };
  }

  const events = adapter.parseWebhookEvents(webhookEvent.payload);
  let queued = 0;

  for (const event of events) {
    if (!event.externalAccountId) continue;
    const accounts = await input.prisma.socialAccount.findMany({
      where: {
        platform: webhookEvent.platform,
        deletedAt: null,
        OR: [
          { externalAccountId: event.externalAccountId },
          { externalPageId: event.externalAccountId },
        ],
      },
    });
    if (accounts.length === 0) continue;

    for (const account of accounts) {
      const platformPost = event.externalPostId
        ? await input.prisma.platformPost.findFirst({
            where: {
              workspaceId: account.workspaceId,
              socialAccountId: account.id,
              externalPostId: event.externalPostId,
            },
          })
        : null;
      const syncPayload: QueuePayload<'sync-comments'> = {
        workspaceId: account.workspaceId,
        socialAccountId: account.id,
        platformPostId: platformPost?.id,
        since: new Date(Math.max(0, event.occurredAt.getTime() - 5 * 60 * 1000)).toISOString(),
      };

      await input.syncCommentsQueue.add('sync-comments', syncPayload, {
        jobId: buildJobId('sync-comments', syncPayload),
      });
      queued += 1;
    }
  }

  await markWebhookDone(input.prisma, webhookEvent.id, events.length > 0 ? 'PROCESSED' : 'IGNORED');
  return { processed: true, events: events.length, queued };
}

async function markWebhookDone(
  prisma: PrismaClientInstance,
  webhookEventId: string,
  status: 'PROCESSED' | 'IGNORED',
) {
  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { status, processedAt: new Date() },
  });
}

async function markJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  payload: z.infer<typeof processWebhookPayloadSchema>,
  job: { attemptsMade?: number; opts?: { attempts?: number } },
  status: 'RUNNING',
) {
  await prisma.backgroundJob.upsert({
    where: { queueName_jobId: { queueName, jobId } },
    create: {
      queueName,
      jobId,
      status,
      payload,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      correlationId: `webhook:${payload.webhookEventId}`,
    },
    update: {
      status,
      payload,
      attempts: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts ?? 1,
      startedAt: new Date(),
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      isDead: false,
      correlationId: `webhook:${payload.webhookEventId}`,
    },
  });
}

async function finishJob(
  prisma: PrismaClientInstance,
  queueName: string,
  jobId: string,
  startedAt: Date,
  status: 'COMPLETED' | 'FAILED' | 'DEAD',
  error?: { errorCode?: string; errorMessage?: string; isDead?: boolean },
) {
  const finishedAt = new Date();
  await prisma.backgroundJob.update({
    where: { queueName_jobId: { queueName, jobId } },
    data: {
      status,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCode: error?.errorCode,
      errorMessage: error?.errorMessage,
      isDead: error?.isDead ?? status === 'DEAD',
    },
  });
}
