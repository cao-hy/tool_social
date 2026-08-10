import { describe, expect, it, vi } from 'vitest';
import { Keyring } from '@socialhub/security';
import { SystemController } from './system.controller';

function request() {
  return {
    membership: { workspaceId: 'workspace_1', userId: 'user_1' },
    ip: '127.0.0.1',
    headers: {},
  } as never;
}

function response() {
  return { header: vi.fn() } as never;
}

function controllerWithPrisma(prisma: Record<string, unknown>) {
  return new SystemController(
    { PROXY_FINGERPRINT_SECRET: 'test-secret' } as never,
    prisma as never,
    Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1'),
    { record: vi.fn() } as never,
    { getClient: vi.fn(() => ({})) } as never,
  );
}

describe('SystemController proxy policy persistence', () => {
  it('T32 enable proxy persists Workspace.socialEgressPolicy = PROXY_REQUIRED in the same transaction', async () => {
    const workspaceUpdate = vi.fn();
    const createdSetting = {
      workspaceId: 'workspace_1',
      enabled: true,
      proxyUrl: null,
      proxyUrlMasked: null,
      countryLock: null,
      configVersion: 1,
    };
    const tx = {
      workspaceProxySetting: { create: vi.fn(async () => createdSetting) },
      workspace: { update: workspaceUpdate },
    };
    const prisma = {
      workspaceProxySetting: {
        findUnique: vi.fn(async () => null),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const controller = controllerWithPrisma(prisma);

    await controller.updateProxy({ enabled: true }, request(), response());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(workspaceUpdate).toHaveBeenCalledWith({
      where: { id: 'workspace_1' },
      data: { socialEgressPolicy: 'PROXY_REQUIRED' },
    });
  });

  it('explicit disable persists Workspace.socialEgressPolicy = DIRECT_ALLOWED in the same transaction', async () => {
    const workspaceUpdate = vi.fn();
    const existingSetting = {
      workspaceId: 'workspace_1',
      enabled: true,
      proxyUrl: null,
      proxyUrlMasked: null,
      countryLock: null,
      configVersion: 2,
    };
    const savedSetting = { ...existingSetting, enabled: false, configVersion: 3 };
    const tx = {
      workspaceProxySetting: { updateMany: vi.fn(async () => ({ count: 1 })) },
      workspace: { update: workspaceUpdate },
    };
    const prisma = {
      workspaceProxySetting: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(existingSetting)
          .mockResolvedValueOnce(existingSetting)
          .mockResolvedValueOnce(savedSetting),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const controller = controllerWithPrisma(prisma);

    await controller.updateProxy({ enabled: false, configVersion: 2 }, request(), response());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(workspaceUpdate).toHaveBeenCalledWith({
      where: { id: 'workspace_1' },
      data: { socialEgressPolicy: 'DIRECT_ALLOWED' },
    });
  });
});
