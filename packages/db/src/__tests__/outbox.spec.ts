import { describe, expect, it, vi } from 'vitest';
import { canCreateNextGeneration, findOrCreateOutboundOperation } from '../outbox';

describe('outbound generation policy', () => {
  it.each([
    ['PREPARED', 'REUSE_ACTIVE'],
    ['DISPATCHING', 'REJECT'],
    ['REMOTE_UNKNOWN', 'REJECT'],
    ['REMOTE_CONFIRMED', 'REJECT'],
    ['LOCAL_COMMITTED', 'REJECT'],
    ['MANUAL_REVIEW', 'REJECT'],
    ['CONFIRMED_ABSENT', 'CREATE_NEXT'],
    ['FAILED', 'REJECT'],
  ] as const)('%s -> %s', (state, action) => {
    const decision = canCreateNextGeneration({
      id: 'op_1',
      operationGeneration: 3,
      state,
    });

    expect(decision.action).toBe(action);
    if (state === 'CONFIRMED_ABSENT') {
      expect(decision).toMatchObject({ nextGeneration: 4 });
    }
  });

  it('T10 concurrent explicit retries create at most one next generation by unique operation key', async () => {
    const operations = new Map<string, { id: string; operationGeneration: number }>();
    const tx = {
      outboundOperation: {
        upsert: vi.fn(async ({ where, create }) => {
          const key = JSON.stringify(
            where.operationType_resourceType_resourceId_operationGeneration,
          );
          const existing = operations.get(key);
          if (existing) return existing;
          await new Promise((resolve) => setTimeout(resolve, 1));
          const raced = operations.get(key);
          if (raced) return raced;
          const created = {
            id: `op_${operations.size + 1}`,
            operationGeneration: create.operationGeneration,
          };
          operations.set(key, created);
          return created;
        }),
      },
    };

    const [first, second] = await Promise.all([
      findOrCreateOutboundOperation(tx as never, {
        workspaceId: 'workspace_1',
        operationType: 'PUBLISH_POST',
        resourceType: 'PlatformPost',
        resourceId: 'platform_post_1',
        operationGeneration: 4,
      }),
      findOrCreateOutboundOperation(tx as never, {
        workspaceId: 'workspace_1',
        operationType: 'PUBLISH_POST',
        resourceType: 'PlatformPost',
        resourceId: 'platform_post_1',
        operationGeneration: 4,
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(operations).toHaveLength(1);
  });
});
