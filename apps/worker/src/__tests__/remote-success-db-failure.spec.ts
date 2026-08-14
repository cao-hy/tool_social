import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginOutboundAttempt } from '../processors/outbound-operation';

describe('Remote Success + Confirmation DB Failure (P0-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves exactly 1 mutation invocation by conservatively fencing into REMOTE_UNKNOWN upon redelivery', async () => {
    const prisma = {
      outboundOperation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'op_1',
          state: 'DISPATCHING',
          attemptId: 'attempt_1',
          fence: 1,
          remoteStartedAt: new Date(Date.now() - 16 * 60 * 1000),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const startOperation = await beginOutboundAttempt(prisma as any, 'op_1');

    // Expected: Latest DISPATCHING must not permit next generation.
    // Recovery must conservatively fence/take over into REMOTE_UNKNOWN.
    expect(startOperation).toEqual({ action: 'RECONCILE', reason: 'REMOTE_UNKNOWN' });

    expect(prisma.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'op_1',
          state: 'DISPATCHING',
          attemptId: 'attempt_1',
          fence: 1,
        },
        data: expect.objectContaining({
          state: 'REMOTE_UNKNOWN',
          requiresManualReview: true,
          lastErrorCode: 'ABANDONED_DISPATCHING',
        }),
      }),
    );
  });
});
