import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientInstance } from '@socialhub/db';
import { beginOutboundAttempt, markRemoteUnknown } from '../processors/outbound-operation';

function prismaWithOperation(operation: {
  id: string;
  state:
    | 'PREPARED'
    | 'DISPATCHING'
    | 'REMOTE_CONFIRMED'
    | 'REMOTE_UNKNOWN'
    | 'LOCAL_COMMITTED'
    | 'CONFIRMED_ABSENT'
    | 'MANUAL_REVIEW'
    | 'FAILED';
  attemptId: string | null;
  fence: number;
}) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return {
    outboundOperation: {
      findUnique: vi.fn(async () => operation),
      updateMany,
    },
  } as unknown as PrismaClientInstance;
}

describe('outbound operation fencing', () => {
  it('does not authorize dispatch without a durable operation id', async () => {
    const prisma = prismaWithOperation({
      id: 'op_missing',
      state: 'PREPARED',
      attemptId: null,
      fence: 0,
    });

    await expect(beginOutboundAttempt(prisma, undefined)).resolves.toEqual({
      action: 'NOOP',
      reason: 'operation_id_required',
    });
    expect(prisma.outboundOperation.findUnique).not.toHaveBeenCalled();
  });

  it('returns LOCAL_COMMIT for REMOTE_CONFIRMED redelivery', async () => {
    const prisma = prismaWithOperation({
      id: 'op_confirmed',
      state: 'REMOTE_CONFIRMED',
      attemptId: 'attempt_confirmed',
      fence: 4,
    });

    await expect(beginOutboundAttempt(prisma, 'op_confirmed')).resolves.toEqual({
      action: 'LOCAL_COMMIT',
      ownership: {
        operationId: 'op_confirmed',
        attemptId: 'attempt_confirmed',
        fence: 4,
      },
    });
  });

  it('marks abandoned DISPATCHING operations as REMOTE_UNKNOWN without dispatching again', async () => {
    const prisma = prismaWithOperation({
      id: 'op_1',
      state: 'DISPATCHING',
      attemptId: 'attempt_1',
      fence: 7,
    });

    const result = await beginOutboundAttempt(prisma, 'op_1');

    expect(result).toEqual({ action: 'NOOP', reason: 'REMOTE_UNKNOWN' });
    expect(prisma.outboundOperation.updateMany).toHaveBeenCalledWith({
      where: { id: 'op_1', state: 'DISPATCHING', attemptId: 'attempt_1', fence: 7 },
      data: expect.objectContaining({
        state: 'REMOTE_UNKNOWN',
        fence: { increment: 1 },
        requiresManualReview: true,
      }),
    });
  });

  it('uses exact attempt and fence when recording unknown remote outcome', async () => {
    const prisma = prismaWithOperation({
      id: 'op_2',
      state: 'PREPARED',
      attemptId: null,
      fence: 2,
    });

    await markRemoteUnknown(
      prisma,
      { operationId: 'op_2', attemptId: 'attempt_2', fence: 3 },
      { code: 'REMOTE_RESULT_UNKNOWN', message: 'response lost' },
    );

    expect(prisma.outboundOperation.updateMany).toHaveBeenCalledWith({
      where: { id: 'op_2', state: 'DISPATCHING', attemptId: 'attempt_2', fence: 3 },
      data: expect.objectContaining({
        state: 'REMOTE_UNKNOWN',
        requiresManualReview: true,
        lastErrorCode: 'REMOTE_RESULT_UNKNOWN',
      }),
    });
  });
});
