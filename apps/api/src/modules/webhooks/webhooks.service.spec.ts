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
  const prisma = {
    webhookEvent: {
      create: webhookCreate,
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
  });

  it('replay theo unique constraint trả 200-equivalent và không enqueue lại', async () => {
    webhookCreate.mockRejectedValueOnce({ code: 'P2002' });
    const service = new WebhooksService(prisma, redis, adapters, env);

    await expect(service.receive('FACEBOOK', request as never)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
