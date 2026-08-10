import { describe, expect, it, vi } from 'vitest';
import { dispatchClaimedOutboxEvent } from '../outbox-dispatcher';

describe('Outbox dispatcher recovery', () => {
  it('T38 later dispatch of durable webhook OutboxEvent enqueues and marks dispatched', async () => {
    const queueAdd = vi.fn(async () => ({}));
    const outboxUpdate = vi.fn(async () => ({}));

    await dispatchClaimedOutboxEvent(
      {
        outboxEvent: { update: outboxUpdate },
      } as never,
      {
        getQueue: vi.fn(() => ({ add: queueAdd })),
      } as never,
      {
        id: 'outbox_1',
        topic: 'process-webhook',
        payload: {
          queueName: 'process-webhook',
          jobName: 'process-webhook',
          jobId: 'process-webhook-webhook_1',
          payload: { webhookEventId: 'webhook_1' },
          options: { jobId: 'process-webhook-webhook_1', attempts: 5 },
        },
      } as never,
    );

    expect(queueAdd).toHaveBeenCalledWith(
      'process-webhook',
      { webhookEventId: 'webhook_1' },
      expect.objectContaining({ jobId: 'process-webhook-webhook_1' }),
    );
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: 'outbox_1' },
      data: expect.objectContaining({
        dispatchedAt: expect.any(Date),
        claimedAt: null,
        claimedBy: null,
        lastError: null,
      }),
    });
  });
});
