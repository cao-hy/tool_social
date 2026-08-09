import { describe, expect, it } from 'vitest';
import { canCreateNextGeneration } from '../outbox';

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
});
