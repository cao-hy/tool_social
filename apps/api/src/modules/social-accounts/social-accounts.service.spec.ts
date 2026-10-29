import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken, Keyring } from '@socialhub/security';
import { SocialAccountsService } from './social-accounts.service';

const getJob = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ getJob, close })),
}));

describe('SocialAccountsService disconnect safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T41 marks DISCONNECTING before queue cleanup and still blocks dispatch if cleanup fails', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const access = encryptToken('access-token', keyring);
    const revokeToken = vi.fn();
    getJob.mockResolvedValueOnce({
      remove: vi.fn(async () => {
        throw new Error('redis unavailable');
      }),
    });
    const socialAccountUpdateMany = vi.fn(async () => ({ count: 1 }));
    const socialAccountUpdate = vi.fn(async () => ({}));
    const prisma = {
      socialAccount: {
        findFirst: vi.fn(async () => ({
          id: 'account_1',
          workspaceId: 'workspace_1',
          platform: 'YOUTUBE',
          token: { accessToken: access.ciphertext },
        })),
        updateMany: socialAccountUpdateMany,
        update: socialAccountUpdate,
      },
      platformPost: {
        findMany: vi.fn(async () => [{ id: 'platform_post_1' }]),
      },
      socialToken: {
        deleteMany: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (items) => Promise.all(items)),
    };
    const service = new SocialAccountsService(
      prisma as never,
      { getClient: vi.fn(() => ({})) } as never,
      {} as never,
      keyring,
      {
        withWorkspace: vi.fn(async (_workspaceId, fn) =>
          fn({ adapters: new Map([['YOUTUBE', { revokeToken }]]) }),
        ),
      } as never,
      { record: vi.fn() } as never,
    );

    await expect(
      service.disconnect('workspace_1', 'account_1', 'user_1', { requestId: 'req_1' }),
    ).resolves.toEqual({ disconnected: true });

    expect(socialAccountUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'account_1',
        workspaceId: 'workspace_1',
        deletedAt: null,
        status: { not: 'DISCONNECTED' },
      },
      data: {
        status: 'DISCONNECTING',
        disconnectGeneration: { increment: 1 },
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(socialAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'account_1' },
      data: { status: 'DISCONNECTED', deletedAt: expect.any(Date) },
    });
  });

  it('P1-F finalizes local disconnect when best-effort revoke route preparation fails', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const access = encryptToken('access-token', keyring);
    const socialAccountUpdate = vi.fn(async () => ({}));
    const prisma = {
      socialAccount: {
        findFirst: vi.fn(async () => ({
          id: 'account_1',
          workspaceId: 'workspace_1',
          platform: 'YOUTUBE',
          token: { accessToken: access.ciphertext },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: socialAccountUpdate,
      },
      platformPost: {
        findMany: vi.fn(async () => []),
      },
      socialToken: {
        deleteMany: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (items) => Promise.all(items)),
    };
    const service = new SocialAccountsService(
      prisma as never,
      { getClient: vi.fn(() => ({})) } as never,
      {} as never,
      keyring,
      {
        withWorkspace: vi.fn(async () => {
          throw new Error('proxy route unavailable');
        }),
      } as never,
      { record: vi.fn() } as never,
    );

    await expect(
      service.disconnect('workspace_1', 'account_1', 'user_1', { requestId: 'req_1' }),
    ).resolves.toEqual({ disconnected: true });

    expect(socialAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'account_1' },
      data: { status: 'DISCONNECTED', deletedAt: expect.any(Date) },
    });
  });

  it('syncMetaToken discovers and upserts Facebook Pages and Instagram Business accounts via workspace proxy', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const createdAccounts: Array<Record<string, unknown>> = [];
    const tx = {
      socialAccount: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const created = {
            id: `sa_${createdAccounts.length + 1}`,
            ...data,
            lastSyncedAt: null,
            lastErrorAt: null,
            lastErrorMessage: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          createdAccounts.push(created);
          return created;
        }),
      },
      socialToken: {
        upsert: vi.fn(async () => ({})),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const fbDiscover = vi.fn(async () => [
      {
        accessToken: 'page-token-1',
        scopes: ['pages_show_list', 'pages_manage_posts'],
        accountProfile: {
          externalAccountId: '1425162140686730',
          name: 'PreAureum Store',
        },
      },
      {
        accessToken: 'page-token-2',
        scopes: ['pages_show_list', 'pages_manage_posts'],
        accountProfile: {
          externalAccountId: '999999',
          name: 'Other Page',
        },
      },
    ]);
    const igDiscover = vi.fn(async () => [
      {
        accessToken: 'page-token-1',
        scopes: ['instagram_basic', 'instagram_content_publish'],
        accountProfile: {
          externalAccountId: '17841415051198020',
          name: 'PreAureum',
          username: 'preaureum_offical',
        },
      },
    ]);
    const service = new SocialAccountsService(
      prisma as never,
      { getClient: vi.fn(() => ({})) } as never,
      {} as never,
      keyring,
      {
        withWorkspace: vi.fn(async (_workspaceId, fn) =>
          fn({
            adapters: {
              get: (platform: string) =>
                platform === 'FACEBOOK'
                  ? { discoverAccountsFromToken: fbDiscover }
                  : { discoverAccountsFromToken: igDiscover },
            },
          }),
        ),
      } as never,
      { record: vi.fn() } as never,
    );

    const result = await service.syncMetaToken({
      workspaceId: 'workspace_1',
      actorUserId: 'user_1',
      accessToken: 'system-user-token',
      auditContext: { requestId: 'req_sync' },
    });

    expect(result.syncedCount).toBe(3);
    expect(result.items.map((item) => item.name)).toEqual([
      'PreAureum Store',
      'Other Page',
      'PreAureum',
    ]);
    expect(fbDiscover).toHaveBeenCalledWith('system-user-token');
    expect(igDiscover).toHaveBeenCalledWith('system-user-token');
  });

  it('autoGroupStores creates brand stores from Facebook Pages and pairs linked Instagram accounts by externalPageId', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const accounts = [
      {
        id: 'fb_preaureum',
        workspaceId: 'workspace_1',
        storeId: null as string | null,
        platform: 'FACEBOOK',
        externalAccountId: '1425162140686730',
        externalPageId: '1425162140686730',
        name: 'PreAureum Store',
        username: null,
        avatarUrl: null,
        status: 'CONNECTED',
      },
      {
        id: 'ig_preaureum',
        workspaceId: 'workspace_1',
        storeId: null as string | null,
        platform: 'INSTAGRAM',
        externalAccountId: '17841415051198020',
        externalPageId: '1425162140686730',
        name: 'PreAureum',
        username: 'preaureum_offical',
        avatarUrl: null,
        status: 'CONNECTED',
      },
    ];
    const stores: Array<{
      id: string;
      workspaceId: string;
      name: string;
      slug: string;
      description: string | null;
      color: string | null;
      avatarUrl: string | null;
      isDefault: boolean;
      createdAt: Date;
      updatedAt: Date;
    }> = [];

    const tx = {
      store: {
        findMany: vi.fn(async () => stores),
        findFirst: vi.fn(
          async ({ where }: { where: { slug?: string } }) =>
            stores.find((s) => s.slug === where.slug) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const created = {
            id: `store_${stores.length + 1}`,
            workspaceId: String(data.workspaceId),
            name: String(data.name),
            slug: String(data.slug),
            description: null,
            color: (data.color as string) ?? '#2563eb',
            avatarUrl: null,
            isDefault: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          stores.push(created);
          return created;
        }),
      },
      socialAccount: {
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { storeId: string } }) => {
            const found = accounts.find((a) => a.id === where.id);
            if (found) found.storeId = data.storeId;
            return found;
          },
        ),
      },
    };

    const prisma = {
      store: {
        findMany: vi.fn(async () =>
          stores.map((s) => ({
            ...s,
            socialAccounts: accounts.filter((a) => a.storeId === s.id),
          })),
        ),
      },
      socialAccount: {
        findMany: vi.fn(async () => accounts),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };

    const service = new SocialAccountsService(
      prisma as never,
      { getClient: vi.fn(() => ({})) } as never,
      {} as never,
      keyring,
      {} as never,
      { record: vi.fn() } as never,
    );

    const result = await service.autoGroupStores('workspace_1', 'user_1', {
      requestId: 'req_autogroup',
    });

    expect(result.storesCreated).toBe(1);
    expect(result.groupedAccounts).toBe(2);
    expect(stores[0]?.name).toBe('PreAureum');
    expect(stores[0]?.slug).toBe('preaureum');
    expect(accounts[0]?.storeId).toBe('store_1');
    expect(accounts[1]?.storeId).toBe('store_1');
  });
});
