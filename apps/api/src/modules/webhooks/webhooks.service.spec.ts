import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AdapterRegistry } from '@socialhub/platform-adapters';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { ApiEnv } from '@socialhub/config';
import { WebhooksService } from './webhooks.service';

const queueAdd = vi.hoisted(() => vi.fn());
const queueClose = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: queueAdd, close: queueClose })),
}));

describe('WebhooksService', () => {
  const rawBody = Buffer.from(JSON.stringify({ entry: [{ id: 'page_1', time: 1, changes: [] }] }));
  const request = {
    rawBody,
    body: { entry: [{ id: 'page_1', time: 1, changes: [] }] },
    headers: { 'x-hub-signature-256': 'sha256=test' },
  };

  const webhookCreate = vi.fn();
  const webhookFindUnique = vi.fn();
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => await fn(prisma)),
    webhookEvent: {
      create: webhookCreate,
      findUnique: webhookFindUnique,
    },
    outboxEvent: {
      create: vi.fn(async ({ data }) => ({ ...data, id: 'outbox_1' })),
      upsert: vi.fn(async ({ create }) => ({ ...create, id: 'outbox_1' })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
  } as unknown as PrismaService;
  const redis = { getClient: vi.fn(() => ({})) } as unknown as RedisService;
  const adapter = {
    verifyWebhookSignature: vi.fn(() => true),
    parseWebhookEvents: vi.fn(() => [
      {
        externalEventId: 'event_1',
        eventType: 'comments',
        externalAccountId: 'page_1',
        occurredAt: new Date(1000),
        raw: {},
      },
    ]),
  };
  const adapters = { get: vi.fn(() => adapter) } as unknown as AdapterRegistry;
  const env = { FACEBOOK_WEBHOOK_SECRET: 'verify-token' } as ApiEnv;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('từ chối chữ ký sai và không lưu payload', async () => {
    adapter.verifyWebhookSignature.mockReturnValueOnce(false);
    const service = new WebhooksService(prisma, redis, adapters, env);

    await expect(service.receive('FACEBOOK', request as never)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(webhookCreate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('lưu event hợp lệ và enqueue process-webhook', async () => {
    webhookCreate.mockResolvedValueOnce({ id: 'webhook_1' });
    const service = new WebhooksService(prisma, redis, adapters, env);

    await expect(service.receive('FACEBOOK', request as never)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      webhookEventId: 'webhook_1',
    });
    expect(webhookCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ platform: 'FACEBOOK', signatureOk: true }),
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: 'process-webhook:webhook_1' },
        create: expect.objectContaining({
          topic: 'process-webhook',
          aggregateType: 'WebhookEvent',
          aggregateId: 'webhook_1',
          dedupeKey: 'process-webhook:webhook_1',
        }),
      }),
    );
  });

  it('T38 webhook DB transaction keeps durable OutboxEvent when immediate Redis enqueue fails', async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis unavailable'));
    webhookCreate.mockResolvedValueOnce({ id: 'webhook_1' });
    const service = new WebhooksService(prisma, redis, adapters, env);

    await expect(service.receive('FACEBOOK', request as never)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      webhookEventId: 'webhook_1',
    });

    expect(prisma.outboxEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: 'process-webhook:webhook_1' },
        create: expect.objectContaining({
          topic: 'process-webhook',
          aggregateType: 'WebhookEvent',
          aggregateId: 'webhook_1',
          dedupeKey: 'process-webhook:webhook_1',
        }),
      }),
    );
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'outbox_1' },
      data: expect.objectContaining({
        dispatchAttempts: { increment: 1 },
        lastError: 'redis unavailable',
      }),
    });
  });

  it('T39 duplicate webhook repairs missing durable processing intent idempotently', async () => {
    webhookCreate.mockRejectedValueOnce({ code: 'P2002' });
    webhookFindUnique.mockResolvedValueOnce({ id: 'webhook_existing' });
    const service = new WebhooksService(prisma, redis, adapters, env);

    await expect(service.receive('FACEBOOK', request as never)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(queueAdd).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: 'process-webhook:webhook_existing' },
        create: expect.objectContaining({
          topic: 'process-webhook',
          aggregateType: 'WebhookEvent',
          aggregateId: 'webhook_existing',
          dedupeKey: 'process-webhook:webhook_existing',
        }),
      }),
    );

    vi.clearAllMocks();
    webhookCreate.mockRejectedValueOnce({ code: 'P2002' });
    webhookFindUnique.mockResolvedValueOnce({ id: 'webhook_existing' });

    await expect(service.receive('FACEBOOK', request as never)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(prisma.outboxEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: 'process-webhook:webhook_existing' },
      }),
    );
  });
});
